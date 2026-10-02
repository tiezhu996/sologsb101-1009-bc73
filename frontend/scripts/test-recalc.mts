/**
 * 端到端逻辑验证（node + tsx + fake-indexeddb）：
 * 1. 标准版本化：历史读数按巡检日期取版本，新读数取最新版本
 * 2. 重算批次：分块检查点、失败后续算恢复进度
 * 3. 重复提交幂等：不新增版本、不新增泄漏单
 * 4. 泄漏单：待处置/已处置退回标准复核并挡住复检；已复检合格保留结论
 * 5. 旧 v2 数据首次打开升级为初始版本，读数快照回填
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db, initDatabase, DB_VERSION, putReading } from '../src/utils/db.ts'
import { submitStandardAdjustments, resumeRecalcBatch, RECALC_CHUNK_SIZE } from '../src/utils/recalc.ts'

let passed = 0
function check(name: string, cond: boolean, detail = ''): void {
  assert.ok(cond, `${name} ${detail}`)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.close()
}

/* ---------------- 场景 1：版本化判定 + 泄漏单复核 ---------------- */
async function scenarioVersioningAndReview(): Promise<void> {
  console.log('场景1：播种 → 标准调整 → 版本化判定 → 泄漏单复核')
  await resetDb()
  await initDatabase()
  check('数据库版本为 v3', DB_VERSION === 3)

  const versionsOfPt5 = await db.standardVersions.where('pointId').equals('pt-5').toArray()
  check('每个点位播种一条初始版本', versionsOfPt5.length === 1)
  check('初始版本生效日期为 2024-05-01', versionsOfPt5[0].effectiveDate === '2024-05-01')

  const rd7 = await db.readings.get('rd-7')
  check('历史读数回填判定版本', rd7.standardVersionId === 'pt-5:2024-05-01')
  check('历史读数快照为旧标准 0~50', rd7.judgedMin === 0 && rd7.judgedMax === 50)
  check('历史读数 rd-7（55ppm）判异常', rd7.isAbnormal === true)
  check('历史读数判定日期为巡检日期 2024-06-12', rd7.judgedDate === '2024-06-12')

  // 已复检合格的 lk-1 保持结论；lk-2 已处置、lk-3 待处置
  const lk1Before = await db.leaks.get('lk-1')
  const lk2Before = await db.leaks.get('lk-2')
  check('播种泄漏单带来源读数', lk1Before.sourceReadingId === 'rd-3')
  check('lk-2 初始为已处置', lk2Before.state === '已处置')

  // 法兰泄漏浓度标准放宽到 80ppm，2024-06-01 起生效（rd-7 55ppm 将变为正常）
  const result = await submitStandardAdjustments([
    { pointId: 'pt-5', effectiveDate: '2024-06-01', standardMin: 0, standardMax: 80, isCritical: false }
  ])
  check('调整批次成功', result.batch.status === 'succeeded')
  check('批次冻结并处理了 rd-7', result.batch.readingIds.includes('rd-7'))

  const rd7After = await db.readings.get('rd-7')
  check('rd-7 按新标准重判为正常', rd7After.isAbnormal === false && rd7After.deviationPct === 0)
  check('rd-7 记录重算批次', rd7After.recalcBatchId === result.batch.id)

  const pt5Versions = await db.standardVersions.where('pointId').equals('pt-5').toArray()
  check('pt-5 现有两个版本（初始 + 调整）', pt5Versions.length === 2)

  const pt5 = await db.points.get('pt-5')
  check('点位档案更新为最新标准 80', pt5.standardMax === 80)

  const lk1 = await db.leaks.get('lk-1')
  check('已复检合格 lk-1 保留原结论（不退回）', lk1.state === '已复检' && lk1.retestValuePpm === 32)

  const lk2 = await db.leaks.get('lk-2')
  check('已处置 lk-2 退回标准复核', lk2.state === '标准复核')
  check('复核单记住退回前状态', lk2.stateBeforeReview === '已处置')
  check('退回批次记录复核泄漏单', result.batch.reviewedLeakIds.includes('lk-2'))

  // 复检被挡住（等待 store 的 liveQuery 回流）
  const { useLeakStore } = await import('../src/stores/leakStore.ts')
  const waitForLeaks = async (count: number, timeoutMs = 3000): Promise<void> => {
    const start = Date.now()
    while (useLeakStore.getState().leaks.length < count && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  await waitForLeaks(3)
  let blocked = false
  try {
    await useLeakStore.getState().submitRetest('lk-2', 10, '李娜')
  } catch {
    blocked = true
  }
  check('标准复核中的处置单挡住复检', blocked)
  const lk2Still = await db.leaks.get('lk-2')
  check('挡住后状态仍为标准复核', lk2Still.state === '标准复核')

  // 复核确认后恢复
  const { resolveLeakReview } = await import('../src/utils/recalc.ts')
  await resolveLeakReview('lk-2', 'confirm', { handler: '王强', measure: '新标准下仍需关注，维持处置' })
  const lk2Resumed = await db.leaks.get('lk-2')
  check('复核确认恢复为已处置', lk2Resumed.state === '已处置')
  // 恢复后复检入口不再被挡：store 快照同步后可提交复检
  useLeakStore.setState({ leaks: await db.leaks.toArray() })
  const afterRetest = await useLeakStore.getState().submitRetest('lk-2', 20, '王强')
  check('复核恢复后可正常复检且判合格', afterRetest === true)
  const lk2Closed = await db.leaks.get('lk-2')
  check('复检完成闭环为已复检', lk2Closed.state === '已复检' && lk2Closed.retestValuePpm === 20)

  // 再调整 pt-10（dv-4，lk-3 来源读数 rd-11 所在设备）验证「待处置」退回
  await submitStandardAdjustments([
    { pointId: 'pt-10', effectiveDate: '2024-06-01', standardMin: 0, standardMax: 50, isCritical: true }
  ])
  const lk3 = await db.leaks.get('lk-3')
  check('待处置 lk-3 退回标准复核', lk3.state === '标准复核' && lk3.stateBeforeReview === '待处置')
  await resolveLeakReview('lk-3', 'invalidate', { handler: '王强' })
  const lk3Closed = await db.leaks.get('lk-3')
  check('复核关闭原单置为已复检（记录保留）', lk3Closed.state === '已复检' && lk3Closed.concentrationPpm === 88)

  // 无关设备的待处置单（如有）不应被牵连：dv-3 上没有泄漏单，跳过该项

  /* 新读数取最新版本：给 pt-5 录一条 70ppm 的新巡检读数（今天）→ 新标准下正常 */
  const { createId } = await import('../src/utils/db.ts')
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  await db.patrols.put({
    id: 'pa-new',
    stationId: 'st-1',
    planDate: today,
    patrolDate: today,
    patrolman: '新人',
    envNote: '',
    state: '已完成',
    createdAt: now,
    updatedAt: now
  })
  const newReading = await putReading({
    id: createId('rd'),
    patrolId: 'pa-new',
    pointId: 'pt-5',
    value: 70,
    note: '',
    createdAt: now,
    updatedAt: now
  })
  check('新读数（70ppm）按最新标准 80 判正常', newReading.isAbnormal === false)
  check('新读数命中调整版本', newReading.standardVersionId === 'pt-5:2024-06-01')

  // 历史日期补录读数：2024-05-10 的 70ppm 读数应按旧标准 50 判异常
  await db.patrols.put({
    id: 'pa-old',
    stationId: 'st-1',
    planDate: '2024-05-10',
    patrolDate: '2024-05-10',
    patrolman: '张伟',
    envNote: '',
    state: '已完成',
    createdAt: now,
    updatedAt: now
  })
  const oldReading = await putReading({
    id: createId('rd'),
    patrolId: 'pa-old',
    pointId: 'pt-5',
    value: 70,
    note: '补录历史',
    createdAt: now,
    updatedAt: now
  })
  check('历史日期补录（70ppm）按旧标准 50 判异常', oldReading.isAbnormal === true)
  check('历史补录命中初始版本', oldReading.standardVersionId === 'pt-5:2024-05-01')
}

/* ---------------- 场景 2：重复提交幂等 ---------------- */
async function scenarioIdempotent(): Promise<void> {
  console.log('场景2：重复提交不新增版本、不新增泄漏单')
  await resetDb()
  await initDatabase()

  const input = { pointId: 'pt-3', effectiveDate: '2024-06-01', standardMin: 0, standardMax: 60, isCritical: true }
  const first = await submitStandardAdjustments([input])
  const leaksAfterFirst = await db.leaks.toArray()

  // 再次提交完全一致的调整
  const second = await submitStandardAdjustments([{ ...input }])
  check('重复提交复用同一批次', second.batch.id === first.batch.id && second.reused === true)
  const versions = await db.standardVersions.where('pointId').equals('pt-3').toArray()
  check('pt-3 仍只有两个版本（无重复版本）', versions.length === 2)
  const leaksAfterSecond = await db.leaks.toArray()
  check('重复提交不新增泄漏单', leaksAfterSecond.length === leaksAfterFirst.length)

  // 第三次提交（成功批次）直接原样返回
  const third = await submitStandardAdjustments([{ ...input }])
  check('成功批次的重复提交不再执行重算', third.attempted === false && third.batch.id === first.batch.id)

  // 同读数派单幂等（db 层：sourceReadingId 唯一）
  const { dispatchLeakForReading } = await import('../src/utils/db.ts')
  const pt3 = await db.points.get('pt-3')
  const rd3 = await db.readings.get('rd-3')
  const before = await db.leaks.count()
  const d1 = await dispatchLeakForReading({
    reading: rd3,
    point: pt3,
    foundTime: rd3.judgedDate,
    measure: '幂等派单测试',
    recalcBatchId: ''
  })
  check('rd-3 已有泄漏单（lk-1），派单直接复用', d1.duplicated === true && d1.leak.id === 'lk-1')
  const d2 = await dispatchLeakForReading({
    reading: rd3,
    point: pt3,
    foundTime: rd3.judgedDate,
    measure: '再次派单',
    recalcBatchId: ''
  })
  check('再次派单仍命中同一张单', d2.duplicated === true && d2.leak.id === 'lk-1')
  const after = await db.leaks.count()
  check('幂等派单后泄漏单数量不变', after === before)
}

/* ---------------- 场景 3：批次失败 → 重试续算恢复进度 ---------------- */
async function scenarioFailureResume(): Promise<void> {
  console.log('场景3：写入失败后重试，从检查点恢复进度')
  await resetDb()
  await initDatabase()

  // 准备足够多的读数：给 pt-1 在 2024-06 新建多条巡检读数
  const now = Date.now()
  for (let i = 0; i < 12; i += 1) {
    const date = `2024-06-${String(10 + i).padStart(2, '0')}`
    const patrolId = `pa-t${i}`
    await db.patrols.put({
      id: patrolId,
      stationId: 'st-1',
      planDate: date,
      patrolDate: date,
      patrolman: '测试',
      envNote: '',
      state: '已完成',
      createdAt: now,
      updatedAt: now
    })
    await db.readings.put({
      id: `rd-t${i}`,
      patrolId,
      pointId: 'pt-1',
      value: 0.41,
      isAbnormal: false,
      deviationPct: 0,
      note: '',
      standardVersionId: 'pt-1:2024-05-01',
      judgedMin: 0.35,
      judgedMax: 0.45,
      judgedCritical: true,
      judgedDate: date,
      recalcBatchId: '',
      createdAt: now,
      updatedAt: now
    })
  }
  check('分块大小为 5（12 条读数需 3 块）', RECALC_CHUNK_SIZE === 5)

  // 开启“第二块失败”自检开关后提交（新标准 0.2~0.5：0.41 仍正常，不触发派单）
  globalThis.window = globalThis.window ?? {}
  ;(globalThis as { window: { __gbgaspressFailNextRecalcChunk?: boolean } }).window.__gbgaspressFailNextRecalcChunk = true
  let failed = false
  let batchId = ''
  try {
    const r = await submitStandardAdjustments([
      { pointId: 'pt-1', effectiveDate: '2024-06-01', standardMin: 0.2, standardMax: 0.5, isCritical: true }
    ])
    batchId = r.batch.id
  } catch (error) {
    failed = true
    batchId = (error as { batch?: { id: string } }).batch?.id ?? ''
  }
  check('批次在第二块写入失败并抛错', failed)
  const failedBatch = await db.recalcBatches.get(batchId)
  check('失败批次状态为 failed', failedBatch.status === 'failed')
  check('检查点停在第一块（processedCount = 5）', failedBatch.processedCount === 5)
  check('失败原因已记录', failedBatch.failReason.length > 0)

  // 前 5 条已按新版本重算并保留
  const firstDone = await db.readings.get('rd-t0')
  check('第一块读数已按新版本重算（0.2~0.5）', firstDone.judgedMin === 0.2 && firstDone.judgedMax === 0.5)
  const notDone = await db.readings.get('rd-t6')
  check('第二块读数未被重算（保留旧快照 0.35~0.45）', notDone.judgedMax === 0.45)

  // 重试续算
  const resumed = await resumeRecalcBatch(batchId)
  check('续算后批次成功', resumed.status === 'succeeded')
  check('续算后处理完全部读数', resumed.processedCount === resumed.readingIds.length)
  const lastOne = await db.readings.get('rd-t11')
  check('最后一块读数已重算为新版本', lastOne.judgedMin === 0.2 && lastOne.judgedMax === 0.5)

  // 再次重试成功批次是空操作
  const again = await resumeRecalcBatch(batchId)
  check('成功批次再次续算为空操作', again.status === 'succeeded' && again.processedCount === again.readingIds.length)
}

/* ---------------- 场景 4：旧 v2 库升级 ---------------- */
async function scenarioV2Upgrade(): Promise<void> {
  console.log('场景4：旧 v2 数据首次打开升级为初始版本')
  await resetDb()

  // 手工以 v2 schema 建旧库（无 standardVersions/recalcBatches，读数无快照列，泄漏无来源列）
  await db.close()

  const { Dexie } = await import('dexie')
  const old = new Dexie('gbgaspress')
  old.version(2).stores({
    stations: 'id, name, grade, updatedAt',
    devices: 'id, stationId, type, state, updatedAt',
    points: 'id, deviceId, stationId, name, isCritical, updatedAt',
    patrols: 'id, stationId, planDate, state, updatedAt',
    readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
    leaks: 'id, deviceId, stationId, state, handler, updatedAt'
  })
  await old.table('stations').put({ id: 's1', name: '旧站', location: '', designFlowM3h: 0, inletPressureMpa: 0, grade: '高中压', commissionDate: '', createdAt: 1, updatedAt: 1 })
  await old.table('devices').put({ id: 'd1', stationId: 's1', type: '调压器', model: 'M', serialNo: 'SN', installDate: '', state: '运行', createdAt: 1, updatedAt: 1 })
  await old.table('points').put({ id: 'p1', deviceId: 'd1', stationId: 's1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: 1, updatedAt: 1 })
  await old.table('patrols').put({ id: 'g1', stationId: 's1', planDate: '2024-03-01', patrolDate: '2024-03-01', patrolman: '赵', envNote: '', state: '已完成', createdAt: 1, updatedAt: 1 })
  await old.table('readings').put({ id: 'r1', patrolId: 'g1', pointId: 'p1', value: 0.28, isAbnormal: true, deviationPct: 12, note: '旧读数', createdAt: 1, updatedAt: 1 })
  await old.table('leaks').put({ id: 'x1', deviceId: 'd1', stationId: 's1', concentrationPpm: 60, foundTime: '2024-03-01', measure: '旧单', state: '待处置', retestValuePpm: 0, handler: '赵', createdAt: 1, updatedAt: 1 })
  await old.close()

  // 重新打开主 db 实例触发 v3 upgrade
  await db.open()
  check('旧库已升级到 v3', db.verno === 3)

  const versions = await db.standardVersions.toArray()
  check('旧点位升级出 1 条初始版本', versions.length === 1)
  check('初始版本来源标记为 initial', versions[0].source === 'initial')
  check('初始版本标准取自旧点位', versions[0].standardMax === 0.25)

  const reading = await db.readings.get('r1')
  check('旧读数回填版本 id', reading.standardVersionId === 'p1:2024-05-01')
  check('旧读数回填判定快照', reading.judgedMin === 0.18 && reading.judgedMax === 0.25 && reading.judgedCritical === true)
  check('旧读数回填判定日期', reading.judgedDate === '2024-03-01')
  check('旧读数按初始版本重算后仍异常', reading.isAbnormal === true)

  const leak = await db.leaks.get('x1')
  check('旧泄漏单补齐来源字段且状态不被改动', leak.sourceReadingId === '' && leak.state === '待处置')
}

async function main(): Promise<void> {
  try {
    await scenarioVersioningAndReview()
    await scenarioIdempotent()
    await scenarioFailureResume()
    await scenarioV2Upgrade()
    console.log(`\n全部通过：${passed} 项断言`)
  } catch (error) {
    console.error('\n测试失败：', error)
    process.exitCode = 1
  } finally {
    await db.close()
  }
}

void main()
