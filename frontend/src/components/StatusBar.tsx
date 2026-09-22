import { useEffect, useRef, useState } from 'react'
import { api, type UserInfo } from '../api'
import { useTelemetry } from '../hooks/useTelemetry'

function fmtClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 安全状态等级（ISA-101：正常中性、异常才上色） */
function safetyClass(s: string) {
  if (s === '急停' || s === '安全停机') return 'text-danger'
  if (s === '报警' || s === '预警') return 'text-warn'
  return ''
}

/**
 * 底部状态栏（SCADA 风格）：
 * 左 = WS 链路 / 全局安全 / 当前场景 / 实验阶段；右 = 服务器时间 / 用户·角色 / 版本。
 * 数据全部复用现有通道：useTelemetry 的 WS 帧 + 一次性的 /api/system/info、/api/experiments。
 */
export function StatusBar({ user }: { user: UserInfo }) {
  const { frame, connected } = useTelemetry()
  const [version, setVersion] = useState('')
  const [clock, setClock] = useState('')
  const baseRef = useRef<{ t: number; at: number } | null>(null)

  // 版本号：/api/system/info 拿一次
  useEffect(() => {
    api
      .systemInfo()
      .then((i) => setVersion(i.version || i.app_version))
      .catch(() => {})
  }, [])

  const overview = frame?.overview
  const activeExpId = overview?.active_experiment_id ?? null

  // 当前场景：由活动实验 id 反查实验定义（仅在活动实验变化时请求）
  // id 变化时在渲染期重置缓存（避免 effect 内同步 setState），再异步补全场景名
  const [expCache, setExpCache] = useState<{ id: string | null; scenario: string }>({ id: null, scenario: '' })
  if (expCache.id !== activeExpId) setExpCache({ id: activeExpId, scenario: '' })
  useEffect(() => {
    if (!activeExpId) return
    let stop = false
    api
      .experiments()
      .then((list) => {
        if (stop) return
        const exp = list.find((e) => e.id === activeExpId)
        setExpCache({ id: activeExpId, scenario: exp ? exp.scenario : '' })
      })
      .catch(() => {})
    return () => {
      stop = true
    }
  }, [activeExpId])
  const scenario = expCache.id === activeExpId ? expCache.scenario : ''

  // 服务器时间：以最新 WS 帧的 server_time 为基准，本地秒级走字
  useEffect(() => {
    const raw = frame?.server_time ?? frame?.overview.server_time
    if (!raw) return
    const t = Date.parse(raw)
    if (Number.isFinite(t)) baseRef.current = { t, at: performance.now() }
  }, [frame])

  useEffect(() => {
    const tick = () => {
      const base = baseRef.current
      setClock(fmtClock(base ? new Date(base.t + (performance.now() - base.at)) : new Date()))
    }
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [])

  const safety = overview?.safety ?? '--'
  const phase = overview?.experiment_phase ?? '空闲'

  return (
    <footer className="status-bar">
      <div className="status-bar-side">
        <span className="status-item">
          <i className={`status-dot ${connected ? '' : 'down'}`} />
          链路 {connected ? '已连接' : '断开'}
        </span>
        <span className={`status-item ${safetyClass(safety)}`}>安全 {safety}</span>
        <span className="status-item">场景 {scenario || '--'}</span>
        <span className="status-item">阶段 {phase}</span>
      </div>
      <div className="status-bar-side">
        <span className="status-item">{clock}</span>
        <span className="status-item">
          {user.display_name} · {user.role}
        </span>
        <span className="status-item">v{version || '--'}</span>
      </div>
    </footer>
  )
}
