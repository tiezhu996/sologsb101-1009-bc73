/**
 * 巡检任务与读数状态（Zustand）
 * 维护巡检任务列表、读数草稿与异常判定结果。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  deletePatrolCascade,
  putReading,
  putReadingRows,
  type PatrolRow
} from '@/utils/db'
import type { Patrol, PatrolDraft, PatrolState } from '@/types/patrol'
import type { Point } from '@/types/point'
import type { Reading } from '@/types/reading'
import type { ReadingDraftMap } from '@/types/reading'
import type { AbnormalLevel, ReadingJudgement } from '@/utils/range'
import { abnormalLevelOf, abnormalWeight, judgeReading } from '@/utils/range'
import { useStationStore } from '@/stores/stationStore'

export interface AbnormalRow {
  reading: Reading
  patrol: Patrol | null
  point: Point | null
  /** 判定级别：优先用读数存档时命中版本的标准快照，保证历史追溯与当时判定一致 */
  level: AbnormalLevel
  weight: number
  /** 判定时生效的标准区间（当时版本快照） */
  judgedMin: number
  judgedMax: number
  judgedCritical: boolean
  /** 命中的标准版本 id，空串表示版本缺失 */
  standardVersionId: string
}

interface PatrolState_ {
  patrols: Patrol[]
  readings: Reading[]
  /** 读数草稿：`${patrolId}:${pointId}` → 输入值 */
  readingDraft: ReadingDraftMap
  /** 当前正在录入的巡检 id */
  activePatrolId: string | null
  filter: { stationId: string; states: PatrolState[] }
  ready: boolean
  setActivePatrol: (id: string | null) => void
  patchFilter: (patch: { stationId?: string; states?: PatrolState[] }) => void
  resetFilter: () => void
  createPatrol: (draft: PatrolDraft) => Promise<Patrol>
  updatePatrol: (id: string, patch: Partial<PatrolDraft>) => Promise<void>
  removePatrol: (id: string) => Promise<void>
  generatePlans: (stationIds: string[], planDate: string, patrolman: string) => Promise<number>
  markMissed: (id: string, note: string) => Promise<void>
  completePatrol: (id: string, patrolDate: string, patrolman: string, envNote: string) => Promise<void>
  setReadingDraft: (patrolId: string, pointId: string, value: number) => void
  clearReadingDraft: (patrolId?: string) => void
  seedDraftFromReadings: (patrolId: string, points: Point[]) => void
  saveReadingDrafts: (patrolId: string, points: Point[]) => Promise<number>
  saveSingleReading: (patrolId: string, point: Point, value: number, note: string) => Promise<void>
  removeReading: (id: string) => Promise<void>
  judge: (point: Point, value: number) => ReadingJudgement
  readingsOfPatrol: (patrolId: string) => Reading[]
  abnormalRows: () => AbnormalRow[]
  filteredPatrols: () => Patrol[]
  pointValuesOf: (patrolId: string) => Map<string, Reading>
}

export const usePatrolStore = create<PatrolState_>((set, get) => ({
  patrols: [],
  readings: [],
  readingDraft: {},
  activePatrolId: null,
  filter: { stationId: '', states: [] },
  ready: false,

  setActivePatrol(id) {
    set({ activePatrolId: id })
  },

  patchFilter(patch) {
    set({
      filter: {
        stationId: patch.stationId ?? get().filter.stationId,
        states: patch.states ?? get().filter.states
      }
    })
  },

  resetFilter() {
    set({ filter: { stationId: '', states: [] } })
  },

  async createPatrol(draft) {
    const now = Date.now()
    const row: PatrolRow = {
      id: createId('pa'),
      stationId: draft.stationId || '',
      planDate: draft.planDate,
      patrolDate: draft.patrolDate,
      patrolman: draft.patrolman.trim(),
      envNote: draft.envNote.trim(),
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.patrols.put(row)
    return row
  },

  async updatePatrol(id, patch) {
    const next: Partial<PatrolRow> = { ...patch, updatedAt: Date.now() }
    if (patch.patrolman !== undefined) next.patrolman = patch.patrolman.trim()
    if (patch.envNote !== undefined) next.envNote = patch.envNote.trim()
    await db.patrols.update(id, next)
  },

  async removePatrol(id) {
    await deletePatrolCascade(id)
    get().clearReadingDraft(id)
    if (get().activePatrolId === id) set({ activePatrolId: null })
  },

  async generatePlans(stationIds, planDate, patrolman) {
    const now = Date.now()
    const existing = get().patrols.filter((patrol) => patrol.planDate === planDate).map((patrol) => patrol.stationId)
    const rows: PatrolRow[] = stationIds
      .filter((stationId) => !existing.includes(stationId))
      .map((stationId) => ({
        id: createId('pa'),
        stationId,
        planDate,
        patrolDate: '',
        patrolman: patrolman.trim(),
        envNote: '',
        state: '待巡检' as PatrolState,
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) await db.patrols.bulkPut(rows)
    return rows.length
  },

  async markMissed(id, note) {
    await db.patrols.update(id, { state: '漏检', envNote: note.trim() || '超期未执行', updatedAt: Date.now() })
  },

  async completePatrol(id, patrolDate, patrolman, envNote) {
    await db.patrols.update(id, {
      state: '已完成',
      patrolDate,
      patrolman: patrolman.trim() || '未署名',
      envNote: envNote.trim(),
      updatedAt: Date.now()
    })
  },

  setReadingDraft(patrolId, pointId, value) {
    set({ readingDraft: { ...get().readingDraft, [`${patrolId}:${pointId}`]: value } })
  },

  clearReadingDraft(patrolId) {
    if (patrolId === undefined) {
      set({ readingDraft: {} })
      return
    }
    const next: ReadingDraftMap = {}
    Object.entries(get().readingDraft).forEach(([key, value]) => {
      if (!key.startsWith(`${patrolId}:`)) next[key] = value
    })
    set({ readingDraft: next })
  },

  seedDraftFromReadings(patrolId, points) {
    const next = { ...get().readingDraft }
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    points.forEach((point) => {
      const key = `${patrolId}:${point.id}`
      if (next[key] !== undefined) return
      const found = existing.find((reading) => reading.pointId === point.id)
      if (found) next[key] = found.value
    })
    set({ readingDraft: next })
  },

  async saveReadingDrafts(patrolId, points) {
    const draft = get().readingDraft
    const existing = get().readings.filter((reading) => reading.patrolId === patrolId)
    const now = Date.now()
    const payload: Array<{
      id: string
      patrolId: string
      pointId: string
      value: number
      note: string
      createdAt: number
      updatedAt: number
    }> = []
    points.forEach((point) => {
      const key = `${patrolId}:${point.id}`
      const value = draft[key]
      if (value === undefined || !Number.isFinite(value)) return
      const found = existing.find((reading) => reading.pointId === point.id)
      payload.push({
        id: found ? found.id : createId('rd'),
        patrolId,
        pointId: point.id,
        value,
        note: found ? found.note : '',
        createdAt: found ? found.createdAt : now,
        updatedAt: now
      })
    })
    // 新读数统一按最新版本判定（写入层内部按巡检日期取生效版本）
    const saved = await putReadingRows(payload)
    return saved.length
  },

  async saveSingleReading(patrolId, point, value, note) {
    const now = Date.now()
    const found = get().readings.find((reading) => reading.patrolId === patrolId && reading.pointId === point.id)
    await putReading({
      id: found ? found.id : createId('rd'),
      patrolId,
      pointId: point.id,
      value,
      note,
      createdAt: found ? found.createdAt : now,
      updatedAt: now
    })
  },

  async removeReading(id) {
    await db.readings.delete(id)
  },

  judge(point, value) {
    return judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
  },

  readingsOfPatrol(patrolId) {
    return get().readings.filter((reading) => reading.patrolId === patrolId)
  },

  abnormalRows() {
    const points = useStationStore.getState().points
    return get()
      .readings.filter((reading) => reading.isAbnormal)
      .map((reading) => {
        const point = points.find((item) => item.id === reading.pointId) ?? null
        const patrol = get().patrols.find((item) => item.id === reading.patrolId) ?? null
        // 按读数落库时命中的标准版本快照还原当时判定，而不是用当前最新标准重判
        const judgedCritical = reading.judgedCritical ?? point?.isCritical ?? false
        const level: AbnormalLevel = point || reading.standardVersionId
          ? abnormalLevelOf(reading.deviationPct, judgedCritical)
          : '轻微超标'
        return {
          reading,
          patrol,
          point,
          level,
          weight: point || reading.standardVersionId ? abnormalWeight(level, judgedCritical) : 20,
          judgedMin: reading.judgedMin ?? point?.standardMin ?? 0,
          judgedMax: reading.judgedMax ?? point?.standardMax ?? 1,
          judgedCritical,
          standardVersionId: reading.standardVersionId ?? ''
        }
      })
      .sort((a, b) => b.weight - a.weight || b.reading.deviationPct - a.reading.deviationPct)
  },

  filteredPatrols() {
    const { patrols, filter } = get()
    return patrols
      .filter((patrol) => {
        if (filter.stationId && patrol.stationId !== filter.stationId) return false
        if (filter.states.length > 0 && !filter.states.includes(patrol.state)) return false
        return true
      })
      .sort((a, b) => b.planDate.localeCompare(a.planDate))
  },

  pointValuesOf(patrolId) {
    const map = new Map<string, Reading>()
    get()
      .readings.filter((reading) => reading.patrolId === patrolId)
      .forEach((reading) => map.set(reading.pointId, reading))
    return map
  }
}))

liveQuery(async () =>
  (await db.patrols.toArray()).sort((a, b) => b.planDate.localeCompare(a.planDate))
).subscribe({
  next: (rows) => usePatrolStore.setState({ patrols: rows, ready: true }),
  error: () => usePatrolStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.readings.toArray()).sort((a, b) => b.deviationPct - a.deviationPct)
).subscribe({
  next: (rows) => usePatrolStore.setState({ readings: rows })
})

export { abnormalLevelOf }
