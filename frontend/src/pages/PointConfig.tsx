/**
 * /points 巡检点位与标准值配置
 * 维护点位上下限、单位与关键点标记，支持模板批量复制。
 * 标准值改动不覆盖历史：草稿提交后生成「带生效日期的版本」与重算批次——
 * 历史读数按巡检日期取版本重判，新读数取最新版本；可查看每个点位的版本时间线与批次进度。
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
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  db,
  type ReadingRow,
  type RecalcBatchRow,
  type StandardVersionRow
} from '@/utils/db'
import { recalcProgressOf, resumeRecalcBatch } from '@/utils/recalc'
import { describeRecalcStatus } from '@/types/recalc'
import {
  EMPTY_POINT_DRAFT,
  POINT_TEMPLATES,
  POINT_UNITS,
  type Point,
  type PointDraft,
  type PointTemplate
} from '@/types/point'
import { DEVICE_TYPES } from '@/types/device'
import { abnormalLevelOf, rangeText } from '@/utils/range'

export default function PointConfig() {
  const stationStore = useStationStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })
  const versionTable = useIdbTable<StandardVersionRow>(db.standardVersions, { sortByUpdatedAt: false })
  const batchTable = useIdbTable<RecalcBatchRow>(db.recalcBatches, { sortByUpdatedAt: true })

  const [pointForm] = Form.useForm<PointDraft>()
  const [templateForm] = Form.useForm<{ deviceId: string }>()
  const [pointOpen, setPointOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkedTemplates, setCheckedTemplates] = useState<string[]>(POINT_TEMPLATES.map((item) => item.name))
  const [historyPoint, setHistoryPoint] = useState<Point | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const adjustDate = stationStore.adjustDate

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

  const versionsOf = (pointId: string): StandardVersionRow[] =>
    versionTable.rows
      .filter((version) => version.pointId === pointId)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.versionNo - a.versionNo)

  const latestVersionOf = (pointId: string): StandardVersionRow | undefined => versionsOf(pointId)[0]

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
    const payload: PointDraft = {
      ...values,
      standardMin: Math.min(values.standardMin, values.standardMax),
      standardMax: Math.max(values.standardMin, values.standardMax)
    }
    if (editingId) {
      try {
        await stationStore.updatePoint(editingId, payload)
        Message.success('点位已更新；标准值改动已生成新版本与重算批次')
      } catch (error) {
        Message.error(`标准值调整失败：${error instanceof Error ? error.message : '未知错误'}，可在页尾批次面板重试`)
      }
    } else {
      await stationStore.createPoint(payload)
      Message.success('点位已创建（含初始标准版本）')
    }
    setPointOpen(false)
  }

  const remove = async (point: Point): Promise<void> => {
    await stationStore.removePoint(point.id)
    Message.success('点位及其读数与版本已删除')
  }

  const commitAll = async (): Promise<void> => {
    const count = Object.keys(stationStore.standardDraft).length
    if (count === 0) {
      Message.warning('没有待提交的标准值草稿')
      return
    }
    try {
      const committed = await stationStore.commitAllStandardDrafts()
      Message.success(`已提交 ${committed} 个点位的标准值（${adjustDate} 起生效），历史读数已按巡检日期取版本重判`)
    } catch (error) {
      Message.error(`重算批次写入失败：${error instanceof Error ? error.message : '未知错误'}，进度已保留，可在页尾重试`)
    }
  }

  const commitOne = async (point: Point): Promise<void> => {
    try {
      const ok = await stationStore.commitStandardDraft(point.id)
      if (ok) Message.success(`${point.name} 标准值已保存（${adjustDate} 起生效），历史读数已按版本重判`)
    } catch (error) {
      Message.error(`重算批次写入失败：${error instanceof Error ? error.message : '未知错误'}，进度已保留，可在页尾重试`)
    }
  }

  const retryBatch = async (batch: RecalcBatchRow): Promise<void> => {
    setRetryingId(batch.id)
    try {
      await resumeRecalcBatch(batch.id)
      Message.success('批次已从中断点续算完成')
    } catch (error) {
      Message.error(`续算仍失败：${error instanceof Error ? error.message : '未知错误'}，已保留进度可再次重试`)
    } finally {
      setRetryingId(null)
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
    Message.success(created === 0 ? '所选模板点位均已存在' : `已按模板复制 ${created} 个点位（含初始版本）`)
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
      title: `调整为新标准（${adjustDate} 起生效）`,
      width: 350,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const min = draft ? draft.standardMin : record.standardMin
        const max = draft ? draft.standardMax : record.standardMax
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Space size={4} wrap>
            <InputNumber
              size="small"
              style={{ width: 90 }}
              value={min}
              step={0.01}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
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
                stationStore.setStandardDraft(record.id, {
                  standardMin: min,
                  standardMax: Number(value ?? 0),
                  isCritical: critical
                })
              }
            />
            <span className="muted">{record.unit}</span>
            <Button type="text" size="small" disabled={!draft} loading={false} onClick={() => commitOne(record)}>
              保存
            </Button>
            {draft ? <Tag color="orange" size="small">待提交</Tag> : null}
          </Space>
        )
      }
    },
    {
      title: '关键点',
      width: 100,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Switch
            size="small"
            checked={critical}
            onChange={(checked: boolean) =>
              stationStore.setStandardDraft(record.id, {
                standardMin: draft ? draft.standardMin : record.standardMin,
                standardMax: draft ? draft.standardMax : record.standardMax,
                isCritical: checked
              })
            }
          />
        )
      }
    },
    {
      title: '当前生效标准',
      width: 172,
      render: (_value, record) => {
        const latest = latestVersionOf(record.id)
        return (
          <div>
            <div>{rangeText(record.standardMin, record.standardMax, record.unit)}</div>
            {latest ? <span className="muted">生效于 {latest.effectiveDate}</span> : null}
          </div>
        )
      }
    },
    {
      title: '版本',
      width: 120,
      render: (_value, record) => {
        const versions = versionsOf(record.id)
        return (
          <Space size={4}>
            <Tag color="arcoblue" size="small">
              v{versions.reduce((max, item) => Math.max(max, item.versionNo), 0)}
            </Tag>
            <Button type="text" size="small" onClick={() => setHistoryPoint(record)}>
              时间线
            </Button>
          </Space>
        )
      }
    },
    {
      title: '异常读数（按当时版本）',
      width: 180,
      render: (_value, record) => {
        const pointReadings = readingTable.rows.filter((row) => row.pointId === record.id)
        const abnormal = pointReadings.filter((row) => row.isAbnormal)
        if (abnormal.length === 0) return <Tag color="green">无异常</Tag>
        const worst = abnormal.reduce(
          (max, row) => Math.max(max, row.deviationPct),
          0
        )
        return <AbnormalTag level={abnormalLevelOf(worst, record.isCritical)} deviationPct={worst} size="small" />
      }
    },
    {
      title: '操作',
      width: 130,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="删除该点位将同时删除其巡检读数与标准版本" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = stationStore.pointStats()
  const failedBatches = batchTable.rows.filter((batch) => batch.status === 'failed')
  const historyVersions = historyPoint ? versionsOf(historyPoint.id) : []

  const historyColumns: TableColumnProps<StandardVersionRow>[] = [
    { title: '版本', dataIndex: 'versionNo', width: 70, render: (value: number) => `v${value}` },
    {
      title: '生效日期',
      dataIndex: 'effectiveDate',
      width: 120,
      render: (value: string, record) => (
        <Space size={4}>
          <span>{value}</span>
          {record.source === 'initial' ? <Tag size="small">初始版本</Tag> : <Tag color="orange" size="small">调整</Tag>}
        </Space>
      )
    },
    {
      title: '标准区间',
      width: 170,
      render: (_value, record) => rangeText(record.standardMin, record.standardMax, record.unit)
    },
    {
      title: '关键点',
      width: 80,
      render: (_value, record) => (record.isCritical ? <Tag color="orange" size="small">关键</Tag> : '普通')
    },
    { title: '说明', dataIndex: 'note', render: (value: string) => value || '—' }
  ]

  const batchColumns: TableColumnProps<RecalcBatchRow>[] = [
    {
      title: '批次',
      width: 150,
      render: (_value, record) => <span className="muted">{record.id.slice(-10)}</span>
    },
    { title: '生效日期', dataIndex: 'effectiveDate', width: 110 },
    {
      title: '状态',
      width: 130,
      render: (_value, record) => (
        <Tag color={record.status === 'succeeded' ? 'green' : record.status === 'failed' ? 'red' : 'blue'}>
          {describeRecalcStatus(record.status)}
        </Tag>
      )
    },
    {
      title: '重算进度',
      width: 200,
      render: (_value, record) => {
        const progress = recalcProgressOf(record)
        return (
          <div>
            <Progress percent={progress.percent} size="small" {...(record.status === 'failed' ? { status: 'error' as const } : {})} />
            <span className="muted">
              {progress.done} / {progress.total} 条
            </span>
          </div>
        )
      }
    },
    {
      title: '联动',
      width: 240,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tag size="small">复核泄漏单 {record.reviewedLeakIds.length}</Tag>
          <Tag size="small" color="orange">新异常 {record.newAbnormalReadingIds.length}</Tag>
          <Tag size="small" color="red">派单 {record.dispatchedReadingIds.length}</Tag>
        </Space>
      )
    },
    {
      title: '说明 / 失败原因',
      render: (_value, record) =>
        record.status === 'failed' ? (
          <span style={{ color: '#cb272d' }}>{record.failReason || '写入失败'}</span>
        ) : (
          <span className="muted">{record.note}</span>
        )
    },
    {
      title: '操作',
      width: 110,
      render: (_value, record) =>
        record.status === 'succeeded' ? (
          <span className="muted">已完成</span>
        ) : (
          <Button type="primary" size="small" loading={retryingId === record.id} onClick={() => retryBatch(record)}>
            {record.status === 'failed' ? '重试续算' : '继续重算'}
          </Button>
        )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检点位与标准值配置</h2>
          <p className="page-head__desc">
            调整标准值不会覆盖历史：新版本带生效日期，历史读数按巡检日期取当时版本，新读数取最新版本；批次失败可重试续算。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={openTemplate}>按模板批量复制</Button>
          <Button disabled={Object.keys(stationStore.standardDraft).length === 0} onClick={commitAll}>
            提交草稿（{Object.keys(stationStore.standardDraft).length}）
          </Button>
          <Button type="primary" onClick={openCreate}>
            新增点位
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="点位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="关键点" value={stats.critical} suffix="个" tone="warning" />
        <StatBadge label="标准版本数" value={versionTable.rows.length} suffix="版" tone="info" />
        <StatBadge
          label="失败批次"
          value={failedBatches.length}
          suffix="个"
          tone="danger"
        />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <Space size={12} wrap>
          <strong>本次调整生效日期：</strong>
          <DatePicker
            value={adjustDate}
            onChange={(value: string) => {
              if (value) stationStore.setAdjustDate(value)
            }}
            style={{ width: 170 }}
          />
          <span className="muted">
            巡检日期 ≥ 该日期的历史读数按新版本重判；更早的读数继续按旧版本追溯。重复提交不会多出泄漏单。
          </span>
        </Space>
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

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            点位清单（{rows.length} / {stats.total}）
          </h3>
          <span className="muted">标准值改动先进草稿，保存后生成版本与重算批次，历史读数按当时版本判定</span>
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
            scroll={{ x: 1620 }}
          />
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            标准值重算批次（{batchTable.rows.length}）
          </h3>
          <Space size={8}>
            <Button
              size="small"
              onClick={() => {
                if (typeof window !== 'undefined') window.__gbgaspressFailNextRecalcChunk = true
                Message.info('已开启自检：下一个批次处理到第二块时将模拟一次写入失败，用于验证重试与进度恢复')
              }}
            >
              模拟一次写入失败
            </Button>
            <span className="muted">分块检查点推进，失败后点「重试续算」从断点继续</span>
          </Space>
        </div>
        {batchTable.rows.length === 0 ? (
          <EmptyPanel title="尚无调整批次" description="在上方调整标准值并提交后，这里会出现重算批次及进度。" compact />
        ) : (
          <Table<RecalcBatchRow>
            rowKey="id"
            size="small"
            border
            data={batchTable.rows}
            columns={batchColumns}
            pagination={false}
            scroll={{ x: 1200 }}
          />
        )}
      </div>

      <Modal
        visible={pointOpen}
        title={editingId ? '编辑点位' : '新增点位'}
        onCancel={() => setPointOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={pointForm} layout="vertical" initialValues={EMPTY_POINT_DRAFT}>
          <Form.Item field="deviceId" label="所属设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="name" label="点位名" rules={[{ required: true, message: '请填写点位名' }]}>
            <Input placeholder="如 出口压力 / 阀体泄漏浓度" />
          </Form.Item>
          <Form.Item field="standardMin" label="标准下限" rules={[{ required: true, message: '请填写标准下限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="standardMax" label={`标准上限（改动将以 ${adjustDate} 起生效）`} rules={[{ required: true, message: '请填写标准上限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="unit" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
            <Select options={POINT_UNITS.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="isCritical" label="是否关键点" triggerPropName="checked">
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
          已存在的同名点位会自动跳过：
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
        title={historyPoint ? `标准值版本时间线 · ${historyPoint.name}` : '标准值版本时间线'}
        footer={null}
        onCancel={() => setHistoryPoint(null)}
        unmountOnExit
      >
        <p className="muted" style={{ marginTop: 0 }}>
          历史读数按巡检日期命中对应版本；当前生效：
          {historyPoint ? rangeText(historyPoint.standardMin, historyPoint.standardMax, historyPoint.unit) : ''}
        </p>
        <Table<StandardVersionRow>
          rowKey="id"
          size="small"
          border
          data={historyVersions}
          columns={historyColumns}
          pagination={false}
        />
      </Modal>
    </div>
  )
}
