/**
 * 12 个子系统的静态清单（顺序/中文名与 backend/config/subsystems.yaml 一致）。
 * 侧栏分组、页内切换列表共用：WS 快照未就绪时也能渲染完整导航骨架。
 */
import type { TelemetryPoint } from './api'
import { POINT_META } from './paramMeta'

export type SubsystemDef = { id: string; label: string }

export const SUBSYSTEM_DEFS: SubsystemDef[] = [
  { id: 'main_fan', label: '主风机系统' },
  { id: 'cooling_water', label: '冷却水系统' },
  { id: 'rrs', label: '滚动路面/天平/转台' },
  { id: 'traverse', label: '移测架系统' },
  { id: 'boundary_layer', label: '边界层抽吸系统' },
  { id: 'purge_air', label: '吹扫风系统' },
  { id: 'exhaust', label: '尾气抽排系统' },
  { id: 'compressed_air', label: '压缩空气系统' },
  { id: 'safety', label: '安全连锁' },
  { id: 'acoustic', label: '声学测量' },
  { id: 'pressure', label: '压力测量' },
  { id: 'flow_field', label: '流场测量' },
]

/** ISA-101 状态点语义：正常 = 中性灰点，异常才上色（故障/未连接 = 红，降级/未就绪/本地接管 = 黄） */
export type SubsystemTone = 'ok' | 'warn' | 'danger'

export function subsystemTone(s?: { fault: boolean; ready: boolean; state: string } | null): SubsystemTone {
  if (!s) return 'ok' // 快照未就绪：中性
  if (s.fault || s.state === '故障' || s.state === '未连接') return 'danger'
  if (!s.ready || s.state === '降级' || s.state === '本地接管' || s.state === '连接中') return 'warn'
  return 'ok'
}

/** 关键读数：取有显示元数据的前 limit 个模拟量（总览卡片 2 个，详情右栏 4 个） */
export function keyReadings(points: TelemetryPoint[], limit = 2): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = []
  for (const p of points) {
    if (out.length >= limit) break
    const n = typeof p.value === 'number' ? p.value : Number(p.value)
    if (!POINT_META[p.key] || !Number.isFinite(n)) continue
    const prec = p.unit === 'mm' || p.unit === '%' ? 0 : 1
    out.push({ label: p.label, text: `${n.toFixed(prec)}${p.unit ? ` ${p.unit}` : ''}` })
  }
  return out
}
