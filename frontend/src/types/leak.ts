/**
 * 泄漏处置：由异常读数派发的处置单，复检合格后闭环。
 * 标准值调整重算时：待处置/已处置的单子退回「标准复核」并挡住复检；已复检合格的保留原结论。
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
  /** 派单来源读数 id：同一条读数只允许派发一张泄漏单（重算批次幂等派单依据） */
  sourceReadingId: string
  /** 派发该单的重算批次 id；人工派发为空 */
  recalcBatchId: string
  /** 退回标准复核前的状态，复核确认后恢复 */
  stateBeforeReview: LeakState | ''
  /** 退回标准复核的原因/批次说明 */
  reviewReason: string
  createdAt: number
  updatedAt: number
}

/** 列表与筛选顺序：标准复核排在待处置、已处置之前 */
export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '标准复核', '已复检']

/** 手工新建/编辑处置单时允许选择的状态（标准复核只能由重算批次触发） */
export const MANUAL_LEAK_STATES: LeakState[] = ['待处置', '已处置', '已复检']

/** 常规处置状态机：待处置 → 已处置 → 已复检（标准复核是旁路，需先确认复核） */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  标准复核: null,
  已复检: null
}

/** 复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

/** 重算时需要退回标准复核的状态（已复检合格的保留原结论，不退回） */
export const REVIEWABLE_STATES: LeakState[] = ['待处置', '已处置']

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

/** 已复检且复检合格：标准调整后保留原结论 */
export function isClosedPassed(leak: Pick<Leak, 'state' | 'retestValuePpm'>): boolean {
  return leak.state === '已复检' && retestPassed(leak.retestValuePpm)
}

/** 标准复核中：复检入口必须挡住 */
export function isUnderReview(leak: Pick<Leak, 'state'>): boolean {
  return leak.state === '标准复核'
}
