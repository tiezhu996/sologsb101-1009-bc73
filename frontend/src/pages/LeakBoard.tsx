/**
 * /leaks 泄漏处置单与复检闭环
 * 派单、填写措施、录复检浓度并闭环；状态机 待处置 → 已处置 → 已复检。
 * 标准值调整重算后，待处置 / 已处置的处置单退回「标准复核」并挡住复检；
 * 已复检（合格 / 不合格）的处置单保留原结论。
 * 消费 Leak、Device、Reading；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
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
  Radio,
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
import { useLeakStore, type ReviewDecision } from '@/stores/leakStore'
import {
  EMPTY_LEAK_DRAFT,
  LEAK_RETEST_PASS_PPM,
  LEAK_STATES,
  LEAK_STATE_FLOW,
  retestPassed,
  type Leak,
  type LeakDraft,
  type LeakState
} from '@/types/leak'
import { deviationPctOf, formatLeakConcentration } from '@/utils/range'

const STATE_COLOR: Record<LeakState, string> = {
  待处置: 'red',
  已处置: 'blue',
  标准复核: 'orange',
  已复检: 'green'
}

export default function LeakBoard() {
  const stationStore = useStationStore()
  const leakStore = useLeakStore()

  const [form] = Form.useForm<LeakDraft>()
  const [treatForm] = Form.useForm<{ handler: string; measure: string }>()
  const [retestForm] = Form.useForm<{ retestValuePpm: number; handler: string }>()
  const [reviewForm] = Form.useForm<{ decision: ReviewDecision; reviewer: string; note: string }>()
  const [formOpen, setFormOpen] = useState(false)
  const [treatOpen, setTreatOpen] = useState(false)
  const [retestOpen, setRetestOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [target, setTarget] = useState<Leak | null>(null)
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
      // 手工新建同样按「同设备同日」幂等，不会重复建单
      const result = await leakStore.dispatchLeak({
        deviceId: values.deviceId,
        stationId: '',
        concentrationPpm: values.concentrationPpm,
        foundTime: values.foundTime,
        measure: values.measure
      })
      if (values.handler) await leakStore.updateLeak(result.leak.id, { handler: values.handler })
      Message.success(result.created ? '处置单已创建' : '该设备当日已有处置单，已打开原单（未重复生成）')
    }
    setFormOpen(false)
  }

  const remove = async (leak: Leak): Promise<void> => {
    await leakStore.removeLeak(leak.id)
    Message.success('处置单已删除')
  }

  const advance = (leak: Leak): void => {
    const next = LEAK_STATE_FLOW[leak.state]
    if (!next) {
      if (leak.state === '标准复核') {
        Message.warning('标准调整后该处置单待复核，请先完成「标准复核」')
        return
      }
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

  const openReview = (leak: Leak): void => {
    setTarget(leak)
    reviewForm.setFieldsValue({ decision: '维持原结论', reviewer: '', note: '' })
    setReviewOpen(true)
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
    if (target.state === '标准复核') {
      Message.warning('该处置单已退回标准复核，复核完成前不能录入复检')
      return
    }
    const passed = await leakStore.submitRetest(target.id, values.retestValuePpm, values.handler)
    if (passed) {
      Message.success(`复检浓度 ${values.retestValuePpm} ppm ≤ ${LEAK_RETEST_PASS_PPM} ppm，判定合格，处置单已闭环`)
    } else {
      Message.warning(`复检浓度 ${values.retestValuePpm} ppm 仍超标，处置单已复检但仍需继续整改`)
    }
    setRetestOpen(false)
  }

  const submitReview = async (): Promise<void> => {
    if (!target) return
    const values = await reviewForm.validate().catch(() => null)
    if (!values) return
    await leakStore.resolveReview(target.id, values.decision, values.reviewer, values.note)
    Message.success(
      values.decision === '维持原结论'
        ? '复核完成：维持原异常结论，已恢复到退回前状态，可继续处置 / 复检'
        : '复核完成：判定为误报，处置单按已复检闭环'
    )
    setReviewOpen(false)
  }

  const columns: TableColumnProps<Leak>[] = [
    {
      title: '调压站 / 设备',
      width: 230,
      render: (_value, record) => {
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '泄漏浓度',
      width: 180,
      render: (_value, record) => (
        <Space size={6}>
          <span style={{ color: '#f53f3f', fontWeight: 600 }}>{formatLeakConcentration(record.concentrationPpm)}</span>
          <Tag color="red" size="small">
            偏差 {deviationPctOf(record.concentrationPpm, 0, 50).toFixed(0)}%
          </Tag>
        </Space>
      )
    },
    { title: '发现时间', dataIndex: 'foundTime', width: 110 },
    {
      title: '处置措施 / 复核说明',
      width: 280,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <span>{record.measure || '—'}</span>
          {record.state === '标准复核' ? (
            <Tag color="orange" size="small">
              {record.reviewReason || '标准值调整，退回标准复核'}
            </Tag>
          ) : null}
        </Space>
      )
    },
    {
      title: '状态',
      width: 100,
      render: (_value, record) => <Tag color={STATE_COLOR[record.state]}>{record.state}</Tag>
    },
    {
      title: '复检值',
      width: 150,
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
    { title: '处置人', dataIndex: 'handler', width: 90, render: (value: string) => value || '—' },
    {
      title: '操作',
      width: 210,
      render: (_value, record) => (
        <Space size={4}>
          {record.state === '标准复核' ? (
            <Button type="text" size="small" style={{ color: '#ff7d00' }} onClick={() => openReview(record)}>
              标准复核
            </Button>
          ) : (
            <Button type="text" size="small" disabled={!LEAK_STATE_FLOW[record.state]} onClick={() => advance(record)}>
              {LEAK_STATE_FLOW[record.state] === '已处置'
                ? '填写措施'
                : LEAK_STATE_FLOW[record.state] === '已复检'
                  ? '录入复检'
                  : '已闭环'}
            </Button>
          )}
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
  ]

  const stats = leakStore.counts()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">泄漏处置单与复检闭环</h2>
          <p className="page-head__desc">
            待处置 → 已处置（填写措施与处置人）→ 已复检（复检浓度 ≤ {LEAK_RETEST_PASS_PPM} ppm 判合格）；标准调整后开放单退回标准复核并暂停复检。
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
        <StatBadge label="标准复核" value={stats['标准复核']} suffix="张" tone="warning" />
        <StatBadge label="复检合格" value={leakStore.retestPassCount()} percent={leakStore.closedPercent()} suffix="张" tone="success" />
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索设备型号 / 编号 / 处置人" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            处置单清单（{rows.length} / {leakStore.leaks.length}）
          </h3>
          <span className="muted">已复检合格 / 不合格的处置单保留原结论，标准调整不再退回</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的处置单"
            description="可在异常分级页对浓度异常读数直接派发处置单，重复提交不会产生新单。"
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
            scroll={{ x: 1500 }}
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
            <Select options={deviceOptions} showSearch disabled={Boolean(editingId)} />
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
          {editingId ? (
            <Form.Item field="state" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
              <Select options={LEAK_STATES.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
          ) : null}
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
        title="标准复核（标准值调整后）"
        onCancel={() => setReviewOpen(false)}
        onOk={submitReview}
        okText="提交复核结论"
        cancelText="取消"
        unmountOnExit
      >
        {target ? (
          <div className="muted" style={{ marginBottom: 12 }}>
            {target.reviewReason || '该处置单因标准值调整退回标准复核'}
            <br />
            原状态：{target.reviewFromState || '—'}；已复检合格的处置单不会进入此流程。
          </div>
        ) : null}
        <Form form={reviewForm} layout="vertical">
          <Form.Item field="decision" label="复核结论" rules={[{ required: true, message: '请选择复核结论' }]}>
            <Radio.Group direction="vertical">
              <Radio value="维持原结论">维持原异常结论（恢复到退回前状态，可继续处置 / 复检）</Radio>
              <Radio value="误报关闭">新标准下不再异常，判定为误报并闭环</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item field="reviewer" label="复核人" rules={[{ required: true, message: '请填写复核人' }]}>
            <Input placeholder="如 接班班长 王强" />
          </Form.Item>
          <Form.Item field="note" label="复核说明">
            <Input.TextArea placeholder="如 已按 2024-06-15 新标准复测，读数仍超标，维持原单" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
