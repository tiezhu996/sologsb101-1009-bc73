/**
 * /leaks 泄漏处置单与复检闭环
 * 派单、填写措施、录复检浓度并闭环；状态机 待处置 → 已处置 → 已复检。
 * 消费 Leak、Device、Reading；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<AbnormalTag>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useLeakStore } from '@/stores/leakStore'
import {
  EMPTY_LEAK_DRAFT,
  LEAK_RETEST_PASS_PPM,
  LEAK_STATES,
  LEAK_STATE_FLOW,
  MANUAL_LEAK_STATES,
  isUnderReview,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'
import { deviationPctOf, formatLeakConcentration } from '@/utils/range'

export default function LeakBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()

  const [form] = Form.useForm<LeakDraft>()
  const [treatForm] = Form.useForm<{ handler: string; measure: string }>()
  const [retestForm] = Form.useForm<{ retestValuePpm: number; handler: string }>()
  const [reviewForm] = Form.useForm<{ handler: string; measure: string }>()
  const [formOpen, setFormOpen] = useState(false)
  const [treatOpen, setTreatOpen] = useState(false)
  const [retestOpen, setRetestOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [target, setTarget] = useState<Leak | null>(null)
  const [reviewDecision, setReviewDecision] = useState<'confirm' | 'invalidate'>('confirm')
  const [keyword, setKeyword] = useState('')

  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'states', label: '处置状态', options: LEAK_STATES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword,
    stationId: leakStore.stationId,
    states: leakStore.stateFilter
  }

  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    leakStore.patchFilter({
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      stateFilter: (Array.isArray(next.states) ? next.states : []) as LeakState[]
    })
  }

  const rows = leakStore.filteredLeaks().filter((leak) => {
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === leak.deviceId)
    return (
      (device ? device.model.toLowerCase().includes(text) || device.serialNo.toLowerCase().includes(text) : false) ||
      leak.handler.toLowerCase().includes(text) ||
      leak.measure.toLowerCase().includes(text)
    )
  })

  const deviceOptions = stationStore.devices.map((device) => {
    const station = stationStore.stations.find((item) => item.id === device.stationId)
    return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
  })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    setEditingId(null)
    form.setFieldsValue({ ...EMPTY_LEAK_DRAFT, deviceId: deviceOptions[0].value, foundTime: new Date().toISOString().slice(0, 10) })
    setFormOpen(true)
  }

  const openEdit = (leak: Leak): void => {
    setEditingId(leak.id)
    form.setFieldsValue({
      deviceId: leak.deviceId,
      concentrationPpm: leak.concentrationPpm,
      foundTime: leak.foundTime,
      measure: leak.measure,
      state: leak.state,
      retestValuePpm: leak.retestValuePpm,
      handler: leak.handler
    })
    setFormOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    if (editingId) {
      await leakStore.updateLeak(editingId, values)
      Message.success('处置单已更新')
    } else {
      await leakStore.createLeak(values)
      Message.success('处置单已创建')
    }
    setFormOpen(false)
  }

  const remove = async (leak: Leak): Promise<void> => {
    await leakStore.removeLeak(leak.id)
    Message.success('处置单已删除')
  }

  const advance = async (leak: Leak): Promise<void> => {
    const next = LEAK_STATE_FLOW[leak.state]
    if (isUnderReview(leak)) {
      Message.warning('该处置单已退回标准复核，须先完成复核确认，复检入口已暂停')
      return
    }
    if (!next) {
      Message.info('该处置单已完成复检闭环')
      return
    }
    if (next === '已处置') {
      setTarget(leak)
      treatForm.setFieldsValue({ handler: leak.handler, measure: leak.measure })
      setTreatOpen(true)
      return
    }
    setTarget(leak)
    retestForm.setFieldsValue({ retestValuePpm: leak.retestValuePpm || 0, handler: leak.handler })
    setRetestOpen(true)
  }

  const openReview = (leak: Leak, decision: 'confirm' | 'invalidate'): void => {
    setTarget(leak)
    setReviewDecision(decision)
    reviewForm.setFieldsValue({ handler: leak.handler, measure: leak.measure })
    setReviewOpen(true)
  }

  const submitReview = async (): Promise<void> => {
    if (!target) return
    const values = await reviewForm.validate().catch(() => null)
    if (!values) return
    await leakStore.resolveReview(target.id, reviewDecision, { handler: values.handler, measure: values.measure })
    Message.success(
      reviewDecision === 'confirm'
        ? `复核确认，处置单已恢复为「${target.stateBeforeReview === '已处置' ? '已处置' : '待处置'}」`
        : '复核不成立，原处置单已按新标准关闭（保留原单可追溯）'
    )
    setReviewOpen(false)
  }

  const submitTreat = async (): Promise<void> => {
    if (!target) return
    const values = await treatForm.validate().catch(() => null)
    if (!values) return
    await leakStore.advance(target.id, { handler: values.handler, measure: values.measure })
    Message.success('处置措施已归档，状态置为「已处置」')
    setTreatOpen(false)
  }

  const submitRetest = async (): Promise<void> => {
    if (!target) return
    const values = await retestForm.validate().catch(() => null)
    if (!values) return
    try {
      const passed = await leakStore.submitRetest(target.id, values.retestValuePpm, values.handler)
      if (passed) {
        Message.success(`复检浓度 ${values.retestValuePpm} ppm ≤ ${LEAK_RETEST_PASS_PPM} ppm，判定合格，处置单已闭环`)
      } else {
        Message.warning(`复检浓度 ${values.retestValuePpm} ppm 仍超标，处置单已复检但仍需继续整改`)
      }
      setRetestOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '复检提交失败')
    }
  }

  const columns: TableColumnProps<Leak>[] = [
    {
      title: '调压站 / 设备',
      width: 240,
      render: (_value, record) => {
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '泄漏浓度',
      width: 200,
      render: (_value, record) => (
        <Space size={6}>
          <span style={{ color: '#f53f3f', fontWeight: 600 }}>{formatLeakConcentration(record.concentrationPpm)}</span>
          <Tag color="red" size="small">
            偏差 {deviationPctOf(record.concentrationPpm, 0, 50).toFixed(0)}%
          </Tag>
        </Space>
      )
    },
    { title: '发现时间', dataIndex: 'foundTime', width: 120 },
    { title: '处置措施', dataIndex: 'measure', width: 240, render: (value: string) => value || '—' },
    {
      title: '状态',
      width: 130,
      render: (_value, record) => {
        if (record.state === '标准复核') {
          return (
            <div>
              <Tag color="orangered">标准复核</Tag>
              <div className="muted" style={{ fontSize: 12 }}>
                原状态：{record.stateBeforeReview || '待处置'}
              </div>
            </div>
          )
        }
        return (
          <Tag color={record.state === '已复检' ? 'green' : record.state === '已处置' ? 'blue' : 'red'}>
            {record.state}
          </Tag>
        )
      }
    },
    {
      title: '复核说明',
      width: 200,
      render: (_value, record) =>
        record.reviewReason ? <span style={{ color: record.state === '标准复核' ? '#cb272d' : undefined }}>{record.reviewReason}</span> : <span className="muted">—</span>
    },
    {
      title: '复检值',
      width: 160,
      render: (_value, record) => {
        if (record.retestValuePpm <= 0) return <span className="muted">未复检</span>
        return (
          <Space size={6}>
            <span>{formatLeakConcentration(record.retestValuePpm)}</span>
            <Tag color={retestPassed(record.retestValuePpm) ? 'green' : 'red'} size="small">
              {retestPassed(record.retestValuePpm) ? '合格' : '不合格'}
            </Tag>
          </Space>
        )
      }
    },
    { title: '处置人', dataIndex: 'handler', width: 100, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 290,
      render: (_value, record) => {
        if (record.state === '标准复核') {
          return (
            <Space size={4} wrap>
              <Button type="text" size="small" onClick={() => openReview(record, 'confirm')}>
                复核确认
              </Button>
              <Button type="text" size="small" status="danger" onClick={() => openReview(record, 'invalidate')}>
                关闭原单
              </Button>
              <Button type="text" size="small" disabled>
                复检已暂停
              </Button>
            </Space>
          )
        }
        return (
          <Space size={4}>
            <Button type="text" size="small" disabled={!LEAK_STATE_FLOW[record.state]} onClick={() => advance(record)}>
              {LEAK_STATE_FLOW[record.state] === '已处置'
                ? '填写措施'
                : LEAK_STATE_FLOW[record.state] === '已复检'
                  ? '录入复检'
                  : '已闭环'}
            </Button>
            <Button type="text" size="small" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm title="确认删除该处置单？" onOk={() => remove(record)}>
              <Button type="text" size="small" status="danger">
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      }
    }
  ]

  const stats = leakStore.counts()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">泄漏处置单与复检闭环</h2>
          <p className="page-head__desc">
            待处置 → 已处置（填写措施与处置人）→ 已复检（复检浓度 ≤ {LEAK_RETEST_PASS_PPM} ppm 判合格）。
            标准值调整后，待处置/已处置单退回「标准复核」并暂停复检；已复检合格的保留原结论。
          </p>
        </div>
        <div className="page-head__actions">
          <Button
            onClick={() => {
              leakStore.patchFilter({ onlyOpen: !leakStore.onlyOpen })
            }}
          >
            {leakStore.onlyOpen ? '查看全部' : '仅看未闭环'}
          </Button>
          <Button type="primary" onClick={openCreate}>
            新建处置单
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="处置单总数" value={leakStore.leaks.length} suffix="张" tone="primary" />
        <StatBadge label="待处置" value={stats['待处置']} suffix="张" tone="danger" />
        <StatBadge label="已处置" value={stats['已处置']} suffix="张" tone="warning" />
        <StatBadge label="标准复核" value={leakStore.reviewCount()} suffix="张" tone="default" />
        <StatBadge label="复检合格" value={leakStore.retestPassCount()} percent={leakStore.closedPercent()} suffix="张" tone="success" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索设备型号 / 编号 / 处置人" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            处置单清单（{rows.length} / {leakStore.leaks.length}）
          </h3>
          <span className="muted">复检不合格的处置单需继续整改并再次复检</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的处置单"
            description="可在异常分级页对浓度异常读数直接派发处置单。"
            actionText="新建处置单"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => leakStore.resetFilter()}
            compact
          />
        ) : (
          <Table<Leak>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1750 }}
          />
        )}
      </div>

      <Modal
        visible={formOpen}
        title={editingId ? '编辑处置单' : '新建泄漏处置单'}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_LEAK_DRAFT}>
          <Form.Item field="deviceId" label="泄漏设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="concentrationPpm" label="泄漏浓度(ppm)" rules={[{ required: true, message: '请填写浓度' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="foundTime" label="发现时间" rules={[{ required: true, message: '请填写发现时间' }]}>
            <Input placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施">
            <Input.TextArea placeholder="如 更换阀体密封垫并做气密试验" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item field="handler" label="处置人">
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="state" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select
              options={MANUAL_LEAK_STATES.map((item) => ({ label: item, value: item }))}
              disabled={editingId !== null && form.getFieldValue('state') === '标准复核'}
            />
          </Form.Item>
          <Form.Item field="retestValuePpm" label="复检浓度(ppm)">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={treatOpen}
        title="填写处置措施"
        onCancel={() => setTreatOpen(false)}
        onOk={submitTreat}
        okText="确认已处置"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={treatForm} layout="vertical">
          <Form.Item field="handler" label="处置人" rules={[{ required: true, message: '请填写处置人' }]}>
            <Input placeholder="如 张伟" />
          </Form.Item>
          <Form.Item field="measure" label="处置措施" rules={[{ required: true, message: '请填写处置措施' }]}>
            <Input.TextArea placeholder="如 紧固法兰螺栓并涂抹检漏液复测" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={retestOpen}
        title="录入复检结果"
        onCancel={() => setRetestOpen(false)}
        onOk={submitRetest}
        okText="提交复检"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={retestForm} layout="vertical">
          <Form.Item
            field="retestValuePpm"
            label={`复检浓度(ppm)，≤ ${LEAK_RETEST_PASS_PPM} 判合格`}
            rules={[{ required: true, message: '请填写复检浓度' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="handler" label="复检人" rules={[{ required: true, message: '请填写复检人' }]}>
            <Input placeholder="如 李娜" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={reviewOpen}
        title={reviewDecision === 'confirm' ? '标准复核确认' : '标准复核 · 关闭原处置单'}
        onCancel={() => setReviewOpen(false)}
        onOk={submitReview}
        okText={reviewDecision === 'confirm' ? '确认新标准下结论成立' : '确认结论不成立，关闭原单'}
        cancelText="取消"
        {...(reviewDecision === 'invalidate' ? { okButtonProps: { status: 'danger' as const } } : {})}
        unmountOnExit
      >
        {target ? (
          <div style={{ marginBottom: 12 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              该处置单因标准值调整退回标准复核（原状态：{target.stateBeforeReview || '待处置'}）。复检入口已暂停，复核后：
            </p>
            <ul className="muted" style={{ paddingLeft: 18, margin: '0 0 8px' }}>
              <li>确认结论成立：恢复为「{target.stateBeforeReview === '已处置' ? '已处置' : '待处置'}」，可继续复检；</li>
              <li>关闭原单：按新标准原异常不再成立，原单置为已复检并保留全部记录可追溯。</li>
            </ul>
            {target.reviewReason ? <Tag color="orangered">复核原因：{target.reviewReason}</Tag> : null}
          </div>
        ) : null}
        <Form form={reviewForm} layout="vertical">
          <Form.Item field="handler" label="复核人" rules={[{ required: true, message: '请填写复核人' }]}>
            <Input placeholder="如 王强（接班复核人）" />
          </Form.Item>
          <Form.Item field="measure" label="复核意见 / 处置措施">
            <Input.TextArea placeholder="如 按 2024-06-20 生效新标准复核，泄漏读数仍超标，维持处置" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
