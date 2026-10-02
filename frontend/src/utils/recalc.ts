/**
 * 标准值调整 → 重算批次引擎
 *
 * 业务口径：
 * 1. 调整提交先生成「重算批次」，写新版本并更新点位最新值；
 * 2. 批次按读数分块重算，每块提交后推进检查点（processedCount）；
 * 3. 某一块写入失败：批次置 failed 并记录原因，重试从检查点继续，不重算已完成读数；
 * 4. 待处置 / 已处置的泄漏单退回「标准复核」并挡住复检；已复检合格的保留原结论；
 * 5. 新判异常的浓度读数由批次幂等派单（sourceReadingId 唯一），重复提交不会多出泄漏单；
 * 6. 幂等键相同的重复提交直接复用既有批次（失败则续跑、成功则原样返回）。
 */
import {
  db,
  dispatchLeakForReading,
  pickEffectiveVersion,
  judgeWithVersion,
  createId,
  ROW_REVISION,
  type PointRow,
  type ReadingRow,
  type RecalcBatchRow,
  type StandardVersionRow
} from '@/utils/db'
import type { RecalcBatchProgress } from '@/types/recalc'
import { REVIEWABLE_STATES, type LeakState } from '@/types/leak'

/** 单个点位的标准调整输入 */
export interface StandardAdjustInput {
  pointId: string
  effectiveDate: string
  standardMin: number
  standardMax: number
  isCritical: boolean
  note?: string
}

export interface SubmitAdjustmentsResult {
  batch: RecalcBatchRow
  /** 是否复用了同一幂等键的既有批次（重复提交不重建、不重复派单） */
  reused: boolean
  attempted: boolean
}

/** 每块处理的读数条数：块提交即落检查点，失败只回滚当前块 */
export const RECALC_CHUNK_SIZE = 5

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

declare global {
  interface Window {
    /** 自检开关：置 true 后，下一个批次处理到第二块时模拟一次写入失败 */
    __gbgaspressFailNextRecalcChunk?: boolean
  }
}

function normalizeMinMax(min: number, max: number): { min: number; max: number } {
  const lo = Math.min(Number(min), Number(max))
  const hi = Math.max(Number(min), Number(max))
  return { min: lo, max: hi > lo ? hi : lo + 0.001 }
}

/** 幂等键：点位 + 生效日期 + 标准值完全一致的提交视为重复提交 */
export function recalcIdempotencyKey(inputs: StandardAdjustInput[]): string {
  return inputs
    .map((input) => ({ ...input, ...normalizeMinMax(input.standardMin, input.standardMax) }))
    .sort((a, b) => a.pointId.localeCompare(b.pointId) || a.effectiveDate.localeCompare(b.effectiveDate))
    .map((item) => `${item.pointId}@${item.effectiveDate}[${item.min},${item.max}${item.isCritical ? '*' : ''}]`)
    .join('|')
}

export function isValidAdjustDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const parsed = Date.parse(`${date}T00:00:00`)
  return Number.isFinite(parsed)
}

/**
 * 提交一批标准调整：幂等建版本 + 冻结受影响读数 + 建批次并立即执行。
 * 任一步骤失败都会抛错，调用方提示；批次本身留在表内可重试。
 */
export async function submitStandardAdjustments(rawInputs: StandardAdjustInput[]): Promise<SubmitAdjustmentsResult> {
  const inputs = rawInputs
    .filter((input) => input && input.pointId)
    .map((input) => {
      const range = normalizeMinMax(input.standardMin, input.standardMax)
      return {
        pointId: input.pointId,
        effectiveDate: input.effectiveDate,
        standardMin: range.min,
        standardMax: range.max,
        isCritical: !!input.isCritical,
        note: (input.note ?? '').trim()
      }
    })
  if (inputs.length === 0) throw new Error('没有需要调整的点位标准值')
  for (const input of inputs) {
    if (!isValidAdjustDate(input.effectiveDate)) throw new Error(`生效日期格式不正确：${input.effectiveDate}`)
  }

  const idempotencyKey = recalcIdempotencyKey(inputs)
  const existing = await db.recalcBatches.where('idempotencyKey').equals(idempotencyKey).first()
  if (existing) {
    // 重复提交：失败/中断的批次续跑，成功的批次原样返回，绝不产生新版本与新泄漏单
    if (existing.status !== 'succeeded') {
      const resumed = await resumeRecalcBatch(existing.id)
      return { batch: resumed, reused: true, attempted: true }
    }
    return { batch: existing, reused: true, attempted: false }
  }

  const pointIds = Array.from(new Set(inputs.map((input) => input.pointId)))
  const points = await db.points.bulkGet(pointIds)
  const pointMap = new Map<string, PointRow>()
  points.forEach((point) => {
    if (point) pointMap.set(point.id, point)
  })
  if (pointMap.size !== pointIds.length) throw new Error('部分点位已不存在，无法调整标准值')

  const noteOf = new Map<string, string>()
  inputs.forEach((input) => {
    if (input.note) noteOf.set(`${input.pointId}:${input.effectiveDate}`, input.note)
  })

  const batchId = createId('rc')
  const now = Date.now()
  const effectiveDate = inputs
    .map((input) => input.effectiveDate)
    .sort((a, b) => a.localeCompare(b))[0]

  let batch: RecalcBatchRow
  await db.transaction(
    'rw',
    [db.points, db.standardVersions, db.readings, db.recalcBatches],
    async () => {
      const affectedReadingIds = new Set<string>()

      // 1) 按点位写新版本（同点位同日同主键，重复命中不会多出版本）
      for (const pointId of pointIds) {
        const point = pointMap.get(pointId)!
        const pointInputs = inputs
          .filter((input) => input.pointId === pointId)
          .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
        const existed = await db.standardVersions.where('pointId').equals(pointId).toArray()
        existed.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.versionNo - b.versionNo)
        let nextVersionNo = existed.reduce((max, item) => Math.max(max, item.versionNo), 0)
        const dateToVersion = new Map(existed.map((item) => [item.effectiveDate, item]))

        for (const input of pointInputs) {
          const sameDate = dateToVersion.get(input.effectiveDate)
          if (sameDate) {
            sameDate.standardMin = input.standardMin
            sameDate.standardMax = input.standardMax
            sameDate.isCritical = input.isCritical
            sameDate.unit = point.unit
            sameDate.source = 'adjustment'
            sameDate.recalcBatchId = batchId
            const note = noteOf.get(`${input.pointId}:${input.effectiveDate}`)
            if (note) sameDate.note = note
            sameDate.updatedAt = now
            await db.standardVersions.put(sameDate)
          } else {
            nextVersionNo += 1
            const version: StandardVersionRow = {
              id: `${pointId}:${input.effectiveDate}`,
              versionNo: nextVersionNo,
              pointId,
              deviceId: point.deviceId,
              stationId: point.stationId,
              effectiveDate: input.effectiveDate,
              standardMin: input.standardMin,
              standardMax: input.standardMax,
              unit: point.unit,
              isCritical: input.isCritical,
              source: 'adjustment',
              recalcBatchId: batchId,
              note: noteOf.get(`${pointId}:${input.effectiveDate}`) ?? '班组交接调整标准值',
              createdAt: now,
              updatedAt: now,
              revision: ROW_REVISION
            }
            await db.standardVersions.put(version)
            dateToVersion.set(input.effectiveDate, version)
          }
        }

        // 2) 点位冗余列更新为「最新生效版本」（新读数一律取最新值）
        const allVersions = await db.standardVersions.where('pointId').equals(pointId).toArray()
        allVersions.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.versionNo - b.versionNo)
        const latest = allVersions[allVersions.length - 1]
        const inputEarliest = pointInputs[0].effectiveDate
        await db.points.update(pointId, {
          standardMin: latest.standardMin,
          standardMax: latest.standardMax,
          isCritical: latest.isCritical,
          updatedAt: now
        })

        // 3) 冻结受影响读数：巡检日期 ≥ 本次最早生效日期；无日期的草稿读数按最新版本重算
        const rows = await db.readings.where('pointId').equals(pointId).toArray()
        rows.forEach((row) => {
          const date = row.judgedDate || ''
          if (date === '' || date >= inputEarliest) affectedReadingIds.add(row.id)
        })
      }

      // 4) 建重算批次（running，检查点为 0）
      const pointChanges = pointIds.map((pointId) => {
        const point = pointMap.get(pointId)!
        const latestInput = inputs
          .filter((input) => input.pointId === pointId)
          .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0]
        return {
          pointId,
          deviceId: point.deviceId,
          stationId: point.stationId,
          unit: point.unit,
          fromMin: point.standardMin,
          fromMax: point.standardMax,
          fromCritical: point.isCritical,
          toMin: latestInput.standardMin,
          toMax: latestInput.standardMax,
          toCritical: latestInput.isCritical
        }
      })

      batch = {
        id: batchId,
        idempotencyKey,
        status: 'running',
        effectiveDate,
        pointChanges,
        readingIds: Array.from(affectedReadingIds),
        processedCount: 0,
        newAbnormalReadingIds: [],
        reviewedLeakIds: [],
        dispatchedReadingIds: [],
        note: inputs.map((input) => input.note).filter(Boolean).join('；') || '班组交接标准值调整',
        failReason: '',
        readFailureAt: 0,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      await db.recalcBatches.put(batch)
    }
  )

  // 5) 分块执行；失败由批次保留现场，等待重试
  const completed = await resumeRecalcBatch(batch!.id)
  return { batch: completed, reused: false, attempted: true }
}

interface RecalcContext {
  versionsByPoint: Map<string, StandardVersionRow[]>
  patrolDateById: Map<string, string>
}

async function loadRecalcContext(readingIds: string[]): Promise<RecalcContext> {
  const [allVersions, readings, patrols] = await Promise.all([
    db.standardVersions.toArray(),
    db.readings.bulkGet(readingIds),
    db.patrols.toArray()
  ])
  const versionsByPoint = new Map<string, StandardVersionRow[]>()
  allVersions.forEach((version) => {
    const list = versionsByPoint.get(version.pointId) ?? []
    list.push(version)
    versionsByPoint.set(version.pointId, list)
  })
  versionsByPoint.forEach((list) =>
    list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.versionNo - b.versionNo)
  )
  const patrolMap = new Map(patrols.map((patrol) => [patrol.id, patrol]))
  const patrolDateById = new Map<string, string>()
  readings.forEach((reading) => {
    if (!reading) return
    const patrol = patrolMap.get(reading.patrolId)
    patrolDateById.set(reading.id, patrol ? patrol.patrolDate || patrol.planDate || '' : reading.judgedDate || '')
  })
  return { versionsByPoint, patrolDateById }
}

/**
 * 续算批次：从 processedCount 检查点开始，每块一个事务。
 * - 成功：推进检查点、累计新异常 / 复核单 / 派单集合
 * - 失败：批次置 failed 并落 failReason，已完成的块不回滚，下次从断点继续
 */
export async function resumeRecalcBatch(batchId: string): Promise<RecalcBatchRow> {
  const batch = await db.recalcBatches.get(batchId)
  if (!batch) throw new Error('重算批次不存在')
  if (batch.status === 'succeeded') return batch

  const context = await loadRecalcContext(batch.readingIds)
  const points = await db.points.bulkGet(batch.pointChanges.map((change) => change.pointId))
  const pointById = new Map(points.filter((p): p is PointRow => !!p).map((point) => [point.id, point]))

  try {
    while (batch.processedCount < batch.readingIds.length) {
      const start = batch.processedCount
      if (typeof window !== 'undefined' && window.__gbgaspressFailNextRecalcChunk && start >= RECALC_CHUNK_SIZE) {
        // 自检：模拟一次写入失败（当前块整体回滚，检查点停在上一块）
        window.__gbgaspressFailNextRecalcChunk = false
        throw new Error('模拟写入失败：本地存储暂时不可用')
      }
      const chunkIds = batch.readingIds.slice(start, start + RECALC_CHUNK_SIZE)

      await db.transaction('rw', [db.readings, db.leaks, db.recalcBatches], async () => {
        const newAbnormal = new Set(batch.newAbnormalReadingIds)
        const dispatched = new Set(batch.dispatchedReadingIds)
        const reviewed = new Set(batch.reviewedLeakIds)

        // 5.1 逐读数按巡检日期取生效版本重算，落当时标准快照
        for (const readingId of chunkIds) {
          const reading = await db.readings.get(readingId)
          if (!reading) continue
          const date = context.patrolDateById.get(reading.id) ?? reading.judgedDate ?? ''
          const version = pickEffectiveVersion(context.versionsByPoint.get(reading.pointId), date)
          const wasAbnormal = reading.isAbnormal
          const judgement = judgeWithVersion(reading.value, version, pointById.get(reading.pointId))
          const next: ReadingRow = {
            ...reading,
            isAbnormal: judgement.isAbnormal,
            deviationPct: judgement.deviationPct,
            standardVersionId: judgement.standardVersionId,
            judgedMin: judgement.judgedMin,
            judgedMax: judgement.judgedMax,
            judgedCritical: judgement.judgedCritical,
            judgedDate: date,
            recalcBatchId: batch.id,
            updatedAt: Date.now()
          }
          await db.readings.put(next)
          if (!wasAbnormal && judgement.isAbnormal) newAbnormal.add(reading.id)

          // 5.2 新判异常的浓度读数：幂等派单（同一读数全局唯一泄漏单）
          const point = pointById.get(reading.pointId)
          if (judgement.isAbnormal && point && point.unit === 'ppm' && !dispatched.has(reading.id)) {
            const result = await dispatchLeakForReading({
              reading: next,
              point,
              foundTime: date || new Date().toISOString().slice(0, 10),
              measure: `标准值调整重算后判定异常：${point.name} 实测 ${reading.value} ${point.unit}，按 ${batch.effectiveDate} 生效标准复核`,
              recalcBatchId: batch.id
            })
            dispatched.add(reading.id)
            if (!result.duplicated) {
              // 新派发的单子直接进入标准复核，等待人工按新标准确认
              await db.leaks.update(result.leak.id, { state: '标准复核', stateBeforeReview: '待处置', reviewReason: batch.note })
              reviewed.add(result.leak.id)
            }
          }
        }

        // 5.3 待处置 / 已处置的存量泄漏单退回标准复核（已复检合格的不动）
        //     仅在首块执行一次；状态与集合双重幂等，续跑/重复提交不会重复处理
        if (start === 0) {
          const deviceIds = Array.from(new Set(batch.pointChanges.map((change) => change.deviceId)))
          const leaks = await db.leaks.where('deviceId').anyOf(deviceIds).toArray()
          for (const leak of leaks) {
            if (reviewed.has(leak.id)) continue
            if (!REVIEWABLE_STATES.includes(leak.state as LeakState)) continue
            await db.leaks.update(leak.id, {
              state: '标准复核',
              stateBeforeReview: leak.state,
              reviewReason: `${batch.note}（${batch.effectiveDate} 起新标准生效，退回标准复核）`,
              updatedAt: Date.now()
            })
            reviewed.add(leak.id)
          }
        }

        // 5.4 推进检查点（与本块写在同一事务，要么整块成功，要么整块重来）
        const processedCount = start + chunkIds.length
        await db.recalcBatches.update(batch.id, {
          status: processedCount >= batch.readingIds.length ? 'succeeded' : 'running',
          processedCount,
          newAbnormalReadingIds: Array.from(newAbnormal),
          dispatchedReadingIds: Array.from(dispatched),
          reviewedLeakIds: Array.from(reviewed),
          failReason: '',
          readFailureAt: 0,
          updatedAt: Date.now()
        })
        batch.processedCount = processedCount
        batch.status = processedCount >= batch.readingIds.length ? 'succeeded' : 'running'
        batch.newAbnormalReadingIds = Array.from(newAbnormal)
        batch.dispatchedReadingIds = Array.from(dispatched)
        batch.reviewedLeakIds = Array.from(reviewed)
      })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '重算写入失败'
    await db.recalcBatches.update(batchId, {
      status: 'failed',
      failReason: reason,
      readFailureAt: Date.now(),
      updatedAt: Date.now()
    })
    const failed = await db.recalcBatches.get(batchId)
    throw Object.assign(new Error(reason), { batch: failed })
  }

  const finished = await db.recalcBatches.get(batchId)
  if (!finished || finished.status !== 'succeeded') {
    throw new Error(finished ? finished.failReason || '重算未完成' : '重算批次不存在')
  }
  return finished
}

/** 标准复核结论：确认新标准下结论成立 → 恢复到复核前状态；确认不成立 → 关闭原单 */
export async function resolveLeakReview(
  leakId: string,
  decision: 'confirm' | 'invalidate',
  patch: { measure?: string; handler?: string } = {}
): Promise<void> {
  const leak = await db.leaks.get(leakId)
  if (!leak || leak.state !== '标准复核') return
  const now = Date.now()
  if (decision === 'invalidate') {
    await db.leaks.update(leakId, {
      state: '已复检',
      retestValuePpm: leak.retestValuePpm || 0,
      stateBeforeReview: '',
      reviewReason: `复核不成立，按新标准关闭原单${leak.reviewReason ? `（${leak.reviewReason}）` : ''}`,
      measure: patch.measure !== undefined ? patch.measure.trim() : leak.measure,
      handler: (patch.handler !== undefined ? patch.handler.trim() : '') || leak.handler || '标准复核',
      updatedAt: now
    })
    return
  }
  const restore: LeakState = leak.stateBeforeReview === '已处置' ? '已处置' : '待处置'
  await db.leaks.update(leakId, {
    state: restore,
    stateBeforeReview: '',
    reviewReason: `复核确认，恢复为「${restore}」`,
    measure: patch.measure !== undefined ? patch.measure.trim() : leak.measure,
    handler: (patch.handler !== undefined ? patch.handler.trim() : '') || leak.handler,
    updatedAt: now
  })
}

export function recalcProgressOf(batch: RecalcBatchRow): RecalcBatchProgress {
  const total = batch.readingIds.length
  const done = Math.min(batch.processedCount, total)
  return { batch, total, done, percent: total === 0 ? 100 : Math.round((done / total) * 100) }
}
