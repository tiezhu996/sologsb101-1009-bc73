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
  /**
   * 判定快照：录入/重算时生效的标准值版本 id。
   * 历史读数按巡检日期取当时版本判定，标准值后续调整不改写已落快照的判定口径。
   */
  standardVersionId: string
  /** 判定时所用标准下限（快照，便于各页追溯当时判定） */
  judgeStandardMin: number
  /** 判定时所用标准上限（快照） */
  judgeStandardMax: number
  /** 判定时所用关键点标记（快照） */
  judgeIsCritical: boolean
  /** 判定所依据的生效日期（冗余，便于直接展示） */
  judgeEffectiveDate: string
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
