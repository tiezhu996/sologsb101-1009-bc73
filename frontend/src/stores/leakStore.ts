/**
 * 泄漏处置状态（Zustand）
 * 维护处置单状态机、复检值与闭环统计。
 * 标准值调整重算时：待处置/已处置单退回「标准复核」并挡住复检；已复检合格的保留原结论。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { createId, db, type LeakRow } from '@/utils/db'
import { resolveLeakReview } from '@/utils/recalc'
import {
  LEAK_RETEST_PASS_PPM,
  isUnderReview,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'

interface CreateFromAbnormalPayload {
  deviceId: string
  stationId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  /** 来源读数 id：同一读数只允许一张泄漏单，重复提交不会多出泄漏单 */
  sourceReadingId?: string
  recalcBatchId?: string
}

interface LeakState_ {
  leaks: Leak[]
  stateFilter: LeakState[]
  stationId: string
  onlyOpen: boolean
  ready: boolean
  patchFilter: (patch: { stateFilter?: LeakState[]; stationId?: string; onlyOpen?: boolean }) => void
  resetFilter: () => void
  createLeak: (draft: LeakDraft) => Promise<Leak>
  updateLeak: (id: string, patch: Partial<LeakDraft>) => Promise<void>
  removeLeak: (id: string) => Promise<void>
  advance: (id: string, params?: { handler?: string; measure?: string }) => Promise<LeakState | null>
  submitRetest: (id: string, retestValuePpm: number, handler: string) => Promise<boolean>
  resolveReview: (id: string, decision: 'confirm' | 'invalidate', patch?: { handler?: string; measure?: string }) => Promise<void>
  hasLeakOfDevice: (deviceId: string) => boolean
  /** 某条读数是否已派发过泄漏单（重复派单拦截） */
  hasLeakOfReading: (readingId: string) => boolean
  createFromAbnormal: (payload: CreateFromAbnormalPayload) => Promise<Leak | null>
  counts: () => Record<LeakState, number>
  reviewCount: () => number
  closedPercent: () => number
  retestPassCount: () => number
  filteredLeaks: () => Leak[]
}

export const useLeakStore = create<LeakState_>((set, get) => ({
  leaks: [],
  stateFilter: [],
  stationId: '',
  onlyOpen: false,
  ready: false,

  patchFilter(patch) {
    set({
      stateFilter: patch.stateFilter ?? get().stateFilter,
      stationId: patch.stationId ?? get().stationId,
      onlyOpen: patch.onlyOpen ?? get().onlyOpen
    })
  },

  resetFilter() {
    set({ stateFilter: [], stationId: '', onlyOpen: false })
  },

  async createLeak(draft) {
    const device = await db.devices.get(draft.deviceId)
    const now = Date.now()
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      concentrationPpm: Number(draft.concentrationPpm) || 0,
      foundTime: draft.foundTime,
      measure: draft.measure.trim(),
      state: draft.state,
      retestValuePpm: Number(draft.retestValuePpm) || 0,
      handler: draft.handler.trim(),
      sourceReadingId: '',
      recalcBatchId: '',
      stateBeforeReview: '',
      reviewReason: '',
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  async updateLeak(id, patch) {
    const next: Partial<LeakRow> = { ...patch, updatedAt: Date.now() }
    if (patch.measure !== undefined) next.measure = patch.measure.trim()
    if (patch.handler !== undefined) next.handler = patch.handler.trim()
    // 编辑不允许把单子人工改出/改入标准复核；若正处于复核，状态字段忽略
    const current = get().leaks.find((item) => item.id === id)
    if (current && current.state === '标准复核') delete next.state
    await db.leaks.update(id, next)
  },

  async removeLeak(id) {
    await db.leaks.delete(id)
  },

  async advance(id, params) {
    const leak = get().leaks.find((item) => item.id === id)
    if (!leak) return null
    // 标准复核中的处置单挡住流转（需先在复核操作中确认/关闭）
    if (isUnderReview(leak)) return null
    const next: LeakState | null = leak.state === '待处置' ? '已处置' : leak.state === '已处置' ? '已复检' : null
    if (!next) return null
    const patch: Partial<LeakRow> = { state: next, updatedAt: Date.now() }
    if (params?.handler !== undefined) patch.handler = params.handler.trim()
    if (params?.measure !== undefined) patch.measure = params.measure.trim()
    await db.leaks.update(id, patch)
    return next
  },

  async submitRetest(id, retestValuePpm, handler) {
    const leak = get().leaks.find((item) => item.id === id)
    if (!leak) return false
    // 已退回标准复核的处置单必须挡住复检
    if (isUnderReview(leak)) {
      throw new Error('该处置单已退回标准复核，须先完成复核确认，才能录入复检')
    }
    const value = Number(retestValuePpm) || 0
    await db.leaks.update(id, {
      state: '已复检',
      retestValuePpm: value,
      handler: handler.trim() || '未署名',
      updatedAt: Date.now()
    })
    return retestPassed(value)
  },

  async resolveReview(id, decision, patch) {
    await resolveLeakReview(id, decision, patch)
  },

  hasLeakOfDevice(deviceId) {
    return get().leaks.some((leak) => leak.deviceId === deviceId)
  },

  hasLeakOfReading(readingId) {
    if (!readingId) return false
    return get().leaks.some((leak) => leak.sourceReadingId === readingId)
  },

  async createFromAbnormal(payload) {
    // 同一读数的泄漏单幂等：重复提交（含批量勾选、批次续跑）不会多出泄漏单
    if (payload.sourceReadingId && get().hasLeakOfReading(payload.sourceReadingId)) {
      const existing = get().leaks.find((leak) => leak.sourceReadingId === payload.sourceReadingId)
      return existing ?? null
    }
    const device = await db.devices.get(payload.deviceId)
    const now = Date.now()
    const row: LeakRow = {
      id: createId('lk'),
      deviceId: payload.deviceId,
      stationId: payload.stationId || (device ? device.stationId : ''),
      concentrationPpm: Number(payload.concentrationPpm) || 0,
      foundTime: payload.foundTime,
      measure: payload.measure.trim(),
      state: '待处置',
      retestValuePpm: 0,
      handler: '',
      sourceReadingId: payload.sourceReadingId ?? '',
      recalcBatchId: payload.recalcBatchId ?? '',
      stateBeforeReview: '',
      reviewReason: '',
      createdAt: now,
      updatedAt: now
    }
    await db.leaks.put(row)
    return row
  },

  counts() {
    const counts: Record<LeakState, number> = { 待处置: 0, 已处置: 0, 标准复核: 0, 已复检: 0 }
    get().leaks.forEach((leak) => {
      counts[leak.state] += 1
    })
    return counts
  },

  reviewCount() {
    return get().leaks.filter((leak) => leak.state === '标准复核').length
  },

  closedPercent() {
    const { leaks } = get()
    if (leaks.length === 0) return 0
    const closed = leaks.filter((leak) => leak.state === '已复检').length
    return Math.round((closed / leaks.length) * 100)
  },

  retestPassCount() {
    return get().leaks.filter((leak) => leak.state === '已复检' && retestPassed(leak.retestValuePpm)).length
  },

  filteredLeaks() {
    const { leaks, stateFilter, stationId, onlyOpen } = get()
    return leaks
      .filter((leak) => {
        if (stationId && leak.stationId !== stationId) return false
        if (stateFilter.length > 0 && !stateFilter.includes(leak.state)) return false
        if (onlyOpen && leak.state === '已复检') return false
        return true
      })
      .sort((a, b) => {
        // 标准复核最优先，其次按发现时间倒序
        if ((a.state === '标准复核') !== (b.state === '标准复核')) return a.state === '标准复核' ? -1 : 1
        return b.foundTime.localeCompare(a.foundTime)
      })
  }
}))

liveQuery(async () => (await db.leaks.toArray()).sort((a, b) => b.foundTime.localeCompare(a.foundTime))).subscribe({
  next: (rows) => useLeakStore.setState({ leaks: rows, ready: true }),
  error: () => useLeakStore.setState({ ready: true })
})

export { LEAK_RETEST_PASS_PPM }
