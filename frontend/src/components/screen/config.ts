/**
 * 大屏公共层：URL 参数解析、显示模式定义、远读缩放、时间工具。
 * 大屏为纯展示页面：模式切换 / 多屏切片全部走 query string，由部署时各电视的浏览器首页决定。
 */
import { useEffect, useState } from 'react'
import { SUBSYSTEM_DEFS, type SubsystemDef } from '../../subsystems'

export type ScreenMode = 'overview' | 'matrix' | 'trends' | 'alerts' | 'schedule'

/** 轮换顺序（?rotate= 生效时按此循环，mode 参数作为起点） */
export const SCREEN_MODES: ScreenMode[] = ['overview', 'matrix', 'trends', 'alerts', 'schedule']

export const MODE_LABEL: Record<ScreenMode, string> = {
  overview: '综合态势',
  matrix: '子系统矩阵',
  trends: '趋势分析',
  alerts: '告警态势',
  schedule: '排程看板',
}

export interface ScreenConfig {
  mode: ScreenMode
  /** 轮换间隔秒；0 = 不轮换 */
  rotate: number
  /** matrix 模式切片：1 = 前 6 个，2 = 后 6 个 */
  part: 1 | 2 | null
  /** 显式子系统子集（任意模式生效，优先于 part） */
  subs: string[] | null
  /** schedule 模式：1 = 客户等候区（去标识化），0 = 控制室（完整） */
  privacy: 0 | 1
}

export function parseScreenConfig(search: string): ScreenConfig {
  const p = new URLSearchParams(search)
  const rawMode = p.get('mode') ?? ''
  const mode: ScreenMode = (SCREEN_MODES as string[]).includes(rawMode) ? (rawMode as ScreenMode) : 'overview'
  const rotateRaw = Number(p.get('rotate'))
  const rotate = Number.isFinite(rotateRaw) && rotateRaw >= 5 ? Math.min(3600, Math.floor(rotateRaw)) : 0
  const partRaw = p.get('part') ?? ''
  const part = partRaw === '1/2' ? 1 : partRaw === '2/2' ? 2 : null
  const known = new Set(SUBSYSTEM_DEFS.map((d) => d.id))
  const subs = (p.get('subs') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => known.has(s))
  const privacy: 0 | 1 = p.get('privacy') === '0' ? 0 : 1
  return { mode, rotate, part, subs: subs.length ? subs : null, privacy }
}

/** 子系统切片：subs 显式子集优先，其次 part 对半分；overview 网格始终全量（调用方自行判断） */
export function sliceSubsystems(cfg: ScreenConfig): SubsystemDef[] {
  if (cfg.subs) {
    const wanted = new Set(cfg.subs)
    return SUBSYSTEM_DEFS.filter((d) => wanted.has(d.id))
  }
  if (cfg.part) {
    const half = Math.ceil(SUBSYSTEM_DEFS.length / 2)
    return cfg.part === 1 ? SUBSYSTEM_DEFS.slice(0, half) : SUBSYSTEM_DEFS.slice(half)
  }
  return SUBSYSTEM_DEFS
}

export type Tone = 'ok' | 'warn' | 'danger'

/** 全局安全状态语义：急停/安全停止 = 最高级别通栏警示 */
export function safetyTone(safety: string | undefined): Tone {
  if (!safety) return 'ok'
  if (safety === '急停' || safety.includes('安全停')) return 'danger'
  if (safety === '报警' || safety === '预警') return 'warn'
  return 'ok'
}

export function isHazardSafety(safety: string | undefined): boolean {
  return safetyTone(safety) === 'danger'
}

/** 远读缩放系数：1080p 短边 ≈ 1，4K ≈ 2；用于 ECharts 字号（canvas 不认 vmin） */
export function useScale(): number {
  const calc = () => Math.min(2.2, Math.max(0.8, Math.min(window.innerWidth, window.innerHeight) / 1000))
  const [scale, setScale] = useState(calc)
  useEffect(() => {
    const onResize = () => setScale(calc())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return scale
}

/** 秒级时钟（顶栏时钟 / 告警持续时间共用） */
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(t)
  }, [stepMs])
  return now
}

export function fmtClock(now: number): { time: string; date: string } {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  const week = '日一二三四五六'[d.getDay()]
  return {
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    date: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${week}`,
  }
}

function p2(n: number) {
  return String(n).padStart(2, '0')
}

/** 告警持续时间（大屏远读格式：1h 23m / 12m 03s / 45s） */
export function fmtDuration(fromTs: string, now: number): string {
  const t = new Date(fromTs).getTime()
  if (!Number.isFinite(t)) return '--'
  let s = Math.max(0, Math.floor((now - t) / 1000))
  const h = Math.floor(s / 3600)
  s %= 3600
  const m = Math.floor(s / 60)
  s %= 60
  if (h) return `${h}h ${p2(m)}m`
  if (m) return `${m}m ${p2(s)}s`
  return `${s}s`
}

/** 每个子系统的未确认活动告警计数（overview 角标 / matrix 卡片共用） */
export function countAlertsBySub(alerts: { subsystem_id: string }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const a of alerts) m.set(a.subsystem_id, (m.get(a.subsystem_id) ?? 0) + 1)
  return m
}
