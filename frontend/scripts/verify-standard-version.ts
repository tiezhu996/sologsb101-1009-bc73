/**
 * 集成验证（node + fake-indexeddb，不走浏览器）：
 * 1) 旧数据（v2）首次打开升级为初始版本，历史读数保留判定快照
 * 2) 新读数用最新标准；历史读数按巡检日期取版本
 * 3) 标准调整生成重算批次，故障注入下自动重试 / 手动重试恢复进度
 * 4) 重复派单幂等，不产生多余泄漏单
 * 5) 待处置 / 已处置泄漏单退回标准复核并挡住复检；已复检合格保留原结论
 * 运行：npx tsx scripts/verify-standard-version.ts
 */
import 'fake-indexeddb/auto'

// Node 环境垫片：db.ts 的故障注入开关使用 localStorage
const memoryStorage = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => (memoryStorage.has(key) ? memoryStorage.get(key)! : null),
    setItem: (key: string, value: string) => void memoryStorage.set(key, String(value)),
    removeItem: (key: string) => void memoryStorage.delete(key)
  }
})

import { DB_NAME, db } from '../src/utils/db'
import { judgeReading } from '../src/utils/range'
import { resolveStandardOn } from '../src/utils/standardVersion'
import {
  createStandardAdjustment,
  createInitialStandardVersion,
  putReading,
  resetDatabase,
  resumeInterruptedBatches,
  runRecalcBatch,
  type LeakRow,
  type PointRow,
  type ReadingRow
} from '../src/utils/db'
import { useLeakStore } from '../src/stores/leakStore'
import { readingDispatchKey } from '../src/types/leak'

let failures = 0
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures += 1
    console.error(`  ✗ ${message}`)
  }
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}

/* ---------- 场景一：旧 v2 数据升级 ---------- */

async function testLegacyUpgrade(): Promise<void> {
  console.log('\n[1] 旧数据首次打开升级为初始版本')
  await db.delete()

  // 用仅含 v2 表结构的临时 Dexie 写入旧数据
  const { Dexie } = await import('dexie')
  const legacy = new Dexie(DB_NAME)
  legacy.version(2).stores({
    stations: 'id, name, grade, updatedAt',
    devices: 'id, stationId, type, state, updatedAt',
    points: 'id, deviceId, stationId, name, isCritical, updatedAt',
    patrols: 'id, stationId, planDate, state, updatedAt',
    readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
    leaks: 'id, deviceId, stationId, state, handler, updatedAt'
  })
  await legacy.open()
  await legacy.table('stations').bulkPut([
    { id: 's1', name: '旧站', location: '', designFlowM3h: 0, inletPressureMpa: 0, grade: '高中压', commissionDate: '', createdAt: 1, updatedAt: 1 }
  ])
  await legacy.table('devices').bulkPut([
    { id: 'd1', stationId: 's1', type: '调压器', model: 'M', serialNo: 'SN', installDate: '', state: '运行', createdAt: 1, updatedAt: 1 }
  ])
  await legacy.table('points').bulkPut([
    { id: 'p1', deviceId: 'd1', stationId: 's1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: 1, updatedAt: 1 },
    { id: 'p2', deviceId: 'd1', stationId: 's1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: 1, updatedAt: 1 }
  ])
  await legacy.table('patrols').bulkPut([
    { id: 'pa-old', stationId: 's1', planDate: '2024-03-01', patrolDate: '2024-03-01', patrolman: '张', envNote: '', state: '已完成', createdAt: 1, updatedAt: 1 }
  ])
  const oldJudgement = judgeReading(0.41, 0.35, 0.45, true)
  await legacy.table('readings').bulkPut([
    { id: 'r1', patrolId: 'pa-old', pointId: 'p1', value: 0.41, isAbnormal: oldJudgement.isAbnormal, deviationPct: oldJudgement.deviationPct, note: '', createdAt: 1, updatedAt: 1 },
    { id: 'r2', patrolId: 'pa-old', pointId: 'p2', value: 68, isAbnormal: true, deviationPct: 36, note: '', createdAt: 1, updatedAt: 1 }
  ])
  await legacy.table('leaks').bulkPut([
    { id: 'l1', deviceId: 'd1', stationId: 's1', concentrationPpm: 68, foundTime: '2024-03-01', measure: '', state: '待处置', retestValuePpm: 0, handler: '', createdAt: 1, updatedAt: 1 }
  ])
  legacy.close()

  // 重新以 v3 打开，触发 upgrade
  await db.open()

  const versions = await db.standardVersions.where('pointId').equals('p1').toArray()
  assert(versions.length === 1, '点位 p1 生成 1 条初始版本')
  assert(versions[0].source === '初始版本', '初始版本来源为「初始版本」')
  assert(versions[0].effectiveDate <= '2024-03-01', '初始版本生效日不晚于最早巡检日期')

  const r1 = await db.readings.get('r1')
  assert(r1?.standardVersionId === versions[0].id, '历史读数 r1 关联初始版本')
  assert(r1?.judgeStandardMin === 0.35 && r1?.judgeStandardMax === 0.45, '历史读数 r1 固化判定标准快照')
  assert(r1?.isAbnormal === false, '历史读数 r1 保留当时判定结论（区间内，正常）')

  const l1 = await db.leaks.get('l1')
  assert(Boolean(l1?.dispatchKey), '旧泄漏单补派单幂等键')
  assert(l1?.sourceReadingId === 'r2', '旧泄漏单按浓度+日期回溯到来源读数 r2')
}

/* ---------- 场景二：新读数用最新版本，历史按巡检日期 ---------- */

async function testVersionResolution(): Promise<void> {
  console.log('\n[2] 历史读数按巡检日期取版本，新读数用最新值')
  await resetDb()
  await resetDatabase()
  // 重置后是播种库：pt-1 有 v1(0.35~0.45 @2024-01-01) 与 v2(0.40~0.45 @2024-06-10)
  const versions = await db.standardVersions.where('pointId').equals('pt-1').toArray()
  assert(versions.length === 2, '播种数据 pt-1 含 2 个标准版本')

  const rJune5 = await db.readings.get('rd-1') // 2024-06-05 巡检，读数 0.41
  const rJune12 = await db.readings.get('rd-4') // 2024-06-12 巡检，读数 0.38
  assert(rJune5?.judgeStandardMin === 0.35, '6/5 历史读数按旧版本（下限 0.35）判定')
  assert(rJune5?.isAbnormal === false, '6/5 读数 0.41 在旧版本下正常，结论保留')
  assert(rJune12?.judgeStandardMin === 0.4, '6/12 读数按新版本（下限 0.40）判定')
  assert(rJune12?.isAbnormal === true, '6/12 读数 0.38 在新版本下判异常')

  // 解析器单测
  const asc = [...versions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
  assert(resolveStandardOn(asc, '2024-06-05')?.standardMin === 0.35, 'resolveStandardOn(2024-06-05) 命中 v1')
  assert(resolveStandardOn(asc, '2024-06-10')?.standardMin === 0.4, 'resolveStandardOn(生效日当天) 命中 v2')
  assert(resolveStandardOn(asc, '')?.standardMin === 0.4, '无日期时 resolveStandardOn 取最新版本 v2')
}

/* ---------- 场景三：调整 → 重算批次 → 故障重试/恢复 → 泄漏单退回复核 ---------- */

async function testBatchAndReview(): Promise<void> {
  console.log('\n[3] 重算批次：自动重试、手动恢复、泄漏单退回复核')
  await resetDb()
  await resetDatabase()

  // 新建一个 ppm 点位（在 dv-1 上），产生一条新巡检读数
  const now = Date.now()
  const point: PointRow = {
    id: 'pt-test',
    deviceId: 'dv-1',
    stationId: 'st-1',
    name: '测试泄漏浓度',
    standardMin: 0,
    standardMax: 50,
    unit: 'ppm',
    isCritical: true,
    createdAt: now,
    updatedAt: now
  }
  await db.points.put(point)
  await createInitialStandardVersion({ id: point.id, stationId: 'st-1', standardMin: 0, standardMax: 50, isCritical: true, unit: 'ppm' })
  await db.patrols.put({
    id: 'pa-test',
    stationId: 'st-1',
    planDate: '2024-06-15',
    patrolDate: '2024-06-15',
    patrolman: '测试',
    envNote: '',
    state: '已完成',
    createdAt: now,
    updatedAt: now
  })
  const reading = await putReading({
    id: 'rd-test',
    patrolId: 'pa-test',
    pointId: point.id,
    value: 60,
    note: '',
    createdAt: now,
    updatedAt: now
  })
  assert(reading.isAbnormal === true, '读数 60 ppm 在旧标准（≤50）下判异常')

  // 派发一张泄漏单（待处置）
  const dispatched = await useLeakStore.getState().dispatchLeak({
    readingId: 'rd-test',
    deviceId: 'dv-1',
    stationId: 'st-1',
    concentrationPpm: 60,
    foundTime: '2024-06-15',
    measure: '测试派单'
  })
  assert(dispatched.created === true, '首次派发成功')
  const duplicate = await useLeakStore.getState().dispatchLeak({
    readingId: 'rd-test',
    deviceId: 'dv-1',
    stationId: 'st-1',
    concentrationPpm: 60,
    foundTime: '2024-06-15',
    measure: '重复派发'
  })
  assert(duplicate.created === false && duplicate.leak.id === dispatched.leak.id, '重复提交命中幂等键，不产生新泄漏单')

  // 调整标准：上限提高到 100（生效 2024-06-01，覆盖 6/15 历史读数）→ 60 ppm 变为正常
  const adjustment = await createStandardAdjustment(
    [{ pointId: point.id, standardMin: 0, standardMax: 100, isCritical: true }],
    { effectiveDate: '2024-06-01', reason: '测试放宽浓度上限' }
  )
  assert(adjustment !== null, '标准调整生成批次')
  const batchId = adjustment!.batchId

  // 故障注入：rd-test 首次失败一次（块内自动重试应恢复）
  localStorage.setItem('gbgaspress:recalc-fail', 'once:rd-test')
  const batch = await runRecalcBatch(batchId)
  assert(batch?.status === '已完成', '单条首次失败后自动重试，批次仍完成')
  assert(batch?.succeeded === 1 && batch.failed === 0, '失败项经自动重试后计入成功')

  const afterReading = await db.readings.get('rd-test')
  assert(afterReading?.isAbnormal === false, '重算后 60 ppm 在新标准（≤100）下判正常')
  assert(afterReading?.judgeStandardMax === 100, '读数判定快照刷新为新标准上限 100')

  const afterLeak = await db.leaks.get(dispatched.leak.id) as LeakRow
  assert(afterLeak.state === '标准复核', '原待处置泄漏单退回标准复核')
  assert(afterLeak.reviewFromState === '待处置', '记录退回前状态为待处置')

  // 标准复核态挡住复检
  const retestResult = await useLeakStore.getState().submitRetest(dispatched.leak.id, 20, '复检人')
  assert(retestResult === false, '标准复核态提交复检被拦截')
  const stillReview = await db.leaks.get(dispatched.leak.id)
  assert(stillReview?.state === '标准复核', '拦截复检后状态仍为标准复核')

  // 复核：误报关闭 → 已复检
  const leakId = dispatched.leak.id
  await useLeakStore.getState().resolveReview(leakId, '误报关闭', '班长', '新标准下不超标')
  const resolved = await db.leaks.get(leakId)
  assert(resolved?.state === '已复检', '误报关闭后处置单闭环为已复检')
}

/* ---------- 场景四：持续故障 → 部分失败 → 手动重试恢复 ---------- */

async function testPartialFailureResume(): Promise<void> {
  console.log('\n[4] 持续写入失败 → 部分失败 → 手动重试恢复进度')
  await resetDb()
  await resetDatabase()

  const now = Date.now()
  await db.points.put({ id: 'pt-fail', deviceId: 'dv-1', stationId: 'st-1', name: '故障点', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: now, updatedAt: now })
  await createInitialStandardVersion({ id: 'pt-fail', stationId: 'st-1', standardMin: 0, standardMax: 50, isCritical: true, unit: 'ppm' })
  await db.patrols.put({ id: 'pa-fail', stationId: 'st-1', planDate: '2024-06-15', patrolDate: '2024-06-15', patrolman: '', envNote: '', state: '已完成', createdAt: now, updatedAt: now })
  await putReading({ id: 'rd-fail', patrolId: 'pa-fail', pointId: 'pt-fail', value: 80, note: '', createdAt: now, updatedAt: now })

  const adj = await createStandardAdjustment(
    [{ pointId: 'pt-fail', standardMin: 0, standardMax: 100, isCritical: true }],
    { effectiveDate: '2024-06-01' }
  )
  const batchId = adj!.batchId

  localStorage.setItem('gbgaspress:recalc-fail', 'all')
  const failedBatch = await runRecalcBatch(batchId)
  assert(failedBatch?.status === '部分失败', '持续故障时批次标记为部分失败')
  assert(failedBatch?.failed === 1 && failedBatch.succeeded === 0, '失败 1 / 成功 0，进度已持久化')

  // 模拟刷新页面：resumeInterruptedBatches 在故障未消除时不应误标完成
  await resumeInterruptedBatches({ includeFailed: true })
  const stillFailed = await db.recalcBatches.get(batchId)
  assert(stillFailed?.status === '部分失败', '故障未消除时自动恢复不会丢失失败进度')

  // 故障消除后手动重试 → 完成
  localStorage.removeItem('gbgaspress:recalc-fail')
  await runRecalcBatch(batchId)
  const recovered = await db.recalcBatches.get(batchId)
  assert(recovered?.status === '已完成' && recovered.succeeded === 1, '故障消除后重试从断点恢复并完成')

  const reading = await db.readings.get('rd-fail') as ReadingRow
  assert(reading.judgeStandardMax === 100, '恢复后读数快照刷新为新标准')
}

/* ---------- 场景五：已复检合格的处置单不退回复核 ---------- */

async function testClosedLeakKept(): Promise<void> {
  console.log('\n[5] 已复检合格的处置单保留原结论')
  await resetDb()
  await resetDatabase()
  // 播种数据 lk-1（dv-1，已复检合格 32ppm，来源 rd-3，pt-3）
  const lk1Before = await db.leaks.get('lk-1')
  assert(lk1Before?.state === '已复检', '前置：lk-1 已复检')
  // 调整 pt-3（阀体泄漏浓度）上限，生效日早于 2024-06-05，触发 rd-3 重算
  const adj = await createStandardAdjustment(
    [{ pointId: 'pt-3', standardMin: 0, standardMax: 100, isCritical: true }],
    { effectiveDate: '2024-06-01', reason: '测试：已复检单不应退回' }
  )
  await runRecalcBatch(adj!.batchId)
  const lk1After = await db.leaks.get('lk-1')
  assert(lk1After?.state === '已复检', '已复检处置单未被退回，保留原结论')
  assert(lk1After?.retestValuePpm === 32, '复检合格值 32 ppm 保持不变')
}

/* ---------- 场景六：重复提交相同标准不产生版本/批次 ---------- */

async function testIdempotentAdjustment(): Promise<void> {
  console.log('\n[6] 相同标准重复提交不产生新版本')
  await resetDb()
  await resetDatabase()
  const before = await db.standardVersions.where('pointId').equals('pt-2').count()
  const point = (await db.points.get('pt-2'))!
  const noop = await createStandardAdjustment(
    [{ pointId: 'pt-2', standardMin: point.standardMin, standardMax: point.standardMax, isCritical: point.isCritical }],
    { effectiveDate: '2024-07-01' }
  )
  const after = await db.standardVersions.where('pointId').equals('pt-2').count()
  assert(noop === null, '与最新版本一致时返回 null')
  assert(before === after, '未写入多余标准版本')
  void readingDispatchKey
}

async function main(): Promise<void> {
  try {
    await testLegacyUpgrade()
    await testVersionResolution()
    await testBatchAndReview()
    await testPartialFailureResume()
    await testClosedLeakKept()
    await testIdempotentAdjustment()
  } catch (error) {
    failures += 1
    console.error('测试执行异常：', error)
  } finally {
    await db.close()
  }
  console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n${failures} 个断言失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
