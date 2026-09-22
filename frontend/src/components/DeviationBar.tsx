import type { HealthStatus } from '../api'

interface DeviationBarProps {
  /** z-score；learning 或无数据时传 null */
  zScore: number | null
  /** 测点状态，决定配色（学习中=中性灰） */
  status?: HealthStatus
  /** 可视量程（默认 ±4σ，超出截断显示） */
  range?: number
}

/**
 * z-score 偏差条：以 0 为中心，刻度线 ±2 / ±3；
 * |z|<2 中性色，2~3 warn，≥3 danger；风格与 AnalogBar 一致。
 */
export function DeviationBar({ zScore, status, range = 4 }: DeviationBarProps) {
  const valid = typeof zScore === 'number' && Number.isFinite(zScore)
  const clamped = valid ? Math.max(-range, Math.min(range, zScore)) : 0
  // 中心为 50%，左右各占 range
  const toPct = (z: number) => ((z + range) / (2 * range)) * 100
  const level: HealthStatus | 'none' = !valid ? 'none' : (status ?? (Math.abs(zScore) >= 3 ? 'abnormal' : Math.abs(zScore) >= 2 ? 'attention' : 'normal'))

  return (
    <div className={`dev dev--${level}`}>
      <div className="dev-track" role="meter" aria-valuemin={-range} aria-valuemax={range} aria-valuenow={valid ? zScore : undefined} aria-label="z-score 偏差">
        {/* ±2 / ±3 刻度线 */}
        {[2, 3].flatMap((t) => [-t, t]).map((t) => (
          <i key={t} className={`dev-tick dev-tick--${t}`} style={{ left: `${toPct(t)}%` }} />
        ))}
        {/* 0 中心线 */}
        <i className="dev-zero" />
        {valid && (
          <i
            className="dev-fill"
            style={
              clamped >= 0
                ? { left: '50%', width: `${toPct(clamped) - 50}%` }
                : { left: `${toPct(clamped)}%`, width: `${50 - toPct(clamped)}%` }
            }
          />
        )}
      </div>
      <div className="dev-scale mono">
        <span>-{range}</span>
        <span>0</span>
        <span>+{range}σ</span>
      </div>
    </div>
  )
}
