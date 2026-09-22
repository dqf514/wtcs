import { useMemo } from 'react'
import type { HistorySeries } from '../../api'
import type { TelemetryFrame } from '../../hooks/useTelemetry'
import { keyReadings, SUBSYSTEM_DEFS, subsystemTone } from '../../subsystems'
import { POINT_META, type PointMeta } from '../../paramMeta'
import { SUBSYSTEM_ICONS } from '../icons'
import { Chart } from '../Chart'
import { CHART_COLORS_DARK as C } from '../chartColors'
import { buildTrendOption } from './charts'
import { safetyTone, type Tone } from './config'

interface Props {
  frame: TelemetryFrame | null
  alertBySub: Map<string, number>
  /** main_fan.wind_speed / cooling_water.supply_temp 近 20 分钟序列 */
  history: Map<string, HistorySeries>
  scale: number
}

/** overview 综合态势：上部主 KPI（风速巨数+区间带 / 温度 / 阶段 / 安全态），中部双轴趋势，下部 12 子系统紧凑网格 */
export function OverviewMode({ frame, alertBySub, history, scale }: Props) {
  const ov = frame?.overview
  const subsystems = frame?.subsystems ?? []

  const mainFan = subsystems.find((s) => s.id === 'main_fan')
  const target = (() => {
    const v = Number(mainFan?.points.find((p) => p.key === 'target_speed')?.value)
    return Number.isFinite(v) ? v : null
  })()

  const windMeta = POINT_META.wind_speed
  const tempMeta = POINT_META.supply_temp
  const wind = ov?.wind_speed
  const temp = ov?.temperature
  const windTone: Tone = wind == null ? 'ok' : wind > windMeta.normal[1] ? 'danger' : 'ok'
  const tempTone: Tone =
    temp == null ? 'ok' : temp < tempMeta.normal[0] || temp > tempMeta.normal[1] ? 'warn' : 'ok'
  const safeTone = safetyTone(ov?.safety)

  const option = useMemo(
    () =>
      buildTrendOption(
        history,
        [
          { key: 'main_fan.wind_speed', color: C.accent2, width: 3, normalBand: true, target },
          { key: 'cooling_water.supply_temp', yAxisIndex: 1, color: C.muted, width: 2 },
        ],
        ['风速 m/s', '温度 ℃'],
        scale,
      ),
    [history, target, scale],
  )

  return (
    <div className="ov-root">
      <div className="ov-kpis">
        <div className="scr-hero">
          <div className="scr-hero-label">试验段风速</div>
          <div className={`scr-hero-value mono${windTone === 'ok' ? '' : ` scr-${windTone}`}`}>
            {wind != null ? wind.toFixed(1) : '--'}
            <em>m/s</em>
          </div>
          <RangeBand value={wind} meta={windMeta} target={target} tone={windTone} />
          <div className="scr-hero-sub">{target != null ? `目标 ${target.toFixed(1)} m/s` : '目标 --'}</div>
        </div>
        <div className="scr-hero">
          <div className="scr-hero-label">风洞温度</div>
          <div className={`scr-hero-value mono${tempTone === 'ok' ? '' : ` scr-${tempTone}`}`}>
            {temp != null ? temp.toFixed(1) : '--'}
            <em>℃</em>
          </div>
          <RangeBand value={temp} meta={tempMeta} tone={tempTone} />
          <div className="scr-hero-sub">
            正常 {tempMeta.normal[0]}~{tempMeta.normal[1]} ℃
          </div>
        </div>
        <div className="scr-hero">
          <div className="scr-hero-label">实验阶段</div>
          <div className="scr-hero-value scr-hero-value--sm">{ov?.experiment_phase ?? '空闲'}</div>
          <div className="scr-hero-sub">
            {ov?.active_experiment_id ? `实验 ${ov.active_experiment_id}` : '当前无进行中的实验'}
          </div>
        </div>
        <div className="scr-hero">
          <div className="scr-hero-label">安全状态</div>
          <div className={`scr-hero-value scr-hero-value--sm${safeTone === 'ok' ? '' : ` scr-${safeTone}`}`}>
            {ov?.safety ?? '--'}
          </div>
          <div className="scr-hero-sub">
            故障子系统 {ov?.fault_count ?? 0} · 在线 {ov?.connected_count ?? 0}/{subsystems.length || 12}
          </div>
        </div>
      </div>

      <div className="scr-panel">
        <div className="scr-panel-head">
          <span className="scr-panel-title">风速 / 温度趋势 · 近 20 分钟</span>
        </div>
        <div className="scr-panel-body">
          <Chart option={option} className="scr-chart" />
        </div>
      </div>

      <div className="ov-subs">
        {SUBSYSTEM_DEFS.map((d) => {
          const live = subsystems.find((s) => s.id === d.id)
          const tone = subsystemTone(live)
          const Icon = SUBSYSTEM_ICONS[d.id] || SUBSYSTEM_ICONS.main_fan
          const alertCount = alertBySub.get(d.id) ?? 0
          const readings = live ? keyReadings(live.points, 2) : []
          const iconSize = Math.round(16 * scale)
          return (
            <div className={`scr-sub scr-sub--${tone}`} key={d.id}>
              <div className="scr-sub-head">
                <span className="scr-sub-icon">
                  <Icon size={iconSize} />
                </span>
                <span className="scr-sub-name">{live?.name ?? d.label}</span>
                {alertCount > 0 && <span className="scr-sub-alert mono">{alertCount}</span>}
                <span className={`scr-sub-state scr-sub-state--${tone}`}>
                  {live ? (live.fault ? '故障' : live.ready ? '就绪' : live.state) : '--'}
                </span>
              </div>
              {readings.map((r) => (
                <div className="scr-sub-reading mono" key={r.label}>
                  <span>{r.label}</span>
                  {r.text}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** ISA-101 量程带：正常区间中性灰带 + 实时填充（越限才变色）+ 目标标线 */
function RangeBand({
  value,
  meta,
  target,
  tone,
}: {
  value: number | null | undefined
  meta: PointMeta
  target?: number | null
  tone: Tone
}) {
  const span = meta.max - meta.min
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - meta.min) / span) * 100))
  return (
    <div className={`scr-band scr-band--${tone}`}>
      <i
        className="scr-band-normal"
        style={{ left: `${pct(meta.normal[0])}%`, width: `${pct(meta.normal[1]) - pct(meta.normal[0])}%` }}
      />
      {value != null && <i className="scr-band-fill" style={{ width: `${pct(value)}%` }} />}
      {target != null && <i className="scr-band-target" style={{ left: `${pct(target)}%` }} />}
    </div>
  )
}
