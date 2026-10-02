/**
 * 泄漏处置：由异常读数派发的处置单，复检合格后闭环。
 * 标准值调整重算后，待处置 / 已处置的处置单退回「标准复核」并挡住复检；
 * 已复检（含合格与不合格结论）的处置单保留原结论不动。
 */
export type LeakState = '待处置' | '已处置' | '标准复核' | '已复检'

export interface Leak {
  id: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 泄漏浓度（ppm） */
  concentrationPpm: number
  /** 发现时间 YYYY-MM-DD */
  foundTime: string
  measure: string
  state: LeakState
  /** 复检浓度（ppm） */
  retestValuePpm: number
  handler: string
  /**
   * 派发幂等键：由异常读数派单时取 `r:<readingId>`，手工派单取 `m:<deviceId>:<foundTime>`。
   * 重复提交（含批量确认）命中已有键即跳过，不会多出泄漏单。
   */
  dispatchKey: string
  /** 来源异常读数 id（可空：手工新建或旧数据迁移未匹配上时为空） */
  sourceReadingId: string
  /** 退回标准复核时记录的原状态（待处置 / 已处置），复核后据此恢复 */
  reviewFromState: '待处置' | '已处置' | ''
  /** 退回标准复核的原因（触发的重算批次 id 与说明） */
  reviewReason: string
  createdAt: number
  updatedAt: number
}

export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '标准复核', '已复检']

/** 泄漏处置状态机：待处置 → 已处置 → 已复检；标准复核是调整标准值时的临时退回态 */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  标准复核: null,
  已复检: null
}

/** 会被标准值调整退回标准复核、并挡住复检的开放态 */
export const LEAK_REVIEWABLE_STATES: LeakState[] = ['待处置', '已处置']

/** 已复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

export interface LeakDraft {
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakState
  retestValuePpm: number
  handler: string
}

export const EMPTY_LEAK_DRAFT: LeakDraft = {
  deviceId: '',
  concentrationPpm: 0,
  foundTime: '',
  measure: '',
  state: '待处置',
  retestValuePpm: 0,
  handler: ''
}

export function createEmptyLeakDraft(): LeakDraft {
  return { ...EMPTY_LEAK_DRAFT }
}

export function retestPassed(value: number): boolean {
  return value > 0 && value <= LEAK_RETEST_PASS_PPM
}

/** 由异常读数派单的幂等键 */
export function readingDispatchKey(readingId: string): string {
  return `r:${readingId}`
}

/** 手工派单的幂等键（同设备同日不重复） */
export function manualDispatchKey(deviceId: string, foundTime: string): string {
  return `m:${deviceId}:${foundTime}`
}
