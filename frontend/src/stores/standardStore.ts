/**
 * 标准值版本与重算批次状态（Zustand）
 * - 班组交接调整：标准值先进草稿，统一选择生效日期后生成「带生效日期的新版本 + 重算批次」
 * - 历史读数由批次按巡检日期取当时版本重判；新版本自动成为新读数判定口径
 * - 批次分块写入、失败重试、进度持久化，可断点恢复
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createStandardAdjustment,
  db,
  resumeInterruptedBatches,
  runRecalcBatch,
  todayText,
  type RecalcBatchRow
} from '@/utils/db'
import type { StandardDraft } from '@/types/point'
import type { StandardVersion } from '@/types/standard'
import { latestStandardVersion, resolveStandardOn, sortVersionsAsc, type ResolvedStandard } from '@/utils/standardVersion'
import { useStationStore } from '@/stores/stationStore'

interface StandardState {
  versions: StandardVersion[]
  batches: RecalcBatchRow[]
  ready: boolean
  /** 标准值编辑草稿：点位 id → 待提交的上下限与关键点 */
  drafts: Record<string, StandardDraft>
  /** 下一次班组交接调整的生效日期 */
  effectiveDate: string
  /** 调整原因 / 交接说明 */
  reason: string
  /** 当前正在执行的批次（用于进度条） */
  runningBatchId: string | null
  setEffectiveDate: (date: string) => void
  setReason: (reason: string) => void
  setDraft: (pointId: string, draft: StandardDraft) => void
  clearDraft: (pointId?: string) => void
  /** 草稿相对当前标准值是否确有变化 */
  isDraftChanged: (pointId: string) => boolean
  changedPointIds: () => string[]
  versionsOfPoint: (pointId: string) => StandardVersion[]
  latestVersionOfPoint: (pointId: string) => StandardVersion | null
  /** 某日期（巡检日期）适用的标准口径；date 为空取最新 */
  standardOn: (pointId: string, date?: string) => ResolvedStandard | null
  /**
   * 提交草稿：生成新版本与重算批次并立即执行。
   * 重复提交（草稿与最新版本一致）会被跳过，不会产生多余版本或泄漏单。
   */
  commitDrafts: (pointIds?: string[]) => Promise<{ batchId: string; changed: number } | null>
  retryBatch: (batchId: string) => Promise<void>
  /** 启动时把上次未完成的批次继续跑完（含部分失败项） */
  resumePending: () => Promise<void>
}

export const useStandardStore = create<StandardState>((set, get) => ({
  versions: [],
  batches: [],
  ready: false,
  drafts: {},
  effectiveDate: todayText(),
  reason: '',
  runningBatchId: null,

  setEffectiveDate(date) {
    set({ effectiveDate: date })
  },

  setReason(reason) {
    set({ reason })
  },

  setDraft(pointId, draft) {
    set({ drafts: { ...get().drafts, [pointId]: draft } })
  },

  clearDraft(pointId) {
    if (pointId === undefined) {
      set({ drafts: {} })
      return
    }
    const next = { ...get().drafts }
    delete next[pointId]
    set({ drafts: next })
  },

  isDraftChanged(pointId) {
    const point = useStationStore.getState().points.find((item) => item.id === pointId)
    const draft = get().drafts[pointId]
    if (!point || !draft) return false
    const min = Math.min(draft.standardMin, draft.standardMax)
    const max = Math.max(draft.standardMin, draft.standardMax)
    const normalizedMax = max > min ? max : min + 0.001
    return point.standardMin !== min || point.standardMax !== normalizedMax || point.isCritical !== draft.isCritical
  },

  changedPointIds() {
    return Object.keys(get().drafts).filter((pointId) => get().isDraftChanged(pointId))
  },

  versionsOfPoint(pointId) {
    return sortVersionsAsc(get().versions.filter((version) => version.pointId === pointId))
  },

  latestVersionOfPoint(pointId) {
    return latestStandardVersion(get().versions.filter((version) => version.pointId === pointId))
  },

  standardOn(pointId, date) {
    return resolveStandardOn(get().versions.filter((version) => version.pointId === pointId), date ?? '')
  },

  async commitDrafts(pointIds) {
    const targets = (pointIds ?? Object.keys(get().drafts)).filter((id) => get().isDraftChanged(id))
    if (targets.length === 0) return null
    const items = targets.map((pointId) => {
      const draft = get().drafts[pointId]
      return {
        pointId,
        standardMin: draft.standardMin,
        standardMax: draft.standardMax,
        isCritical: draft.isCritical
      }
    })
    const result = await createStandardAdjustment(items, {
      effectiveDate: get().effectiveDate,
      reason: get().reason
    })
    if (!result) {
      get().clearDraft()
      return null
    }
    get().clearDraft()
    set({ runningBatchId: result.batchId })
    try {
      await runRecalcBatch(result.batchId)
    } finally {
      set({ runningBatchId: null })
    }
    return { batchId: result.batchId, changed: result.changedPointIds.length }
  },

  async retryBatch(batchId) {
    set({ runningBatchId: batchId })
    try {
      await runRecalcBatch(batchId)
    } finally {
      set({ runningBatchId: null })
    }
  },

  async resumePending() {
    await resumeInterruptedBatches({ includeFailed: true })
  }
}))

liveQuery(async () =>
  (await db.standardVersions.toArray()).sort((a, b) =>
    a.pointId === b.pointId
      ? a.effectiveDate === b.effectiveDate
        ? a.versionNo - b.versionNo
        : a.effectiveDate.localeCompare(b.effectiveDate)
      : a.pointId.localeCompare(b.pointId)
  )
).subscribe({
  next: (rows) => useStandardStore.setState({ versions: rows, ready: true }),
  error: () => useStandardStore.setState({ ready: true })
})

liveQuery(async () => (await db.recalcBatches.toArray()).sort((a, b) => b.createdAt - a.createdAt)).subscribe({
  next: (rows) => useStandardStore.setState({ batches: rows })
})
