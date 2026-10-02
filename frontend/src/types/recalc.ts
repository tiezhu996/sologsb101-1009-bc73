/**
 * 标准值调整重算批次：
 * 调整提交先生成批次，再分块重算受影响读数；写入失败可重试并从检查点续算。
 * 批次内的泄漏单派发按读数 id 幂等，重复提交不会多出泄漏单。
 */
export type RecalcBatchStatus = 'running' | 'succeeded' | 'failed'

export interface RecalcBatch {
  id: string
  /** 幂等键：调整点位集合 + 生效日期 + 新标准值的指纹；重复提交直接复用既有批次 */
  idempotencyKey: string
  status: RecalcBatchStatus
  /** 本次生效日期 */
  effectiveDate: string
  /** 受影响点位（含新旧标准值快照） */
  pointChanges: RecalcPointChange[]
  /** 创建批次时冻结的受影响读数 id（巡检日期 ≥ 生效日期的全部读数） */
  readingIds: string[]
  /** 检查点：已处理到 readingIds 的下标（前 processedCount 条已完成） */
  processedCount: number
  /** 重算后判定由正常变异常的读数 id */
  newAbnormalReadingIds: string[]
  /** 被退回标准复核的泄漏单 id */
  reviewedLeakIds: string[]
  /** 已派发处置单的读数 id（幂等集合，重复提交不会多出泄漏单） */
  dispatchedReadingIds: string[]
  note: string
  failReason: string
  readFailureAt: number
  createdAt: number
  updatedAt: number
}

export interface RecalcPointChange {
  pointId: string
  deviceId: string
  stationId: string
  unit: string
  fromMin: number
  fromMax: number
  fromCritical: boolean
  toMin: number
  toMax: number
  toCritical: boolean
}

export interface RecalcBatchProgress {
  batch: RecalcBatch
  total: number
  done: number
  percent: number
}

export function describeRecalcStatus(status: RecalcBatchStatus): string {
  if (status === 'running') return '重算中'
  if (status === 'succeeded') return '已完成'
  return '写入失败，待重试'
}
