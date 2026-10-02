/**
 * /points 巡检点位与标准值配置
 * 标准值版本化：点位保存当前生效标准；班组交接调整走草稿 → 选生效日期 → 生成新版本 + 重算批次。
 * 历史读数按巡检日期取当时版本，新读数用最新值；页面可追溯每个点位的版本历史与重算进度。
 * 消费 Point、Device、StandardVersion、RecalcBatch；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<AbnormalTag>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useStandardStore } from '@/stores/standardStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ReadingRow, type RecalcBatchRow } from '@/utils/db'
import {
  EMPTY_POINT_DRAFT,
  POINT_TEMPLATES,
  POINT_UNITS,
  type Point,
  type PointDraft,
  type PointTemplate
} from '@/types/point'
import type { StandardVersion } from '@/types/standard'
import { DEVICE_TYPES } from '@/types/device'
import { abnormalLevelOf, rangeText } from '@/utils/range'
import { recalcProgressPercent } from '@/types/standard'

export default function PointConfig() {
  const stationStore = useStationStore()
  const standardStore = useStandardStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })

  const [pointForm] = Form.useForm<PointDraft>()
  const [templateForm] = Form.useForm<{ deviceId: string }>()
  const [pointOpen, setPointOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkedTemplates, setCheckedTemplates] = useState<string[]>(POINT_TEMPLATES.map((item) => item.name))
  const [historyPoint, setHistoryPoint] = useState<Point | null>(null)
  const [committing, setCommitting] = useState(false)

  const filter = stationStore.pointFilter
  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword: filter.keyword,
    stationId: filter.stationId,
    deviceTypes: filter.deviceTypes
  }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchPointFilter({
      keyword: String(next.keyword ?? ''),
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as string[]
    })
  }

  const rows = stationStore.points.filter((point) => {
    if (filter.stationId && point.stationId !== filter.stationId) return false
    if (filter.onlyCritical && !point.isCritical) return false
    if (filter.deviceTypes.length > 0) {
      const device = stationStore.devices.find((item) => item.id === point.deviceId)
      if (!device || !filter.deviceTypes.includes(device.type)) return false
    }
    const text = filter.keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === point.deviceId)
    return point.name.toLowerCase().includes(text) || (device ? device.model.toLowerCase().includes(text) : false)
  })

  const abnormalCountOf = (pointId: string): number =>
    readingTable.rows.filter((row) => row.pointId === pointId && row.isAbnormal).length

  const deviceOptions = stationStore.devices
    .filter((device) => !filter.stationId || device.stationId === filter.stationId)
    .map((device) => {
      const station = stationStore.stations.find((item) => item.id === device.stationId)
      return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
    })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先在调压站台账登记设备')
      return
    }
    setEditingId(null)
    pointForm.setFieldsValue({ ...EMPTY_POINT_DRAFT, deviceId: deviceOptions[0].value })
    setPointOpen(true)
  }

  const openEdit = (point: Point): void => {
    setEditingId(point.id)
    // 标准上下限 / 关键点不允许在编辑里直接覆盖，只能走「班组交接调整」
    pointForm.setFieldsValue({
      deviceId: point.deviceId,
      name: point.name,
      standardMin: point.standardMin,
      standardMax: point.standardMax,
      unit: point.unit,
      isCritical: point.isCritical
    })
    setPointOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await pointForm.validate().catch(() => null)
    if (!values) return
    if (editingId) {
      await stationStore.updatePoint(editingId, {
        deviceId: values.deviceId,
        name: values.name,
        unit: values.unit
      })
      Message.success('点位信息已更新；标准上下限请通过「班组交接调整」生成新版本')
    } else {
      const payload: PointDraft = {
        ...values,
        standardMin: Math.min(values.standardMin, values.standardMax),
        standardMax: Math.max(values.standardMin, values.standardMax)
      }
      await stationStore.createPoint(payload)
      Message.success('点位已创建，并生成生效日为今天的初始标准版本')
    }
    setPointOpen(false)
  }

  const remove = async (point: Point): Promise<void> => {
    await stationStore.removePoint(point.id)
    standardStore.clearDraft(point.id)
    Message.success('点位及其读数、标准版本已删除')
  }

  const changedIds = standardStore.changedPointIds()

  const commitAll = async (): Promise<void> => {
    if (changedIds.length === 0) {
      Message.warning('没有与当前标准值不同的草稿')
      return
    }
    if (!standardStore.effectiveDate) {
      Message.warning('请选择新版本的生效日期')
      return
    }
    setCommitting(true)
    try {
      const result = await standardStore.commitDrafts()
      if (!result) {
        Message.info('草稿与最新版本一致，未生成新版本（重复提交已忽略）')
        return
      }
      Message.success(`已生成 ${result.changed} 个点位的新版本，历史读数重算批次已执行`)
    } catch (error) {
      Message.error(`标准调整提交失败，可在批次面板重试恢复：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCommitting(false)
    }
  }

  const commitOne = async (pointId: string): Promise<void> => {
    if (!standardStore.isDraftChanged(pointId)) {
      Message.info('草稿与当前标准值一致，无需调整')
      return
    }
    setCommitting(true)
    try {
      const result = await standardStore.commitDrafts([pointId])
      if (result) Message.success('新版本已生效，历史读数重算批次已执行')
    } catch (error) {
      Message.error(`提交失败，可在批次面板重试：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCommitting(false)
    }
  }

  const openTemplate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    templateForm.setFieldsValue({ deviceId: deviceOptions[0].value })
    setCheckedTemplates(POINT_TEMPLATES.map((item) => item.name))
    setTemplateOpen(true)
  }

  const submitTemplate = async (): Promise<void> => {
    const values = await templateForm.validate().catch(() => null)
    if (!values) return
    const chosen: PointTemplate[] = POINT_TEMPLATES.filter((item) => checkedTemplates.includes(item.name))
    if (chosen.length === 0) {
      Message.warning('请至少选择一个模板点位')
      return
    }
    const created = await stationStore.applyTemplate(values.deviceId, chosen)
    Message.success(created === 0 ? '所选模板点位均已存在' : `已按模板复制 ${created} 个点位并生成初始版本`)
    setTemplateOpen(false)
  }

  const columns: TableColumnProps<Point>[] = [
    { title: '点位名', dataIndex: 'name', width: 140, render: (value: string) => <strong>{value}</strong> },
    {
      title: '调压站 / 设备',
      width: 210,
      render: (_value, record) => {
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '当前生效标准（班组调整草稿）',
      width: 380,
      render: (_value, record) => {
        const latest = standardStore.latestVersionOfPoint(record.id)
        const draft = standardStore.drafts[record.id]
        const min = draft ? draft.standardMin : record.standardMin
        const max = draft ? draft.standardMax : record.standardMax
        const critical = draft ? draft.isCritical : record.isCritical
        const changed = standardStore.isDraftChanged(record.id)
        return (
          <Space size={4} wrap>
            <InputNumber
              size="small"
              style={{ width: 90 }}
              value={min}
              step={0.01}
              onChange={(value: number | undefined) =>
                standardStore.setDraft(record.id, {
                  standardMin: Number(value ?? 0),
                  standardMax: max,
                  isCritical: critical
                })
              }
            />
            <span>~</span>
            <InputNumber
              size="small"
              style={{ width: 90 }}
              value={max}
              step={0.01}
              onChange={(value: number | undefined) =>
                standardStore.setDraft(record.id, {
                  standardMin: min,
                  standardMax: Number(value ?? 0),
                  isCritical: critical
                })
              }
            />
            <span className="muted">{record.unit}</span>
            <Switch
              size="small"
              checked={critical}
              checkedText="关键"
              uncheckedText="普通"
              onChange={(checked: boolean) =>
                standardStore.setDraft(record.id, {
                  standardMin: draft ? draft.standardMin : record.standardMin,
                  standardMax: draft ? draft.standardMax : record.standardMax,
                  isCritical: checked
                })
              }
            />
            <Button type="text" size="small" disabled={!changed || committing} onClick={() => commitOne(record.id)}>
              生成新版本
            </Button>
            {latest ? (
              <Tooltip content={`最新版本 v${latest.versionNo}，${latest.effectiveDate} 生效`}>
                <Tag size="small" color={latest.source === '初始版本' ? 'gray' : 'arcoblue'}>
                  v{latest.versionNo} · {latest.effectiveDate}
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: '异常读数',
      width: 160,
      render: (_value, record) => {
        const count = abnormalCountOf(record.id)
        if (count === 0) return <Tag color="green">无异常</Tag>
        const worst = readingTable.rows
          .filter((row) => row.pointId === record.id && row.isAbnormal)
          .reduce((maxRow, row) => (row.deviationPct > maxRow.deviationPct ? row : maxRow), readingTable.rows.find((row) => row.pointId === record.id && row.isAbnormal)!)
        // 按该条读数当时的判定快照追溯级别
        return (
          <AbnormalTag
            level={abnormalLevelOf(worst.deviationPct, worst.judgeIsCritical)}
            deviationPct={worst.deviationPct}
            size="small"
          />
        )
      }
    },
    {
      title: '版本 / 操作',
      width: 180,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => setHistoryPoint(record)}>
            版本（{standardStore.versionsOfPoint(record.id).length}）
          </Button>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该点位将同时删除其读数与标准版本" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = stationStore.pointStats()
  const recentBatches = standardStore.batches.slice(0, 5)

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检点位与标准值配置（带生效日期的版本）</h2>
          <p className="page-head__desc">
            班组交接调整不覆盖旧标准：生成带生效日期的新版本，历史读数按巡检日期取当时版本，新读数用最新值。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={openTemplate}>按模板批量复制</Button>
          <Button type="primary" disabled={changedIds.length === 0 || committing} onClick={commitAll}>
            提交调整并生成版本（{changedIds.length}）
          </Button>
          <Button type="outline" onClick={openCreate}>
            新增点位
          </Button>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            班组交接调整
          </h3>
          <span className="muted">草稿 {Object.keys(standardStore.drafts).length} 项，其中实际变更 {changedIds.length} 项</span>
        </div>
        <Space size={16} wrap style={{ marginTop: 8 }}>
          <Space size={8}>
            <span>新版本生效日期</span>
            <DatePicker
              value={standardStore.effectiveDate}
              onChange={(dateString: string) => standardStore.setEffectiveDate(dateString)}
              style={{ width: 170 }}
            />
          </Space>
          <Space size={8}>
            <span>交接说明</span>
            <Input
              style={{ width: 320 }}
              placeholder="如 上游管网提压，进口压力下限提高"
              value={standardStore.reason}
              onChange={(value: string) => standardStore.setReason(value)}
            />
          </Space>
          <span className="muted">
            生效日之前的历史读数仍按旧版本判定；生效日当天及之后的新读数自动用新版本。
          </span>
        </Space>
      </div>

      <div className="stat-row">
        <StatBadge label="点位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="关键点" value={stats.critical} suffix="个" tone="warning" />
        <StatBadge label="标准版本" value={standardStore.versions.length} suffix="个" tone="info" />
        <StatBadge
          label="异常读数（按当时口径）"
          value={readingTable.rows.filter((row) => row.isAbnormal).length}
          percent={
            readingTable.rows.length === 0
              ? 0
              : Math.round((readingTable.rows.filter((row) => row.isAbnormal).length / readingTable.rows.length) * 100)
          }
          tone="danger"
        />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索点位名 / 设备型号"
        switchLabel="仅看关键点"
        switchValue={filter.onlyCritical}
        hasSwitch
        onModelChange={onModelChange}
        onSwitchChange={(value: boolean) => stationStore.patchPointFilter({ onlyCritical: value })}
      />

      {recentBatches.length > 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3 className="panel-title" style={{ margin: 0 }}>
              重算批次（最近 {recentBatches.length} 个）
            </h3>
            <span className="muted">分块写入、失败自动重试；进度已持久化，刷新后自动恢复</span>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
            {recentBatches.map((batch) => (
              <RecalcBatchPanel key={batch.id} batch={batch} />
            ))}
          </Space>
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            点位清单（{rows.length} / {stats.total}）
          </h3>
          <span className="muted">修改上下限或关键点后生成新版本，系统自动重算历史读数并退回相关泄漏单复核</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的点位"
            description="先到调压站台账登记设备，再按模板批量复制或手工新增点位。"
            actionText="新增点位"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => stationStore.resetPointFilter()}
            compact
          />
        ) : (
          <Table<Point>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={pointOpen}
        title={editingId ? '编辑点位信息' : '新增点位'}
        onCancel={() => setPointOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={pointForm} layout="vertical" initialValues={EMPTY_POINT_DRAFT}>
          <Form.Item field="deviceId" label="所属设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch disabled={Boolean(editingId)} />
          </Form.Item>
          <Form.Item field="name" label="点位名" rules={[{ required: true, message: '请填写点位名' }]}>
            <Input placeholder="如 出口压力 / 阀体泄漏浓度" />
          </Form.Item>
          <Form.Item field="unit" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
            <Select options={POINT_UNITS.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          {editingId ? (
            <div className="muted" style={{ marginBottom: 8 }}>
              标准上下限与关键点标记不在此直接修改，请在列表中调整草稿并「生成新版本」，以保留历史判定口径。
            </div>
          ) : (
            <>
              <Form.Item field="standardMin" label="标准下限" rules={[{ required: true, message: '请填写标准下限' }]}>
                <InputNumber step={0.01} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item field="standardMax" label="标准上限" rules={[{ required: true, message: '请填写标准上限' }]}>
                <InputNumber step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          <Form.Item field="isCritical" label="是否关键点" triggerPropName="checked" disabled={Boolean(editingId)}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={templateOpen}
        title="按模板批量复制标准值"
        onCancel={() => setTemplateOpen(false)}
        onOk={submitTemplate}
        okText="复制点位"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={templateForm} layout="vertical">
          <Form.Item field="deviceId" label="目标设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginBottom: 8 }}>
          已存在的同名点位会自动跳过，复制后生成生效日为今天的初始版本：
        </div>
        <Checkbox.Group
          value={checkedTemplates}
          onChange={(values: string[]) => setCheckedTemplates(values)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {POINT_TEMPLATES.map((item) => (
            <Checkbox key={item.name} value={item.name}>
              {item.name}（{rangeText(item.standardMin, item.standardMax, item.unit)}
              {item.isCritical ? ' · 关键点' : ''}）
            </Checkbox>
          ))}
        </Checkbox.Group>
      </Modal>

      <Modal
        visible={historyPoint !== null}
        title={historyPoint ? `标准版本历史 · ${historyPoint.name}` : '标准版本历史'}
        footer={null}
        onCancel={() => setHistoryPoint(null)}
        unmountOnExit
        style={{ width: 720 }}
      >
        {historyPoint ? <VersionTimeline point={historyPoint} /> : null}
      </Modal>
    </div>
  )
}

function VersionTimeline({ point }: { point: Point }) {
  const standardStore = useStandardStore()
  const versions = [...standardStore.versionsOfPoint(point.id)].reverse()
  if (versions.length === 0) {
    return <EmptyPanel title="暂无版本" description="新增点位或调整标准值后会在此形成版本链。" compact />
  }
  return (
    <Timeline>
      {versions.map((version: StandardVersion) => (
        <Timeline.Item
          key={version.id}
          dotColor={version.source === '初始版本' ? '#86909c' : '#165dff'}
          label={`${version.effectiveDate} 生效`}
        >
          <Space size={8} wrap>
            <Tag color={version.source === '初始版本' ? 'gray' : 'arcoblue'}>v{version.versionNo}</Tag>
            <strong>{rangeText(version.standardMin, version.standardMax, version.unit)}</strong>
            <Tag size="small" color={version.isCritical ? 'orange' : 'green'}>
              {version.isCritical ? '关键点' : '普通点'}
            </Tag>
          </Space>
          <div className="muted" style={{ marginTop: 4 }}>
            {version.source} · {version.reason || '—'}
          </div>
        </Timeline.Item>
      ))}
    </Timeline>
  )
}

function RecalcBatchPanel({ batch }: { batch: RecalcBatchRow }) {
  const standardStore = useStandardStore()
  const percent = recalcProgressPercent(batch)
  const color = batch.status === '部分失败' ? '#f53f3f' : batch.status === '已完成' ? '#00b42a' : '#165dff'
  const failedItems = batch.items.filter((item) => item.status === '失败')
  const running = standardStore.runningBatchId === batch.id
  return (
    <div style={{ border: '1px solid #e5e6eb', borderRadius: 8, padding: 12 }}>
      <Space size={10} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size={8}>
          <Tag color={batch.status === '已完成' ? 'green' : batch.status === '部分失败' ? 'red' : 'arcoblue'}>
            {batch.status}
          </Tag>
          <strong>{batch.reason}</strong>
          <span className="muted">{batch.effectiveDate} 生效 · 共 {batch.total} 条读数</span>
        </Space>
        <Space size={8}>
          <span className="muted">
            成功 {batch.succeeded} / 失败 {batch.failed}
          </span>
          {batch.status === '部分失败' ? (
            <Button size="small" type="primary" loading={running} onClick={() => standardStore.retryBatch(batch.id)}>
              重试失败项并恢复进度
            </Button>
          ) : null}
        </Space>
      </Space>
      <Progress percent={percent} color={color} style={{ marginTop: 8, marginBottom: 0 }} />
      {failedItems.length > 0 ? (
        <div className="muted" style={{ marginTop: 6, color: '#cb2634' }}>
          {failedItems.slice(0, 3).map((item) => (
            <div key={item.readingId}>
              读数 {item.readingId}：{item.error}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
