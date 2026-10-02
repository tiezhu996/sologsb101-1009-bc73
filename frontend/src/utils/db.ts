/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 标准值版本化（standardVersions）：调整不覆盖，按生效日期保留版本
 * - 标准调整重算批次（recalcBatches）：分块写入、失败重试、进度恢复
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { RecalcBatch, RecalcItem, StandardVersion } from '@/types/standard'
import { deviationPctOf, judgeReading } from '@/utils/range'
import { resolveStandardOn } from '@/utils/standardVersion'
import { LEAK_REVIEWABLE_STATES, manualDispatchKey, readingDispatchKey } from '@/types/leak'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 4

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs',
  /** 重算故障注入（仅开发自测用）：'once:<readingId>' | 'all' */
  recalcFailInjection: 'gbgaspress:recalc-fail'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  standardVersions: StandardVersion[]
  recalcBatches: RecalcBatch[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 4

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type StandardVersionRow = StandardVersion & Revisioned
export type RecalcBatchRow = RecalcBatch & Revisioned

const ALL_TABLES = [
  'stations',
  'devices',
  'points',
  'patrols',
  'readings',
  'leaks',
  'standardVersions',
  'recalcBatches'
] as const

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  standardVersions!: Table<StandardVersionRow, string>
  recalcBatches!: Table<RecalcBatchRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2).stores({
      stations: 'id, name, grade, updatedAt',
      devices: 'id, stationId, type, state, updatedAt',
      points: 'id, deviceId, stationId, name, isCritical, updatedAt',
      patrols: 'id, stationId, planDate, state, updatedAt',
      readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
      leaks: 'id, deviceId, stationId, state, handler, updatedAt'
    })

    // v3：标准值版本化 + 调整重算批次；读数补判定快照列；泄漏单补派单幂等键与复核字段
    this.version(3)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, standardVersionId, updatedAt',
        leaks: 'id, deviceId, stationId, state, dispatchKey, handler, updatedAt',
        standardVersions: 'id, pointId, stationId, effectiveDate, versionNo, updatedAt',
        recalcBatches: 'id, status, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ALL_TABLES) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        /* ---------- 旧数据首次打开：把现行标准值升级为「初始版本」 ---------- */
        const legacyPoints = (await tx.table('points').toArray()) as Array<{
          id: string
          stationId: string
          standardMin: number
          standardMax: number
          isCritical: boolean
          unit: string
          createdAt?: number
        }>
        const legacyPatrols = (await tx.table('patrols').toArray()) as Array<{
          id: string
          planDate: string
          patrolDate: string
        }>
        const legacyReadingsForDate = (await tx.table('readings').toArray()) as Array<{
          pointId: string
          patrolId: string
        }>
        const patrolDateOf = new Map(
          legacyPatrols.map((patrol) => [patrol.id, patrol.patrolDate || patrol.planDate])
        )

        const initialVersions: StandardVersionRow[] = legacyPoints.map((point) => {
          // 初始版本生效日不晚于该点位最早一次巡检日期，保证历史读数都能命中初始版本
          const dates = legacyReadingsForDate
            .filter((reading) => reading.pointId === point.id)
            .map((reading) => patrolDateOf.get(reading.patrolId) ?? '')
            .filter((date) => Boolean(date))
            .sort()
          const effectiveDate = dates[0] ?? '2000-01-01'
          const now = Date.now()
          return {
            id: `sv_init_${point.id}`,
            pointId: point.id,
            stationId: point.stationId ?? '',
            versionNo: 1,
            standardMin: point.standardMin,
            standardMax: point.standardMax,
            isCritical: Boolean(point.isCritical),
            unit: point.unit,
            effectiveDate,
            reason: '旧数据升级：现行标准值固化为初始版本',
            source: '初始版本',
            createdAt: point.createdAt ?? now,
            updatedAt: point.createdAt ?? now,
            revision: ROW_REVISION
          }
        })
        if (initialVersions.length > 0) {
          await tx.table('standardVersions').bulkPut(initialVersions)
        }

        /* ---------- 读数补判定快照：保留当时结论，同时固化判定口径 ---------- */
        const versionsByPoint = new Map<string, StandardVersionRow[]>()
        initialVersions.forEach((version) => {
          const list = versionsByPoint.get(version.pointId) ?? []
          list.push(version)
          versionsByPoint.set(version.pointId, list)
        })
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const date = patrolDateOf.get(String(reading.patrolId)) ?? ''
            const resolved = resolveStandardOn(versionsByPoint.get(String(reading.pointId)) ?? [], date)
            if (resolved && resolved.version) {
              reading.standardVersionId = resolved.version.id
              reading.judgeStandardMin = resolved.standardMin
              reading.judgeStandardMax = resolved.standardMax
              reading.judgeIsCritical = resolved.isCritical
              reading.judgeEffectiveDate = resolved.effectiveDate
              // 历史结论（isAbnormal / deviationPct）保持 v2 重算后的值不变，确保各页仍能追溯当时判定
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })

        /* ---------- 泄漏单补派单幂等键、来源读数与复核字段 ---------- */
        const ppmPointIds = new Set(
          legacyPoints.filter((point) => point.unit === 'ppm').map((point) => point.id)
        )
        const allReadings = (await tx.table('readings').toArray()) as Array<{
          id: string
          pointId: string
          patrolId: string
          value: number
        }>
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
            const match = allReadings.find((reading) => {
              if (!ppmPointIds.has(reading.pointId)) return false
              if (Number(reading.value) !== Number(leak.concentrationPpm)) return false
              return patrolDateOf.get(reading.patrolId) === String(leak.foundTime)
            })
            leak.sourceReadingId = match ? match.id : ''
            leak.dispatchKey = match ? readingDispatchKey(match.id) : manualDispatchKey(String(leak.deviceId), String(leak.foundTime))
            leak.reviewFromState = ''
            leak.reviewReason = ''
          })
      })

    // v4：派单幂等键升级为唯一索引，并发重复提交由数据库约束原子兜底
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, standardVersionId, updatedAt',
        leaks: 'id, deviceId, stationId, state, &dispatchKey, handler, updatedAt',
        standardVersions: 'id, pointId, stationId, effectiveDate, versionNo, updatedAt',
        recalcBatches: 'id, status, updatedAt'
      })
      .upgrade(async (tx) => {
        // 历史数据若存在重复 dispatchKey，保留最早一张，其余改为带 id 后缀的唯一键
        const seen = new Set<string>()
        const dups: Array<{ id: string; key: string }> = []
        const rows = (await tx.table('leaks').toArray()) as Array<{ id: string; dispatchKey?: string }>
        rows.forEach((row) => {
          const key = typeof row.dispatchKey === 'string' && row.dispatchKey ? row.dispatchKey : `legacy:${row.id}`
          if (seen.has(key)) dups.push({ id: row.id, key })
          else seen.add(key)
        })
        for (const dup of dups) {
          await tx.table('leaks').update(dup.id, { dispatchKey: `${dup.key}#${dup.id}` })
        }
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 标准值版本 ============================ */

export async function listVersionsOfPoint(pointId: string): Promise<StandardVersionRow[]> {
  return db.standardVersions.where('pointId').equals(pointId).toArray()
}

/** 为新建点位写入初始版本 */
export async function createInitialStandardVersion(point: {
  id: string
  stationId: string
  standardMin: number
  standardMax: number
  isCritical: boolean
  unit: string
  effectiveDate?: string
  reason?: string
  createdAt?: number
}): Promise<StandardVersionRow> {
  const now = point.createdAt ?? Date.now()
  const row: StandardVersionRow = {
    id: createId('sv'),
    pointId: point.id,
    stationId: point.stationId,
    versionNo: 1,
    standardMin: point.standardMin,
    standardMax: point.standardMax,
    isCritical: point.isCritical,
    unit: point.unit,
    effectiveDate: point.effectiveDate ?? todayText(),
    reason: point.reason ?? '点位创建初始标准值',
    source: '初始版本',
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.standardVersions.put(row)
  return row
}

export function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface StandardAdjustmentItem {
  pointId: string
  standardMin: number
  standardMax: number
  isCritical: boolean
}

export interface StandardAdjustmentOptions {
  /** 班组交接生效日期 YYYY-MM-DD，默认今天 */
  effectiveDate?: string
  reason?: string
}

/**
 * 班组交接调整标准值：
 * 1) 每个点位生成一条带生效日期的新版本（与最新版本完全一致则跳过，重复提交不产生多余版本）
 * 2) 同步点位表上的当前标准（新读数用最新值）
 * 3) 生成重算批次（历史读数按巡检日期取版本重判）
 * 返回批次 id；无任何变化时返回 null。
 */
export async function createStandardAdjustment(
  items: StandardAdjustmentItem[],
  options: StandardAdjustmentOptions = {}
): Promise<{ batchId: string; changedPointIds: string[] } | null> {
  if (items.length === 0) return null
  const effectiveDate = options.effectiveDate || todayText()
  const reason = options.reason?.trim() || `班组交接标准值调整（${effectiveDate} 生效）`
  const now = Date.now()

  return db.transaction(
    'rw',
    [db.points, db.standardVersions, db.readings, db.leaks, db.recalcBatches],
    async () => {
      const changedPointIds: string[] = []
      const batchItems: RecalcItem[] = []

      for (const item of items) {
        const point = await db.points.get(item.pointId)
        if (!point) continue
        const min = Math.min(item.standardMin, item.standardMax)
        const max = Math.max(item.standardMin, item.standardMax)
        const standardMin = min
        const standardMax = max > min ? max : min + 0.001
        const versions = await listVersionsOfPoint(point.id)
        const latestVersion =
          versions.length === 0
            ? null
            : [...versions].sort((a, b) =>
                a.effectiveDate === b.effectiveDate ? a.versionNo - b.versionNo : a.effectiveDate.localeCompare(b.effectiveDate)
              )[versions.length - 1]

        // 幂等：与最新版本一致（重复提交）则跳过
        if (
          latestVersion &&
          latestVersion.standardMin === standardMin &&
          latestVersion.standardMax === standardMax &&
          latestVersion.isCritical === item.isCritical
        ) {
          continue
        }

        const versionRow: StandardVersionRow = {
          id: createId('sv'),
          pointId: point.id,
          stationId: point.stationId,
          versionNo: latestVersion ? latestVersion.versionNo + 1 : 1,
          standardMin,
          standardMax,
          isCritical: item.isCritical,
          unit: point.unit,
          effectiveDate,
          reason,
          source: '班组调整',
          createdAt: now,
          updatedAt: now,
          revision: ROW_REVISION
        }
        await db.standardVersions.put(versionRow)
        await db.points.update(point.id, {
          standardMin,
          standardMax,
          isCritical: item.isCritical,
          updatedAt: now
        })
        changedPointIds.push(point.id)

        const readings = await db.readings.where('pointId').equals(point.id).toArray()
        readings.forEach((reading) => {
          batchItems.push({ readingId: reading.id, status: '待处理', error: '', triedAt: 0 })
        })
      }

      if (changedPointIds.length === 0) return null

      const batch: RecalcBatchRow = {
        id: createId('rb'),
        status: '待执行',
        reason,
        effectiveDate,
        total: batchItems.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        reviewDone: false,
        items: batchItems,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      // 扩展字段：本次调整涉及的点位（泄漏单兜底匹配用）
      ;(batch as RecalcBatch & { pointIds?: string[] }).pointIds = changedPointIds
      await db.recalcBatches.put(batch)
      return { batchId: batch.id, changedPointIds }
    }
  )
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.4, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 点位初始版本：[pointId, 生效日期, min, max, isCritical] */
const SEED_INITIAL_VERSIONS: Array<[string, string, number, number, boolean]> = SEED_POINTS.map((point) => [
  point.id,
  '2024-01-01',
  // 当前最新值之外，pt-1 另有一条班组调整版本，初始版本保留调整前口径
  point.id === 'pt-1' ? 0.35 : point.standardMin,
  point.id === 'pt-1' ? 0.45 : point.standardMax,
  point.isCritical
])

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, '进口压力按旧标准在区间内'],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', dispatchKey: 'r:rd-3', sourceReadingId: 'rd-3', reviewFromState: '', reviewReason: '', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', dispatchKey: 'r:rd-7', sourceReadingId: 'rd-7', reviewFromState: '', reviewReason: '', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', dispatchKey: 'r:rd-11', sourceReadingId: 'rd-11', reviewFromState: '', reviewReason: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

function buildSeedStandardVersions(): StandardVersionRow[] {
  const rows: StandardVersionRow[] = SEED_INITIAL_VERSIONS.map(([pointId, effectiveDate, min, max, isCritical], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)!
    return {
      id: `sv_${pointId}_1`,
      pointId,
      stationId: point.stationId,
      versionNo: 1,
      standardMin: min,
      standardMax: max,
      isCritical,
      unit: point.unit,
      effectiveDate,
      reason: '点位创建初始标准值',
      source: '初始版本',
      createdAt: stamp(-260 + index),
      updatedAt: stamp(-260 + index),
      revision: ROW_REVISION
    }
  })
  // pt-1 班组交接调整：2024-06-10 起进口压力下限提高到 0.40（演示历史读数按巡检日期取版本）
  rows.push({
    id: 'sv_pt-1_2',
    pointId: 'pt-1',
    stationId: 'st-1',
    versionNo: 2,
    standardMin: 0.4,
    standardMax: 0.45,
    isCritical: true,
    unit: 'MPa',
    effectiveDate: '2024-06-10',
    reason: '班组交接：上游管网提压，进口压力下限提高',
    source: '班组调整',
    createdAt: stamp(-10),
    updatedAt: stamp(-10),
    revision: ROW_REVISION
  })
  return rows
}

/** 由原始行派生偏差率与异常标记（历史读数按巡检日期取当时版本） */
function buildSeedReadings(versions: StandardVersionRow[]): ReadingRow[] {
  const patrolDateOf = new Map(SEED_PATROLS.map((patrol) => [patrol.id, patrol.patrolDate || patrol.planDate]))
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const versionsOfPoint = versions.filter((version) => version.pointId === pointId)
    const resolved = point ? resolveStandardOn(versionsOfPoint, patrolDateOf.get(patrolId) ?? '') : null
    const judgement = resolved
      ? judgeReading(value, resolved.standardMin, resolved.standardMax, resolved.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      standardVersionId: resolved?.version?.id ?? '',
      judgeStandardMin: resolved?.standardMin ?? 0,
      judgeStandardMax: resolved?.standardMax ?? 1,
      judgeIsCritical: resolved?.isCritical ?? false,
      judgeEffectiveDate: resolved?.effectiveDate ?? '',
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await db.stations.bulkPut(SEED_STATIONS)
      await db.devices.bulkPut(SEED_DEVICES)
      await db.points.bulkPut(SEED_POINTS)
      await db.patrols.bulkPut(SEED_PATROLS)
      const versions = buildSeedStandardVersions()
      await db.standardVersions.bulkPut(versions)
      await db.readings.bulkPut(buildSeedReadings(versions))
      await db.leaks.bulkPut(SEED_LEAKS)
    }
  )
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      const devices = await db.devices.where('stationId').equals(stationId).toArray()
      await deleteDevicesInternal(devices.map((device) => device.id))
      if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
      await db.patrols.where('stationId').equals(stationId).delete()
      await db.standardVersions.where('stationId').equals(stationId).delete()
      await db.stations.delete(stationId)
    }
  )
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await deleteDevicesInternal([deviceId])
      await db.devices.delete(deviceId)
    }
  )
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await db.readings.where('pointId').equals(pointId).delete()
      await db.standardVersions.where('pointId').equals(pointId).delete()
      await db.points.delete(pointId)
    }
  )
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await db.readings.where('patrolId').equals(patrolId).delete()
      await db.patrols.delete(patrolId)
    }
  )
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  const points = await db.points.where('deviceId').anyOf(deviceIds).toArray()
  const pointIds = points.map((point) => point.id)
  if (pointIds.length > 0) {
    await db.readings.where('pointId').anyOf(pointIds).delete()
    await db.standardVersions.where('pointId').anyOf(pointIds).delete()
  }
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入（版本判定 + 快照） ============================ */

export interface PutReadingInput {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}

/**
 * 写入读数：按巡检日期取当时生效的标准版本判定，落判定快照。
 * 巡检尚未填写实际日期时按计划日期判定；新读数因此自动使用最新版本。
 */
export async function putReading(row: PutReadingInput): Promise<ReadingRow> {
  const [point, patrol] = await Promise.all([db.points.get(row.pointId), db.patrols.get(row.patrolId)])
  // 新读数（巡检尚未填写实际日期）一律用最新版本；已完成巡检的补录/修正按实际巡检日期取当时版本
  const date = patrol?.patrolDate || todayText()
  const versions = await listVersionsOfPoint(row.pointId)
  let resolved = resolveStandardOn(versions, date)
  if (!resolved && point) {
    resolved = {
      version: null,
      standardMin: point.standardMin,
      standardMax: point.standardMax,
      isCritical: point.isCritical,
      unit: point.unit,
      effectiveDate: ''
    }
  }
  const judgement = resolved
    ? judgeReading(row.value, resolved.standardMin, resolved.standardMax, resolved.isCritical)
    : { isAbnormal: false, deviationPct: 0 }
  const existing = await db.readings.get(row.id)
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    standardVersionId: resolved?.version?.id ?? existing?.standardVersionId ?? '',
    judgeStandardMin: resolved?.standardMin ?? existing?.judgeStandardMin ?? 0,
    judgeStandardMax: resolved?.standardMax ?? existing?.judgeStandardMax ?? 1,
    judgeIsCritical: resolved?.isCritical ?? existing?.judgeIsCritical ?? false,
    judgeEffectiveDate: resolved?.effectiveDate ?? existing?.judgeEffectiveDate ?? '',
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/* ====================== 标准调整重算批次（分块 / 重试 / 恢复） ====================== */

const RECALC_CHUNK_SIZE = 25
/** 单块写入失败后的块内重试次数（应对偶发 IndexedDB 写入失败） */
const RECALC_CHUNK_RETRY = 2
const RECALC_RETRY_DELAY_MS = 80

const runningBatchIds = new Set<string>()

/**
 * 开发自测故障注入：
 * - localStorage['gbgaspress:recalc-fail'] = 'once:<readingId>'：指定读数首次处理失败（块重试可恢复，验证重试）
 * - 'all'：始终失败（需手动点「重试」，验证进度恢复）
 */
function consumeFailInjection(readingId: string, triedAt: number): string | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LS_KEYS.recalcFailInjection)
  } catch {
    raw = null
  }
  if (!raw) return null
  if (raw === 'all') return '故障注入：模拟写入失败'
  if (raw === `once:${readingId}`) {
    if (triedAt === 0) {
      try {
        localStorage.removeItem(LS_KEYS.recalcFailInjection)
      } catch {
        /* ignore */
      }
      return '故障注入：首次写入失败（应自动重试恢复）'
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 重算单条读数：按巡检日期取当时版本，刷新判定快照 */
async function recomputeReading(readingId: string, firstTry: boolean): Promise<void> {
  const reading = await db.readings.get(readingId)
  if (!reading) return
  const injected = consumeFailInjection(readingId, firstTry ? 0 : 1)
  if (injected) throw new Error(injected)
  const patrol = await db.patrols.get(reading.patrolId)
  const date = patrol ? patrol.patrolDate || patrol.planDate : ''
  const versions = await listVersionsOfPoint(reading.pointId)
  const resolved = resolveStandardOn(versions, date)
  if (!resolved || !resolved.version) return
  const judgement = judgeReading(reading.value, resolved.standardMin, resolved.standardMax, resolved.isCritical)
  await db.readings.update(readingId, {
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    standardVersionId: resolved.version.id,
    judgeStandardMin: resolved.standardMin,
    judgeStandardMax: resolved.standardMax,
    judgeIsCritical: resolved.isCritical,
    judgeEffectiveDate: resolved.effectiveDate,
    updatedAt: Date.now()
  })
}

/**
 * 全部读数重算成功后执行一次：待处置 / 已处置的泄漏单退回标准复核并挡住复检；
 * 已复检（含合格与不合格结论）的处置单保留原结论。reviewDone 保证只执行一次。
 */
async function applyLeakReview(batch: RecalcBatchRow): Promise<void> {
  if (batch.reviewDone) return
  const recalculatedIds = new Set(batch.items.map((item) => item.readingId))
  const pointIds: string[] = (batch as RecalcBatch & { pointIds?: string[] }).pointIds ?? []
  const pointById = new Map((await db.points.toArray()).map((point) => [point.id, point]))
  const readingById = new Map((await db.readings.toArray()).map((reading) => [reading.id, reading]))

  const affectedDeviceIds = new Set<string>()
  pointIds.forEach((pointId) => {
    const point = pointById.get(pointId)
    if (point && point.unit === 'ppm') affectedDeviceIds.add(point.deviceId)
  })
  recalculatedIds.forEach((readingId) => {
    const reading = readingById.get(readingId)
    if (!reading) return
    const point = pointById.get(reading.pointId)
    if (point && point.unit === 'ppm') affectedDeviceIds.add(point.deviceId)
  })

  const openLeaks = (await db.leaks.toArray()).filter(
    (leak) => LEAK_REVIEWABLE_STATES.includes(leak.state) && affectedDeviceIds.has(leak.deviceId)
  )
  for (const leak of openLeaks) {
    // 已不在异常清单（重判为正常）或来源读数被本批次重算的开放处置单，退回标准复核
    let shouldReview = false
    if (leak.sourceReadingId && recalculatedIds.has(leak.sourceReadingId)) {
      shouldReview = true
    } else {
      const source = leak.sourceReadingId ? readingById.get(leak.sourceReadingId) : undefined
      if (source) {
        shouldReview = !source.isAbnormal
      } else {
        // 旧手工单兜底：批次涉及该设备 ppm 点位即退回复核
        shouldReview = true
      }
    }
    if (!shouldReview) continue
    await db.leaks.update(leak.id, {
      state: '标准复核',
      reviewFromState: leak.state === '已处置' ? '已处置' : '待处置',
      reviewReason: `重算批次 ${batch.id}：标准值于 ${batch.effectiveDate} 调整，原异常结论需按新标准复核`,
      updatedAt: Date.now()
    })
  }

  await db.recalcBatches.update(batch.id, { reviewDone: true, updatedAt: Date.now() })
}

/**
 * 执行（或断点续跑）一个重算批次。
 * - 分块事务写入，单块失败按 RECALC_CHUNK_RETRY 自动重试
 * - 每条读数的成功/失败进度持久化，刷新页面后可从断点继续
 * - 全部成功后才执行泄漏单退回复核；存在失败项则批次为「部分失败」，可手动重试
 */
export async function runRecalcBatch(batchId: string): Promise<RecalcBatchRow | null> {
  if (runningBatchIds.has(batchId)) return (await db.recalcBatches.get(batchId)) ?? null
  runningBatchIds.add(batchId)
  try {
    const initial = await db.recalcBatches.get(batchId)
    if (!initial || initial.status === '已完成') return initial ?? null

    let batch = initial
    if (batch.status !== '部分失败') {
      await db.recalcBatches.update(batchId, { status: '进行中', updatedAt: Date.now() })
    }

    const pendingIndexes = batch.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status !== '成功')
      .map(({ index }) => index)

    for (let start = 0; start < pendingIndexes.length; start += RECALC_CHUNK_SIZE) {
      const chunk = pendingIndexes.slice(start, start + RECALC_CHUNK_SIZE)
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= RECALC_CHUNK_RETRY; attempt += 1) {
        try {
          await db.transaction(
            'rw',
            [db.readings, db.recalcBatches, db.standardVersions, db.points, db.patrols],
            async () => {
              // 每次尝试都取最新批次，避免重试时使用块开始时的旧 items 闭包
              const current = await db.recalcBatches.get(batchId)
              if (!current) throw new Error('重算批次已不存在')
              for (const index of chunk) {
                await recomputeReading(current.items[index].readingId, attempt === 0)
                current.items[index] = { ...current.items[index], status: '成功', error: '', triedAt: Date.now() }
              }
              const next = summarizeBatch(current, current.items)
              await db.recalcBatches.update(batchId, next)
            }
          )
          lastError = null
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (attempt < RECALC_CHUNK_RETRY) await sleep(RECALC_RETRY_DELAY_MS * (attempt + 1))
        }
      }

      if (lastError) {
        // 整块重试仍失败：逐条标记失败并持久化进度，后续可手动重试恢复
        const failed0 = await db.recalcBatches.get(batchId)
        if (failed0) {
          for (const index of chunk) {
            failed0.items[index] = {
              ...failed0.items[index],
              status: '失败',
              error: lastError.message,
              triedAt: Date.now()
            }
          }
          const next = summarizeBatch(failed0, failed0.items, '部分失败')
          await db.recalcBatches.update(batchId, next)
        }
      }

      const refreshed = await db.recalcBatches.get(batchId)
      if (!refreshed) return null
      batch = refreshed
    }

    const finalBatch = await db.recalcBatches.get(batchId)
    if (!finalBatch) return null
    if (finalBatch.failed > 0) {
      if (finalBatch.status !== '部分失败') {
        await db.recalcBatches.update(batchId, { status: '部分失败', updatedAt: Date.now() })
      }
      return (await db.recalcBatches.get(batchId)) ?? null
    }

    await db.transaction(
      'rw',
      [db.leaks, db.recalcBatches, db.points, db.readings],
      async () => {
        const latest = await db.recalcBatches.get(batchId)
        if (latest) await applyLeakReview(latest)
      }
    )
    await db.recalcBatches.update(batchId, { status: '已完成', updatedAt: Date.now() })
    return (await db.recalcBatches.get(batchId)) ?? null
  } finally {
    runningBatchIds.delete(batchId)
  }
}

function summarizeBatch(batch: RecalcBatchRow | undefined, items: RecalcItem[], forceStatus?: RecalcBatch['status']) {
  const succeeded = items.filter((item) => item.status === '成功').length
  const failed = items.filter((item) => item.status === '失败').length
  const patch: Partial<RecalcBatchRow> = {
    items,
    succeeded,
    failed,
    processed: succeeded + failed,
    updatedAt: Date.now()
  }
  if (forceStatus) patch.status = forceStatus
  else if (batch && failed > 0) patch.status = '部分失败'
  else if (batch && succeeded + failed >= batch.total) patch.status = '已完成'
  else if (batch) patch.status = '进行中'
  return patch
}

/** 启动时恢复：把上次未完成的批次（含部分失败）继续跑完；部分失败需页面手动重试时仅重跑失败项 */
export async function resumeInterruptedBatches(options: { includeFailed?: boolean } = {}): Promise<void> {
  const pending = await db.recalcBatches
    .filter((batch) => batch.status === '待执行' || batch.status === '进行中')
    .toArray()
  for (const batch of pending) {
    await runRecalcBatch(batch.id)
  }
  if (options.includeFailed) {
    const failed = await db.recalcBatches.filter((batch) => batch.status === '部分失败').toArray()
    for (const batch of failed) {
      await runRecalcBatch(batch.id)
    }
  }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.standardVersions.count(),
    db.recalcBatches.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.standardVersions.toArray(),
    db.recalcBatches.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    standardVersions: standardVersions.map(strip),
    recalcBatches: recalcBatches.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
      const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
      await db.stations.bulkPut((payload.stations ?? []).map(rev))
      await db.devices.bulkPut((payload.devices ?? []).map(rev))
      await db.points.bulkPut((payload.points ?? []).map(rev))
      await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
      await db.readings.bulkPut((payload.readings ?? []).map(rev))
      await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
      await db.standardVersions.bulkPut((payload.standardVersions ?? []).map(rev))
      await db.recalcBatches.bulkPut((payload.recalcBatches ?? []).map(rev))
    }
  )
  // 导入后继续跑未完成批次
  await resumeInterruptedBatches()
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions, db.recalcBatches],
    async () => {
      await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
