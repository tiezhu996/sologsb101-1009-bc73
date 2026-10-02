/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /** 判定时命中的标准版本 id（按巡检日期取生效版本），用于追溯当时判定 */
  standardVersionId: string
  /** 判定时生效标准下限快照 */
  judgedMin: number
  /** 判定时生效标准上限快照 */
  judgedMax: number
  /** 判定时关键点标记快照 */
  judgedCritical: boolean
  /** 判定依据的巡检日期（实际日期优先，未完成时取计划日期） */
  judgedDate: string
  /** 最近一次重算该读数的批次 id；非批次写入为空 */
  recalcBatchId: string
  createdAt: number
  updatedAt: number
}

export interface ReadingDraft {
  patrolId: string
  pointId: string
  value: number
  note: string
}

export const EMPTY_READING_DRAFT: ReadingDraft = {
  patrolId: '',
  pointId: '',
  value: 0,
  note: ''
}

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值 */
export type ReadingDraftMap = Record<string, number>
