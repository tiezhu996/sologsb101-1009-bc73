/**
 * 点位标准值版本：标准值不再直接覆盖，每次班组调整生成一条带生效日期的新版本。
 * 历史读数按巡检日期取「生效日期 <= 巡检日期」的最新版本；新读数取最新版本。
 */
export type StandardSource = '初始版本' | '班组调整'

export interface StandardVersion {
  id: string
  pointId: string
  /** 冗余站点 id，便于按站点筛选 */
  stationId: string
  /** 同一点位内从 1 递增的版本号 */
  versionNo: number
  standardMin: number
  standardMax: number
  isCritical: boolean
  unit: string
  /** 生效日期 YYYY-MM-DD（班组交接日） */
  effectiveDate: string
  /** 调整原因 / 交接说明 */
  reason: string
  source: StandardSource
  createdAt: number
  updatedAt: number
}

/* ============================ 重算批次 ============================ */

export type RecalcBatchStatus = '待执行' | '进行中' | '已完成' | '部分失败'
export type RecalcItemStatus = '待处理' | '成功' | '失败'

/** 批次内单条读数的重算进度（进度持久化，失败重试时跳过已成功项） */
export interface RecalcItem {
  readingId: string
  status: RecalcItemStatus
  /** 最近一次失败原因（成功后清空） */
  error: string
  /** 最近一次尝试时间戳 */
  triedAt: number
}

/**
 * 标准值调整重算批次：
 * 调整标准值时先生成批次，再分块写入；写入失败自动重试，可从断点恢复。
 */
export interface RecalcBatch {
  id: string
  status: RecalcBatchStatus
  /** 本次调整原因（交接说明） */
  reason: string
  /** 新版本生效日期 */
  effectiveDate: string
  total: number
  processed: number
  succeeded: number
  failed: number
  /** 泄漏单退回标准复核是否已执行（全部读数重算成功后才执行，保证幂等） */
  reviewDone: boolean
  items: RecalcItem[]
  createdAt: number
  updatedAt: number
}

export const RECALC_BATCH_STATUSES: RecalcBatchStatus[] = ['待执行', '进行中', '已完成', '部分失败']

export function recalcProgressPercent(batch: Pick<RecalcBatch, 'succeeded' | 'failed' | 'total'>): number {
  if (batch.total <= 0) return 100
  return Math.round(((batch.succeeded + batch.failed) / batch.total) * 100)
}
