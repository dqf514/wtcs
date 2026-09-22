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

/** 冷却水系统工艺示意图：冷机×3 → 水泵 → 供水 → 试验段 → 回水回路（数据驱动，风格同总控台场景图） */
export function CoolingSchematic({ points, fault }: { points: TelemetryPoint[]; fault: boolean }) {
  const supply = num(points, 'supply_temp')
  const ret = num(points, 'return_temp')
  const flow = num(points, 'flow')
  const pressure = num(points, 'pressure')
  const chillers = [bool(points, 'chiller1_on'), bool(points, 'chiller2_on'), bool(points, 'chiller3_on')]
  const running = chillers.some(Boolean)
  const stroke = fault ? 'var(--danger)' : 'var(--muted)'
  const flowOpacity = running ? 0.85 : 0.25

  return (
    <svg className="scene-svg" viewBox="0 0 720 230" role="img" aria-label="冷却水系统工艺示意图">
      <rect x="10" y="10" width="700" height="210" rx="14" fill="var(--bg-3)" stroke="var(--line)" />

      {/* 冷机×3 汇入水泵 */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect
            x="40"
            y={40 + i * 52}
            width="90"
            height="40"
            rx="8"
            fill="var(--bg-0)"
            stroke={chillers[i] ? 'var(--chart-stroke)' : 'var(--muted)'}
          />
          <text x="85" y={58 + i * 52} textAnchor="middle" fill="var(--text)" fontSize="12">
            冷机{i + 1}
          </text>
          <text x="85" y={73 + i * 52} textAnchor="middle" fill={chillers[i] ? 'var(--accent-2)' : 'var(--muted)'} fontSize="10">
            {chillers[i] ? '运行' : '停机'}
          </text>
          <line x1="130" y1={60 + i * 52} x2="180" y2="115" stroke="var(--chart-stroke)" strokeWidth="1.5" opacity={chillers[i] ? 0.85 : 0.25} />
        </g>
      ))}

      {/* 水泵 */}
      <circle cx="215" cy="115" r="24" fill="var(--bg-0)" stroke={stroke} strokeWidth="2.5" />
      <text x="215" y="112" textAnchor="middle" fill="var(--text)" fontSize="12">水泵</text>
      <text x="215" y="126" textAnchor="middle" fill="var(--muted)" fontSize="10">
        {pressure != null ? `${pressure.toFixed(1)} bar` : '-- bar'}
      </text>

      {/* 供水管路 → 试验段 */}
      <line x1="239" y1="115" x2="430" y2="115" stroke="var(--chart-stroke)" strokeWidth="3" opacity={flowOpacity} />
      <path d="M430 115 l -12 -6 v 12 z" fill="var(--chart-stroke)" opacity={flowOpacity} />
      <text x="335" y="104" textAnchor="middle" fill="var(--accent-2)" fontSize="12">
        供水 {supply != null ? `${supply.toFixed(1)} ℃` : '-- ℃'} · {flow != null ? `${flow.toFixed(0)} m³/h` : '-- m³/h'}
      </text>

      {/* 试验段（换热负载） */}
      <rect x="440" y="75" width="130" height="80" rx="10" fill="var(--bg-0)" stroke="var(--muted)" />
      <text x="505" y="108" textAnchor="middle" fill="var(--text)" fontSize="13">试验段</text>
      <text x="505" y="128" textAnchor="middle" fill="var(--muted)" fontSize="11">换热负载</text>

      {/* 回水回路：试验段 → 右侧下行 → 底部回冷机 */}
      <line x1="570" y1="115" x2="650" y2="115" stroke="var(--chart-stroke)" strokeWidth="3" opacity={flowOpacity} />
      <line x1="650" y1="115" x2="650" y2="195" stroke="var(--chart-stroke)" strokeWidth="3" opacity={flowOpacity} />
      <line x1="650" y1="195" x2="85" y2="195" stroke="var(--chart-stroke)" strokeWidth="3" opacity={flowOpacity} />
      <line x1="85" y1="195" x2="85" y2="184" stroke="var(--chart-stroke)" strokeWidth="3" opacity={flowOpacity} />
      <path d="M85 172 l -7 12 h 14 z" fill="var(--chart-stroke)" opacity={flowOpacity} />
      <text x="370" y="188" textAnchor="middle" fill="var(--accent-2)" fontSize="12">
        回水 {ret != null ? `${ret.toFixed(1)} ℃` : '-- ℃'}
      </text>

      {fault && (
        <text x="40" y="32" fill="var(--danger)" fontSize="12">系统故障</text>
      )}
    </svg>
  )
}
