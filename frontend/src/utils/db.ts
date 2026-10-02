/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 点位标准值版本化（standardVersions）：历史读数按巡检日期取生效版本
 * - 标准调整重算批次（recalcBatches）：分块检查点、失败可续算、泄漏单幂等派发
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { StandardVersion } from '@/types/standardVersion'
import { INITIAL_VERSION_DATE, standardVersionId } from '@/types/standardVersion'
import type { RecalcBatch, RecalcPointChange } from '@/types/recalc'
import { judgeReading, type ReadingJudgement } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  standardVersions: StandardVersion[]
  recalcBatches: RecalcBatch[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type StandardVersionRow = StandardVersion & Revisioned
export type RecalcBatchRow = RecalcBatch & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  standardVersions!: Table<StandardVersionRow, string>
  recalcBatches!: Table<RecalcBatchRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：标准值版本化 + 重算批次
    // - 旧点位标准值升级为 initial 初始版本（生效日期早于全部历史巡检）
    // - 历史读数回填判定时标准快照（standardVersionId / judgedMin / judgedMax / judgedCritical / judgedDate）
    // - 泄漏单补来源读数等审计列；新增 standardVersions、recalcBatches 两张表
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, standardVersionId, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, sourceReadingId, updatedAt',
        standardVersions: 'id, pointId, deviceId, effectiveDate, versionNo, recalcBatchId',
        recalcBatches: 'id, status, idempotencyKey, effectiveDate, createdAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        for (const name of [
          'stations',
          'devices',
          'points',
          'patrols',
          'readings',
          'leaks',
          'standardVersions',
          'recalcBatches'
        ]) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        const points = (await tx.table('points').toArray()) as PointRow[]
        const patrols = (await tx.table('patrols').toArray()) as PatrolRow[]
        const patrolDateOf = new Map(
          patrols.map((patrol) => [patrol.id, patrol.patrolDate || patrol.planDate || ''])
        )

        // 旧数据首次打开：每个点位升级一条 initial 初始版本
        const initialVersions: StandardVersionRow[] = points.map((point) => ({
          id: standardVersionId(point.id, INITIAL_VERSION_DATE),
          versionNo: 1,
          pointId: point.id,
          deviceId: point.deviceId,
          stationId: point.stationId,
          effectiveDate: INITIAL_VERSION_DATE,
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          unit: point.unit,
          isCritical: point.isCritical,
          source: 'initial',
          recalcBatchId: '',
          note: '旧数据首次打开升级的初始版本',
          createdAt: point.createdAt || now,
          updatedAt: now,
          revision: ROW_REVISION
        }))
        if (initialVersions.length > 0) {
          await tx.table('standardVersions').bulkPut(initialVersions)
        }
        const versionOfPoint = new Map(initialVersions.map((version) => [version.pointId, version]))

        // 历史读数回填判定时标准快照，按巡检日期取版本（初始版本对全部历史日期生效）
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            const pointId = String(reading.pointId)
            const version = versionOfPoint.get(pointId)
            const judgedDate = patrolDateOf.get(String(reading.patrolId)) ?? ''
            const value = Number(reading.value)
            if (version) {
              const judgement = judgeReading(value, version.standardMin, version.standardMax, version.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
              reading.standardVersionId = version.id
              reading.judgedMin = version.standardMin
              reading.judgedMax = version.standardMax
              reading.judgedCritical = version.isCritical
            } else {
              reading.standardVersionId = ''
              reading.judgedMin = Number(reading.judgedMin ?? 0)
              reading.judgedMax = Number(reading.judgedMax ?? 1)
              reading.judgedCritical = reading.judgedCritical === true
            }
            reading.judgedDate = judgedDate
            reading.recalcBatchId = ''
          })

        // 泄漏单补审计列；旧三态保持不变（已复检合格结论保留）
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.sourceReadingId !== 'string') leak.sourceReadingId = ''
            if (typeof leak.recalcBatchId !== 'string') leak.recalcBatchId = ''
            if (typeof leak.stateBeforeReview !== 'string') leak.stateBeforeReview = ''
            if (typeof leak.reviewReason !== 'string') leak.reviewReason = ''
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ====================== 标准版本选取（按日期生效） ====================== */

export type StandardVersionMap = Map<string, StandardVersionRow[]>

/** 判定一条读数时命中的标准快照 */
export interface ReadingStandardSnapshot {
  standardVersionId: string
  judgedMin: number
  judgedMax: number
  judgedCritical: boolean
}

export function buildStandardVersionMaps(versions: StandardVersionRow[]): StandardVersionMap {
  const map: StandardVersionMap = new Map()
  versions.forEach((version) => {
    const list = map.get(version.pointId) ?? []
    list.push(version)
    map.set(version.pointId, list)
  })
  map.forEach((list) => {
    list.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.versionNo - b.versionNo)
  })
  return map
}

/** 取某点位在指定日期生效的版本：生效日期 ≤ 判定日期 的最新版本；早于首版时兜底首版 */
export function pickEffectiveVersion(
  versions: StandardVersionRow[] | undefined,
  date: string
): StandardVersionRow | null {
  if (!versions || versions.length === 0) return null
  if (!date) return versions[versions.length - 1]
  let candidate: StandardVersionRow | null = null
  for (const version of versions) {
    if (version.effectiveDate <= date) candidate = version
    else break
  }
  return candidate ?? versions[0]
}

export function latestStandardVersion(versions: StandardVersionRow[] | undefined): StandardVersionRow | null {
  if (!versions || versions.length === 0) return null
  return versions[versions.length - 1]
}

function snapshotOf(version: StandardVersionRow | null): ReadingStandardSnapshot {
  return version
    ? {
        standardVersionId: version.id,
        judgedMin: version.standardMin,
        judgedMax: version.standardMax,
        judgedCritical: version.isCritical
      }
    : { standardVersionId: '', judgedMin: 0, judgedMax: 1, judgedCritical: false }
}

export interface JudgeResult extends ReadingJudgement, ReadingStandardSnapshot {}

/** 按版本快照判定读数（历史读数按巡检日期、新读数取最新版本都走这里） */
export function judgeWithVersion(
  value: number,
  version: StandardVersionRow | null,
  fallback?: Pick<Point, 'standardMin' | 'standardMax' | 'isCritical'>
): JudgeResult {
  const min = version ? version.standardMin : fallback?.standardMin ?? 0
  const max = version ? version.standardMax : fallback?.standardMax ?? 1
  const critical = version ? version.isCritical : fallback?.isCritical ?? false
  const judgement = judgeReading(value, min, max, critical)
  return { ...judgement, ...snapshotOf(version) }
}

/** 读数判定日期：实际巡检日期优先，未完成时取计划日期 */
export function judgeDateOfPatrol(patrol: Pick<Patrol, 'patrolDate' | 'planDate'> | undefined): string {
  if (!patrol) return ''
  return patrol.patrolDate || patrol.planDate || ''
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注, 来源泄漏单] */
const SEED_READING_ROWS: Array<[string, string, number, string, string]> = [
  ['pa-1', 'pt-1', 0.41, '', ''],
  ['pa-1', 'pt-2', 0.23, '', ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味', 'lk-1'],
  ['pa-2', 'pt-1', 0.38, '', ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度', ''],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹', ''],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏', 'lk-2'],
  ['pa-4', 'pt-7', 0.21, '', ''],
  ['pa-4', 'pt-8', 0.145, '', ''],
  ['pa-4', 'pt-9', 12, '', ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高', 'lk-3']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', sourceReadingId: 'rd-3', recalcBatchId: '', stateBeforeReview: '', reviewReason: '', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', sourceReadingId: 'rd-7', recalcBatchId: '', stateBeforeReview: '', reviewReason: '', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', sourceReadingId: 'rd-11', recalcBatchId: '', stateBeforeReview: '', reviewReason: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

/** 播种数据的初始标准版本：每个点位一条 initial 版本 */
function buildSeedStandardVersions(): StandardVersionRow[] {
  return SEED_POINTS.map((point) => ({
    id: standardVersionId(point.id, INITIAL_VERSION_DATE),
    versionNo: 1,
    pointId: point.id,
    deviceId: point.deviceId,
    stationId: point.stationId,
    effectiveDate: INITIAL_VERSION_DATE,
    standardMin: point.standardMin,
    standardMax: point.standardMax,
    unit: point.unit,
    isCritical: point.isCritical,
    source: 'initial',
    recalcBatchId: '',
    note: '初始版本（演示数据）',
    createdAt: point.createdAt,
    updatedAt: point.updatedAt,
    revision: ROW_REVISION
  }))
}

/** 由原始行派生偏差率、异常标记与判定时标准快照 */
function buildSeedReadings(versions: StandardVersionRow[]): ReadingRow[] {
  const versionMaps = buildStandardVersionMaps(versions)
  const patrolDateOf = new Map(SEED_PATROLS.map((patrol) => [patrol.id, patrol.patrolDate || patrol.planDate]))
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgedDate = patrolDateOf.get(patrolId) ?? ''
    const version = pickEffectiveVersion(versionMaps.get(pointId), judgedDate)
    const judgement = version
      ? judgeWithVersion(value, version)
      : judgeWithVersion(value, null, point ? { standardMin: point.standardMin, standardMax: point.standardMax, isCritical: point.isCritical } : undefined)
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      standardVersionId: judgement.standardVersionId,
      judgedMin: judgement.judgedMin,
      judgedMax: judgement.judgedMax,
      judgedCritical: judgement.judgedCritical,
      judgedDate,
      recalcBatchId: '',
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  const versions = buildSeedStandardVersions()
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.recalcBatches
      ],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.standardVersions.bulkPut(versions)
    await db.readings.bulkPut(buildSeedReadings(versions))
    await db.leaks.bulkPut(SEED_LEAKS)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.recalcBatches
      ],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.recalcBatches
      ],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.points, db.readings, db.standardVersions],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.standardVersions.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.patrols, db.readings],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  const pointIds = (await db.points.where('deviceId').anyOf(deviceIds).toArray()).map((point) => point.id)
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
  if (pointIds.length > 0) {
    await db.readings.where('pointId').anyOf(pointIds).delete()
    await db.standardVersions.where('pointId').anyOf(pointIds).delete()
  }
  await db.points.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

export interface ReadingPutInput {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}

/** 按巡检日期取生效版本判定一批读数（新读数的巡检日期通常为今天，命中最新版本） */
export async function judgeReadingsByDate(
  inputs: Array<{ pointId: string; date: string; value: number }>
): Promise<JudgeResult[]> {
  const versions = await db.standardVersions.toArray()
  const maps = buildStandardVersionMaps(versions)
  return inputs.map((input) => judgeWithVersion(input.value, pickEffectiveVersion(maps.get(input.pointId), input.date)))
}

/** 写入读数：自动按巡检日期匹配生效标准版本，落判定快照 */
export async function putReading(row: ReadingPutInput): Promise<ReadingRow> {
  const patrol = await db.patrols.get(row.patrolId)
  const [judgement] = await judgeReadingsByDate([
    { pointId: row.pointId, date: judgeDateOfPatrol(patrol), value: row.value }
  ])
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    standardVersionId: judgement.standardVersionId,
    judgedMin: judgement.judgedMin,
    judgedMax: judgement.judgedMax,
    judgedCritical: judgement.judgedCritical,
    judgedDate: judgeDateOfPatrol(patrol),
    recalcBatchId: '',
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/** 批量写入读数：一次加载全部版本与巡检，逐行按生效版本判定 */
export async function putReadingRows(rows: ReadingPutInput[]): Promise<ReadingRow[]> {
  if (rows.length === 0) return []
  const patrols = await db.patrols.bulkGet(rows.map((row) => row.patrolId))
  const patrolMap = new Map(rows.map((row, index) => [row.id, patrols[index]]))
  const judgements = await judgeReadingsByDate(
    rows.map((row) => ({
      pointId: row.pointId,
      date: judgeDateOfPatrol(patrolMap.get(row.id)),
      value: row.value
    }))
  )
  const next: ReadingRow[] = rows.map((row, index) => {
    const judgement = judgements[index]
    return {
      ...row,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      standardVersionId: judgement.standardVersionId,
      judgedMin: judgement.judgedMin,
      judgedMax: judgement.judgedMax,
      judgedCritical: judgement.judgedCritical,
      judgedDate: judgeDateOfPatrol(patrolMap.get(row.id)),
      recalcBatchId: '',
      revision: ROW_REVISION
    }
  })
  await db.readings.bulkPut(next)
  return next
}

/* ==================== 泄漏单幂等派发 / 标准复核 ==================== */

export interface DispatchLeakInput {
  reading: ReadingRow
  point: Pick<Point, 'id' | 'deviceId' | 'stationId' | 'name' | 'unit'>
  foundTime: string
  measure: string
  recalcBatchId: string
}

export interface DispatchLeakResult {
  leak: LeakRow
  /** true 表示该读数此前已派发过，本次直接复用，未新增泄漏单 */
  duplicated: boolean
}

/**
 * 按来源读数幂等派发泄漏处置单：
 * 同一条读数（sourceReadingId）全局只允许一张泄漏单，重复提交/重算续跑不会多出单子。
 */
export async function dispatchLeakForReading(input: DispatchLeakInput): Promise<DispatchLeakResult> {
  const { reading, point, foundTime, measure, recalcBatchId } = input
  const existing = await db.leaks.where('sourceReadingId').equals(reading.id).first()
  if (existing) return { leak: existing, duplicated: true }
  const now = Date.now()
  const row: LeakRow = {
    id: createId('lk'),
    deviceId: point.deviceId,
    stationId: point.stationId,
    concentrationPpm: reading.value,
    foundTime: foundTime || new Date().toISOString().slice(0, 10),
    measure,
    state: '待处置',
    retestValuePpm: 0,
    handler: '',
    sourceReadingId: reading.id,
    recalcBatchId,
    stateBeforeReview: '',
    reviewReason: '',
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.leaks.put(row)
  return { leak: row, duplicated: false }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.standardVersions.count(),
    db.recalcBatches.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions, recalcBatches] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.standardVersions.toArray(),
    db.recalcBatches.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    standardVersions: standardVersions.map(strip),
    recalcBatches: recalcBatches.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.recalcBatches
      ],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.standardVersions.clear(),
      db.recalcBatches.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.standardVersions.bulkPut((payload.standardVersions ?? []).map(rev))
    await db.recalcBatches.bulkPut((payload.recalcBatches ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.standardVersions,
        db.recalcBatches
      ],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.standardVersions.clear(),
      db.recalcBatches.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

export type { RecalcBatch, RecalcPointChange }
