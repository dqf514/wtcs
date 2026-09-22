import type { TelemetryPoint } from '../../api'

function num(points: TelemetryPoint[], key: string): number | null {
  const v = points.find((p) => p.key === key)?.value
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function bool(points: TelemetryPoint[], key: string): boolean {
  const v = points.find((p) => p.key === key)?.value
  return v === true || v === 1 || v === 'true'
}

/** 主风机系统工艺示意图：电机 → 变频器 → 风机 → 试验段气流方向（数据驱动，风格同总控台场景图） */
export function FanSchematic({ points, fault }: { points: TelemetryPoint[]; fault: boolean }) {
  const wind = num(points, 'wind_speed')
  const freq = num(points, 'frequency')
  const power = num(points, 'power')
  const running = bool(points, 'running')
  const stroke = fault ? 'var(--danger)' : 'var(--muted)'
  // 气流线宽度/透明度随风速驱动（与总控台一致，无装饰性动画）
  const flowWidth = 2 + Math.min(8, (wind ?? 0) / 12)
  const flowOpacity = wind != null && wind > 0.5 ? 0.85 : 0.25

  return (
    <svg className="scene-svg" viewBox="0 0 720 190" role="img" aria-label="主风机系统工艺示意图">
      <rect x="10" y="10" width="700" height="170" rx="14" fill="var(--bg-3)" stroke="var(--line)" />
      {/* 设备链路：电机 → 变频器 → 风机 */}
      <line x1="120" y1="95" x2="180" y2="95" stroke="var(--chart-stroke)" strokeWidth="2" />
      <line x1="280" y1="95" x2="330" y2="95" stroke="var(--chart-stroke)" strokeWidth="2" />

      <rect x="40" y="65" width="80" height="60" rx="8" fill="var(--bg-0)" stroke={stroke} />
      <text x="80" y="90" textAnchor="middle" fill="var(--text)" fontSize="13">电机</text>
      <text x="80" y="108" textAnchor="middle" fill="var(--muted)" fontSize="11">
        {power != null ? `${power.toFixed(1)} kW` : '-- kW'}
      </text>

      <rect x="180" y="65" width="100" height="60" rx="8" fill="var(--bg-0)" stroke={stroke} />
      <text x="230" y="90" textAnchor="middle" fill="var(--text)" fontSize="13">变频器</text>
      <text x="230" y="108" textAnchor="middle" fill="var(--muted)" fontSize="11">
        {freq != null ? `${freq.toFixed(1)} Hz` : '-- Hz'}
      </text>

      <circle cx="380" cy="95" r="34" fill="var(--bg-0)" stroke={stroke} strokeWidth="3" />
      <text x="380" y="91" textAnchor="middle" fill="var(--text)" fontSize="13">风机</text>
      <text x="380" y="108" textAnchor="middle" fill={running ? 'var(--accent-2)' : 'var(--muted)'} fontSize="11">
        {running ? '运行中' : '停止'}
      </text>

      {/* 试验段：气流方向 */}
      <rect x="470" y="55" width="210" height="80" rx="10" fill="var(--bg-0)" stroke="var(--muted)" />
      <text x="575" y="76" textAnchor="middle" fill="var(--text)" fontSize="13">试验段</text>
      <line x1="414" y1="95" x2="470" y2="95" stroke="var(--chart-stroke)" strokeWidth={flowWidth} opacity={flowOpacity} />
      <path
        d="M485 95 L 655 95"
        fill="none"
        stroke="var(--chart-stroke)"
        strokeWidth={flowWidth}
        opacity={flowOpacity}
      />
      <path d="M655 95 l -12 -6 v 12 z" fill="var(--chart-stroke)" opacity={flowOpacity} />
      <text x="575" y="118" textAnchor="middle" fill="var(--accent-2)" fontSize="15">
        {wind != null ? `${wind.toFixed(1)} m/s` : '-- m/s'}
      </text>
      <text x="575" y="152" textAnchor="middle" fill="var(--muted)" fontSize="11">
        气流方向 →
      </text>

      {fault && (
        <text x="40" y="32" fill="var(--danger)" fontSize="12">系统故障</text>
      )}
    </svg>
  )
}
