/**
 * 标准值版本选择：
 * - 历史读数：取「生效日期 <= 巡检日期」中生效日期最大的版本（当时判定口径）
 * - 新读数 / 无日期：取最新版本
 */
import type { StandardVersion } from '@/types/standard'
import { judgeReading, type ReadingJudgement } from '@/utils/range'

export interface ResolvedStandard {
  version: StandardVersion | null
  standardMin: number
  standardMax: number
  isCritical: boolean
  unit: string
  effectiveDate: string
}

function fallback(version: StandardVersion | null): ResolvedStandard | null {
  if (!version) return null
  return {
    version,
    standardMin: version.standardMin,
    standardMax: version.standardMax,
    isCritical: version.isCritical,
    unit: version.unit,
    effectiveDate: version.effectiveDate
  }
}

/** 按日期升序排列版本（生效日期相同则按版本号） */
export function sortVersionsAsc(list: StandardVersion[]): StandardVersion[] {
  return [...list].sort((a, b) =>
    a.effectiveDate === b.effectiveDate ? a.versionNo - b.versionNo : a.effectiveDate.localeCompare(b.effectiveDate)
  )
}

/** 同点位最新版本（生效日期最大、版本号最大） */
export function latestStandardVersion(list: StandardVersion[]): StandardVersion | null {
  if (list.length === 0) return null
  return sortVersionsAsc(list)[list.length - 1]
}

/**
 * 取某个日期（巡检日期 YYYY-MM-DD）适用的标准值版本。
 * 日期为空时退化为最新版本；早于所有版本生效日期时取最早版本（点位投用即有初始版本）。
 */
export function resolveStandardOn(list: StandardVersion[], date: string): ResolvedStandard | null {
  if (list.length === 0) return null
  const asc = sortVersionsAsc(list)
  if (!date) return fallback(asc[asc.length - 1])
  let chosen = asc[0]
  for (const version of asc) {
    if (version.effectiveDate <= date) chosen = version
    else break
  }
  return fallback(chosen)
}

/** 用已解析的版本口径判定读数 */
export function judgeWithStandard(value: number, standard: ResolvedStandard | null): ReadingJudgement {
  if (!standard) return judgeReading(value, 0, 1, false)
  return judgeReading(value, standard.standardMin, standard.standardMax, standard.isCritical)
}
