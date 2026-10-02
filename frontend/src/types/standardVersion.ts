/**
 * 点位标准值版本：标准值调整不覆盖历史，每个版本带生效日期。
 * - 历史读数按巡检日期取「生效日期 ≤ 巡检日期」的最新版本
 * - 新读数（巡检日期为空或晚于最新生效日期）取最新版本
 */
export interface StandardVersion {
  /** 主键：`${pointId}:${effectiveDate}`，同点位同日重复提交天然幂等 */
  id: string
  /** 自增版本序号（按点位维度递增） */
  versionNo: number
  pointId: string
  deviceId: string
  stationId: string
  /** 生效日期 YYYY-MM-DD */
  effectiveDate: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
  /** initial = 旧数据首次打开升级的初始版本；adjustment = 班组交接调整生成 */
  source: 'initial' | 'adjustment'
  /** 触发该版本的重算批次（初始版本为空） */
  recalcBatchId: string
  note: string
  createdAt: number
  updatedAt: number
}

export interface StandardVersionDraft {
  pointId: string
  effectiveDate: string
  standardMin: number
  standardMax: number
  isCritical: boolean
  note: string
}

/** 初始版本的生效日期：早于全部演示/历史巡检日期 */
export const INITIAL_VERSION_DATE = '2024-05-01'

/** 版本主键（同点位同日重复提交命中同一主键，不产生重复版本） */
export function standardVersionId(pointId: string, effectiveDate: string): string {
  return `${pointId}:${effectiveDate}`
}
