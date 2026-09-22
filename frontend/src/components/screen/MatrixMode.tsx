import type { HealthSubsystem } from '../../api'
import type { TelemetryFrame } from '../../hooks/useTelemetry'
import { keyReadings, subsystemTone, type SubsystemDef } from '../../subsystems'
import { CHART_COLORS_DARK as C } from '../chartColors'
import { SUBSYSTEM_ICONS } from '../icons'

interface Props {
  /** 切片后的子系统清单（part / subs 参数决定） */
  defs: SubsystemDef[]
  frame: TelemetryFrame | null
  health: Map<string, HealthSubsystem>
  alertBySub: Map<string, number>
  scale: number
}

const HEALTH_FILL: Record<string, string> = {
  normal: 'rgba(214, 222, 232, 0.45)',
  attention: C.warn,
  abnormal: C.danger,
  learning: C.muted,
}

/** matrix 子系统矩阵：大卡片（图标 + 名称 + 状态 + 大字读数 + 健康度条 + 未确认告警数） */
export function MatrixMode({ defs, frame, health, alertBySub, scale }: Props) {
  const subsystems = frame?.subsystems ?? []
  const cols = defs.length <= 2 ? defs.length : defs.length <= 4 ? 2 : 3
  const iconSize = Math.round(24 * scale)
  return (
    <div className="mx-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {defs.map((d) => {
        const live = subsystems.find((s) => s.id === d.id)
        const tone = subsystemTone(live)
        const Icon = SUBSYSTEM_ICONS[d.id] || SUBSYSTEM_ICONS.main_fan
        const alertCount = alertBySub.get(d.id) ?? 0
        const readings = live ? keyReadings(live.points, 4) : []
        const h = health.get(d.id)
        const score = h?.score ?? null
        return (
          <div className={`mx-card mx-card--${tone}`} key={d.id}>
            <div className="mx-head">
              <span className="mx-icon">
                <Icon size={iconSize} />
              </span>
              <span className="mx-name">{live?.name ?? d.label}</span>
              {alertCount > 0 && <span className="scr-sub-alert mono">{alertCount}</span>}
            </div>
            <div className="mx-states">
              <span className={`scr-sub-state scr-sub-state--${tone}`}>
                {live ? (live.fault ? '故障' : live.ready ? '就绪' : live.state) : '--'}
              </span>
              <span className="scr-sub-state">{live?.mode === 'simulation' ? '仿真' : '真机'}</span>
            </div>
            <div className="mx-readings">
              {readings.length ? (
                readings.map((r) => (
                  <div className="mx-reading" key={r.label}>
                    <span className="mx-reading-label">{r.label}</span>
                    <span className="mx-reading-value mono">{r.text}</span>
                  </div>
                ))
              ) : (
                <div className="mx-reading">
                  <span className="mx-reading-label">读数</span>
                  <span className="mx-reading-value mono">--</span>
                </div>
              )}
            </div>
            <div className="mx-health">
              <span className="mx-health-label">健康度</span>
              <span className="mx-health-bar">
                <i
                  style={{
                    width: `${score != null ? Math.min(100, Math.max(0, score)) : 0}%`,
                    background: HEALTH_FILL[h?.status ?? 'learning'] ?? HEALTH_FILL.learning,
                  }}
                />
              </span>
              <span className="mx-health-num mono">{score != null ? Math.round(score) : '--'}</span>
              <span className="mx-health-status">{h?.status_cn ?? '学习中'}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
