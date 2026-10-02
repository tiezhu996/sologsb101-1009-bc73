/**
 * 站点、设备与点位状态（Zustand）
 * 维护站点/设备/点位列表、当前选中站点与筛选条件（点位作为设备的标准值档案一并维护）。
 * 标准值调整不直接覆盖：提交即生成带生效日期的版本与重算批次（见 utils/recalc）。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  deleteDeviceCascade,
  deletePointCascade,
  deleteStationCascade,
  readUiPrefs,
  writeUiPrefs,
  ROW_REVISION,
  type DeviceRow,
  type PointRow,
  type StandardVersionRow,
  type StationRow
} from '@/utils/db'
import { standardVersionId, INITIAL_VERSION_DATE } from '@/types/standardVersion'
import { submitStandardAdjustments, type StandardAdjustInput } from '@/utils/recalc'
import type { Device, DeviceDraft, DeviceState, DeviceType } from '@/types/device'
import type { Point, PointDraft, PointFilterState, PointTemplate, StandardDraft } from '@/types/point'
import { createEmptyPointFilter } from '@/types/point'
import type { Station, StationDraft, StationGrade } from '@/types/station'

export interface StationFilterState {
  keyword: string
  grades: StationGrade[]
  deviceTypes: DeviceType[]
}

export function createEmptyStationFilter(): StationFilterState {
  return { keyword: '', grades: [], deviceTypes: [] }
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

interface StationState {
  stations: Station[]
  devices: Device[]
  points: Point[]
  currentStationId: string | null
  filter: StationFilterState
  pointFilter: PointFilterState
  /** 标准值编辑草稿：点位 id → 待提交的上下限 */
  standardDraft: Record<string, StandardDraft>
  /** 标准值调整统一生效日期（历史读数按巡检日期取版本，新读数取最新版本） */
  adjustDate: string
  ready: boolean
  selectStation: (id: string | null) => void
  patchFilter: (patch: Partial<StationFilterState>) => void
  resetFilter: () => void
  patchPointFilter: (patch: Partial<PointFilterState>) => void
  resetPointFilter: () => void
  setAdjustDate: (date: string) => void
  createStation: (draft: StationDraft) => Promise<Station>
  updateStation: (id: string, patch: Partial<StationDraft>) => Promise<void>
  removeStation: (id: string) => Promise<void>
  createDevice: (draft: DeviceDraft) => Promise<Device>
  updateDevice: (id: string, patch: Partial<DeviceDraft>) => Promise<void>
  removeDevice: (id: string) => Promise<void>
  createPoint: (draft: PointDraft) => Promise<Point>
  updatePoint: (id: string, patch: Partial<PointDraft>) => Promise<void>
  removePoint: (id: string) => Promise<void>
  applyTemplate: (deviceId: string, templates: PointTemplate[]) => Promise<number>
  setStandardDraft: (pointId: string, draft: StandardDraft) => void
  clearStandardDraft: (pointId?: string) => void
  commitStandardDraft: (pointId: string) => Promise<boolean>
  commitAllStandardDrafts: () => Promise<number>
  buildAdjustments: () => StandardAdjustInput[]
  devicesOfStation: (stationId: string) => Device[]
  pointsOfDevice: (deviceId: string) => Point[]
  currentStation: () => Station | null
  filteredStations: () => Station[]
  pointStats: () => { total: number; critical: number }
}

export const useStationStore = create<StationState>((set, get) => ({
  stations: [],
  devices: [],
  points: [],
  currentStationId: readUiPrefs().lastStationId,
  filter: createEmptyStationFilter(),
  pointFilter: createEmptyPointFilter(),
  standardDraft: {},
  adjustDate: todayText(),
  ready: false,

  selectStation(id) {
    set({ currentStationId: id })
    writeUiPrefs({ ...readUiPrefs(), lastStationId: id })
  },

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: createEmptyStationFilter() })
  },

  patchPointFilter(patch) {
    set({ pointFilter: { ...get().pointFilter, ...patch } })
  },

  resetPointFilter() {
    set({ pointFilter: createEmptyPointFilter() })
  },

  setAdjustDate(date) {
    set({ adjustDate: date })
  },

  async createStation(draft) {
    const now = Date.now()
    const row: StationRow = {
      id: createId('st'),
      name: draft.name.trim(),
      location: draft.location.trim(),
      designFlowM3h: Number(draft.designFlowM3h) || 0,
      inletPressureMpa: Number(draft.inletPressureMpa) || 0,
      grade: draft.grade,
      commissionDate: draft.commissionDate,
      createdAt: now,
      updatedAt: now
    }
    await db.stations.put(row)
    get().selectStation(row.id)
    return row
  },

  async updateStation(id, patch) {
    const next: Partial<StationRow> = { ...patch, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.location !== undefined) next.location = patch.location.trim()
    await db.stations.update(id, next)
  },

  async removeStation(id) {
    await deleteStationCascade(id)
    if (get().currentStationId === id) {
      const fallback = get().stations.find((station) => station.id !== id) ?? null
      get().selectStation(fallback ? fallback.id : null)
    }
  },

  async createDevice(draft) {
    const now = Date.now()
    const row: DeviceRow = {
      id: createId('dv'),
      stationId: draft.stationId || get().currentStationId || '',
      type: draft.type,
      model: draft.model.trim(),
      serialNo: draft.serialNo.trim(),
      installDate: draft.installDate,
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.devices.put(row)
    return row
  },

  async updateDevice(id, patch) {
    const next: Partial<DeviceRow> = { ...patch, updatedAt: Date.now() }
    if (patch.model !== undefined) next.model = patch.model.trim()
    if (patch.serialNo !== undefined) next.serialNo = patch.serialNo.trim()
    await db.devices.update(id, next)
  },

  async removeDevice(id) {
    await deleteDeviceCascade(id)
  },

  async createPoint(draft) {
    const now = Date.now()
    const device = await db.devices.get(draft.deviceId)
    const min = Math.min(Number(draft.standardMin) || 0, Number(draft.standardMax) || 0)
    const maxInput = Math.max(Number(draft.standardMin) || 0, Number(draft.standardMax) || 0)
    const max = maxInput > min ? maxInput : min + 0.001
    const pointId = createId('pt')
    const row: PointRow = {
      id: pointId,
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      name: draft.name.trim(),
      standardMin: min,
      standardMax: max,
      unit: draft.unit,
      isCritical: draft.isCritical,
      createdAt: now,
      updatedAt: now
    }
    // 新建点位自带一条初始版本（生效日期取今天；新点位无历史读数）
    const initialVersion: StandardVersionRow = {
      id: standardVersionId(pointId, INITIAL_VERSION_DATE),
      versionNo: 1,
      pointId,
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      effectiveDate: INITIAL_VERSION_DATE,
      standardMin: min,
      standardMax: max,
      unit: draft.unit,
      isCritical: draft.isCritical,
      source: 'initial',
      recalcBatchId: '',
      note: '新建点位初始版本',
      createdAt: now,
      updatedAt: now,
      revision: ROW_REVISION
    }
    await db.transaction('rw', [db.points, db.standardVersions], async () => {
      await db.points.put(row)
      await db.standardVersions.put(initialVersion)
    })
    return row
  },

  async updatePoint(id, patch) {
    const current = await db.points.get(id)
    // 非标准字段（名称/设备/单位）直接改点位档案
    const metaPatch: Partial<PointRow> = { updatedAt: Date.now() }
    let touchedMeta = false
    if (patch.name !== undefined) {
      metaPatch.name = patch.name.trim()
      touchedMeta = true
    }
    if (patch.deviceId !== undefined) {
      metaPatch.deviceId = patch.deviceId
      const device = await db.devices.get(patch.deviceId)
      if (device) metaPatch.stationId = device.stationId
      touchedMeta = true
    }
    if (patch.unit !== undefined) {
      metaPatch.unit = patch.unit
      touchedMeta = true
    }
    if (touchedMeta) await db.points.update(id, metaPatch)

    // 标准字段（上下限/关键点）不覆盖：走版本 + 重算批次
    const standardChanged =
      patch.standardMin !== undefined || patch.standardMax !== undefined || patch.isCritical !== undefined
    if (standardChanged && current) {
      await submitStandardAdjustments([
        {
          pointId: id,
          effectiveDate: get().adjustDate,
          standardMin: patch.standardMin ?? current.standardMin,
          standardMax: patch.standardMax ?? current.standardMax,
          isCritical: patch.isCritical ?? current.isCritical
        }
      ])
    }
  },

  async removePoint(id) {
    await deletePointCascade(id)
    get().clearStandardDraft(id)
  },

  async applyTemplate(deviceId, templates) {
    const device = await db.devices.get(deviceId)
    const stationId = device ? device.stationId : ''
    const existing = get().points.filter((point) => point.deviceId === deviceId).map((point) => point.name)
    const now = Date.now()
    const rows: PointRow[] = []
    const versions: StandardVersionRow[] = []
    templates
      .filter((template) => !existing.includes(template.name))
      .forEach((template) => {
        const pointId = createId('pt')
        rows.push({
          id: pointId,
          deviceId,
          stationId,
          name: template.name,
          standardMin: template.standardMin,
          standardMax: template.standardMax,
          unit: template.unit,
          isCritical: template.isCritical,
          createdAt: now,
          updatedAt: now
        })
        versions.push({
          id: standardVersionId(pointId, INITIAL_VERSION_DATE),
          versionNo: 1,
          pointId,
          deviceId,
          stationId,
          effectiveDate: INITIAL_VERSION_DATE,
          standardMin: template.standardMin,
          standardMax: template.standardMax,
          unit: template.unit,
          isCritical: template.isCritical,
          source: 'initial',
          recalcBatchId: '',
          note: '模板复制初始版本',
          createdAt: now,
          updatedAt: now,
          revision: ROW_REVISION
        })
      })
    if (rows.length > 0) {
      await db.transaction('rw', [db.points, db.standardVersions], async () => {
        await db.points.bulkPut(rows)
        await db.standardVersions.bulkPut(versions)
      })
    }
    return rows.length
  },

  setStandardDraft(pointId, draft) {
    set({ standardDraft: { ...get().standardDraft, [pointId]: draft } })
  },

  clearStandardDraft(pointId) {
    if (pointId === undefined) {
      set({ standardDraft: {} })
      return
    }
    const next = { ...get().standardDraft }
    delete next[pointId]
    set({ standardDraft: next })
  },

  buildAdjustments() {
    const state = get()
    return Object.entries(state.standardDraft)
      .map(([pointId, draft]) => {
        const min = Math.min(draft.standardMin, draft.standardMax)
        const maxInput = Math.max(draft.standardMin, draft.standardMax)
        return {
          pointId,
          effectiveDate: state.adjustDate,
          standardMin: min,
          standardMax: maxInput > min ? maxInput : min + 0.001,
          isCritical: draft.isCritical
        }
      })
  },

  async commitStandardDraft(pointId) {
    const draft = get().standardDraft[pointId]
    if (!draft) return false
    const [adjustment] = get().buildAdjustments().filter((item) => item.pointId === pointId)
    if (!adjustment) return false
    await submitStandardAdjustments([adjustment])
    get().clearStandardDraft(pointId)
    return true
  },

  async commitAllStandardDrafts() {
    const adjustments = get().buildAdjustments()
    if (adjustments.length === 0) return 0
    await submitStandardAdjustments(adjustments)
    const count = adjustments.length
    get().clearStandardDraft()
    return count
  },

  devicesOfStation(stationId) {
    return get().devices.filter((device) => device.stationId === stationId)
  },

  pointsOfDevice(deviceId) {
    return get().points.filter((point) => point.deviceId === deviceId)
  },

  currentStation() {
    return get().stations.find((station) => station.id === get().currentStationId) ?? null
  },

  filteredStations() {
    const { stations, filter } = get()
    const text = filter.keyword.trim().toLowerCase()
    return stations.filter((station) => {
      if (filter.grades.length > 0 && !filter.grades.includes(station.grade)) return false
      if (filter.deviceTypes.length > 0) {
        const has = get().devices.some(
          (device) => device.stationId === station.id && filter.deviceTypes.includes(device.type)
        )
        if (!has) return false
      }
      if (text.length === 0) return true
      return station.name.toLowerCase().includes(text) || station.location.toLowerCase().includes(text)
    })
  },

  pointStats() {
    const points = get().points
    return { total: points.length, critical: points.filter((point) => point.isCritical).length }
  }
}))

liveQuery(async () => (await db.stations.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))).subscribe({
  next: (rows) => useStationStore.setState({ stations: rows, ready: true }),
  error: () => useStationStore.setState({ ready: true })
})

liveQuery(async () => (await db.devices.toArray()).sort((a, b) => a.serialNo.localeCompare(b.serialNo))).subscribe({
  next: (rows) => useStationStore.setState({ devices: rows })
})

liveQuery(async () =>
  (await db.points.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
).subscribe({
  next: (rows) => useStationStore.setState({ points: rows })
})

export type { DeviceState, DeviceType }
