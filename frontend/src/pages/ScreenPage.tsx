import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  api,
  type AiAlert,
  type AlertSummary,
  type HealthSubsystem,
  type HistorySeries,
  type MatrixStatus,
  type TestMatrix,
} from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import {
  countAlertsBySub,
  isHazardSafety,
  parseScreenConfig,
  safetyTone,
  SCREEN_MODES,
  sliceSubsystems,
  useScale,
} from '../components/screen/config'
import { ScreenHeader } from '../components/screen/ScreenHeader'
import { ScreenFooter } from '../components/screen/ScreenFooter'
import { OverviewMode } from '../components/screen/OverviewMode'
import { MatrixMode } from '../components/screen/MatrixMode'
import { TrendsMode } from '../components/screen/TrendsMode'
import { AlertsMode } from '../components/screen/AlertsMode'
import { ScheduleMode } from '../components/screen/ScheduleMode'

/** overview 双轴趋势测点（近 20 分钟） */
const OVERVIEW_POINTS = ['main_fan.wind_speed', 'cooling_water.supply_temp']
/** trends 模式 2×2 图测点（单次查询，均在有宽表历史的点集内） */
const TREND_POINTS = [
  'main_fan.wind_speed',
  'main_fan.target_speed',
  'cooling_water.supply_temp',
  'cooling_water.return_temp',
  'rrs.fx',
  'rrs.fz',
  'acoustic.spl',
]

function toSeriesMap(series: HistorySeries[]): Map<string, HistorySeries> {
  return new Map(series.map((s) => [s.key, s]))
}

/**
 * 总控大屏（纯展示，无任何操作控件；模式/切片/轮换全部走 URL 参数）：
 * ?mode=overview|matrix|trends|alerts  ?part=1/2|2/2  ?subs=id,...  ?rotate=秒  ?kiosk=1
 */
export function ScreenPage() {
  const location = useLocation()
  const cfg = useMemo(() => parseScreenConfig(location.search), [location.search])
  const { frame, connected } = useTelemetry()
  const scale = useScale()
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<number | undefined>(undefined)

  // —— 模式轮换（rotate 秒一切；只切 mode，part/subs 保持） ——
  const [rotTick, setRotTick] = useState(0)
  useEffect(() => {
    if (!cfg.rotate) return
    const t = window.setInterval(() => setRotTick((v) => v + 1), cfg.rotate * 1000)
    return () => window.clearInterval(t)
  }, [cfg.rotate])
  const startIdx = SCREEN_MODES.indexOf(cfg.mode)
  const mode = cfg.rotate ? SCREEN_MODES[(startIdx + rotTick) % SCREEN_MODES.length] : cfg.mode

  // —— 3 秒无操作隐藏光标 ——
  useEffect(() => {
    const onMove = () => {
      setIdle(false)
      window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => setIdle(true), 3000)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('pointerdown', onMove)
    onMove()
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('pointerdown', onMove)
      window.clearTimeout(idleTimer.current)
    }
  }, [])

  // —— 历史趋势刷新周期：消费系统设置 large_screen_refresh_ms（默认 30s，钳制 5s~120s） ——
  const [refreshMs, setRefreshMs] = useState(30000)
  useEffect(() => {
    api
      .settings()
      .then((s) => {
        const v = Number(s.large_screen_refresh_ms)
        if (Number.isFinite(v) && v >= 5000) setRefreshMs(Math.min(v, 120000))
      })
      .catch(() => {})
  }, [])

  // —— 告警 + 健康基线轮询（12s） ——
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  const [summary, setSummary] = useState<AlertSummary | null>(null)
  const [health, setHealth] = useState<Map<string, HealthSubsystem>>(new Map())
  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const [a, s, h] = await Promise.all([
          api.aiAlerts({ active: true, acked: false, limit: 200 }),
          api.aiAlertSummary(),
          api.twinHealth(),
        ])
        if (stop) return
        setAlerts(a)
        setSummary(s)
        setHealth(new Map(h.subsystems.map((x) => [x.id, x])))
      } catch {
        /* 轮询失败保持现状 */
      }
    }
    poll()
    const t = window.setInterval(poll, 12000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [])

  // —— 矩阵执行进度（列表 15s；有运行/暂停的矩阵时状态 5s） ——
  const [matrices, setMatrices] = useState<TestMatrix[]>([])
  useEffect(() => {
    let stop = false
    const poll = () =>
      api
        .matrices()
        .then((ms) => {
          if (!stop) setMatrices(ms)
        })
        .catch(() => {})
    poll()
    const t = window.setInterval(poll, 15000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [])
  const runningMatrixId =
    matrices.find((m) => m.exec_status === 'running' || m.exec_status === 'paused')?.id ?? null
  const [matrixRun, setMatrixRun] = useState<MatrixStatus | null>(null)
  useEffect(() => {
    if (!runningMatrixId) return
    let stop = false
    const poll = () =>
      api
        .matrixStatus(runningMatrixId)
        .then((s) => {
          if (!stop) setMatrixRun(s)
        })
        .catch(() => {})
    poll()
    const t = window.setInterval(poll, 5000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [runningMatrixId])
  // 仅当状态与当前运行中的矩阵匹配时展示，避免切换瞬间显示旧数据
  const matrixForFooter = matrixRun && matrixRun.matrix_id === runningMatrixId ? matrixRun : null

  // —— overview 历史趋势（近 20 分钟，bucket 10s） ——
  const [overviewHistory, setOverviewHistory] = useState<Map<string, HistorySeries>>(new Map())
  useEffect(() => {
    if (mode !== 'overview') return
    let stop = false
    const load = () =>
      api
        .historyQuery({ points: OVERVIEW_POINTS, from: '-20m', bucket_sec: 10, agg: 'avg' })
        .then((r) => {
          if (!stop) setOverviewHistory(toSeriesMap(r.points))
        })
        .catch(() => {})
    load()
    const t = window.setInterval(load, refreshMs)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [mode, refreshMs])

  // —— trends 历史趋势（近 30 分钟，bucket 10s，单次查询 7 测点） ——
  const [trendHistory, setTrendHistory] = useState<Map<string, HistorySeries>>(new Map())
  useEffect(() => {
    if (mode !== 'trends') return
    let stop = false
    const load = () =>
      api
        .historyQuery({ points: TREND_POINTS, from: '-30m', bucket_sec: 10, agg: 'avg' })
        .then((r) => {
          if (!stop) setTrendHistory(toSeriesMap(r.points))
        })
        .catch(() => {})
    load()
    const t = window.setInterval(load, refreshMs)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [mode, refreshMs])

  // —— alerts 近 7 天分布（60s） ——
  const [daily, setDaily] = useState<{ day: string; count: number }[]>([])
  useEffect(() => {
    if (mode !== 'alerts') return
    let stop = false
    const load = () =>
      api
        .statsOverview(7)
        .then((r) => {
          if (!stop) setDaily(r.alerts.by_day)
        })
        .catch(() => {})
    load()
    const t = window.setInterval(load, 60000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [mode])

  const alertBySub = useMemo(() => countAlertsBySub(alerts), [alerts])
  const matrixDefs = useMemo(() => sliceSubsystems(cfg), [cfg])

  const ov = frame?.overview
  const safety = ov?.safety ?? '--'
  const tone = safetyTone(ov?.safety)
  const hazard = isHazardSafety(ov?.safety)
  const dataTime = frame?.server_time ? frame.server_time.replace('T', ' ').slice(0, 19) : '--'

  return (
    <div className={`screen-root${idle ? ' cursor-hidden' : ''}`}>
      <ScreenHeader
        mode={mode}
        rotating={cfg.rotate > 0}
        safety={safety}
        tone={tone}
        alertTotal={summary?.total ?? 0}
      />
      {hazard && <div className="screen-hazard">全局安全状态：{safety} · 请立即确认现场与设备安全</div>}
      {!connected && <div className="screen-offline">遥测链路中断，正在自动重连… 当前显示为最近一次数据</div>}

      <div className="screen-body">
        {mode === 'overview' && (
          <OverviewMode frame={frame} alertBySub={alertBySub} history={overviewHistory} scale={scale} />
        )}
        {mode === 'matrix' && (
          <MatrixMode defs={matrixDefs} frame={frame} health={health} alertBySub={alertBySub} scale={scale} />
        )}
        {mode === 'trends' && <TrendsMode data={trendHistory} scale={scale} />}
        {mode === 'alerts' && <AlertsMode alerts={alerts} summary={summary} daily={daily} scale={scale} />}
        {mode === 'schedule' && <ScheduleMode privacy={cfg.privacy} />}
      </div>

      <ScreenFooter
        connected={connected}
        phase={ov?.experiment_phase ?? ''}
        matrix={matrixForFooter}
        dataTime={dataTime}
      />
    </div>
  )
}
