import { useMemo } from 'react'
import { Chart, type EChartsCoreOption } from './Chart'
import { useChartColors } from './chartColors'

interface AnalogBarProps {
  label: string
  value: number | null | undefined
  unit?: string
  /** 显示量程 */
  min: number
  max: number
  /** 正常区间：区间内中性色，越限变 warn/danger */
  normal: [number, number]
  /** 设定值标线 */
  setpoint?: number | null
  /** 迷你趋势（可选，ECharts 小图） */
  trend?: number[]
  precision?: number
  /** 越限级别：默认越限即 warn，danger 需调用方显式指定（如安全相关量） */
  dangerOutside?: boolean
}

/** ISA-101 模拟量指示：当前值 + 正常区间带 + 设定值标线 + 迷你趋势；颜色只表异常 */
export function AnalogBar({ label, value, unit, min, max, normal, setpoint, trend, precision = 1, dangerOutside }: AnalogBarProps) {
  const span = max - min || 1
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100))
  const valid = typeof value === 'number' && Number.isFinite(value)
  const outOfRange = valid && (value < normal[0] || value > normal[1])
  const level = !valid ? 'none' : !outOfRange ? 'normal' : dangerOutside ? 'danger' : 'warn'

  return (
    <div className={`analog analog--${level}`}>
      <div className="analog-head">
        <span className="analog-label">{label}</span>
        <span className="analog-value mono">
          {valid ? value.toFixed(precision) : '--'}
          {unit && <em>{unit}</em>}
        </span>
      </div>
      <div className="analog-track" role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={valid ? value : undefined} aria-label={label}>
        <i
          className="analog-band"
          style={{ left: `${pct(normal[0])}%`, width: `${pct(normal[1]) - pct(normal[0])}%` }}
        />
        {valid && <i className="analog-fill" style={{ width: `${pct(value)}%` }} />}
        {typeof setpoint === 'number' && Number.isFinite(setpoint) && (
          <i className="analog-setpoint" style={{ left: `${pct(setpoint)}%` }} title={`设定值 ${setpoint}${unit ?? ''}`} />
        )}
      </div>
      <div className="analog-scale mono">
        <span>{min}</span>
        <span>{max}{unit ? ` ${unit}` : ''}</span>
      </div>
      {trend && trend.length > 1 && <MiniTrend values={trend} alert={outOfRange} />}
    </div>
  )
}

/** 迷你趋势（KPI 卡内嵌，无坐标轴；正常中性色、越限变色） */
export function MiniTrend({ values, alert, height = 40 }: { values: number[]; alert?: boolean; height?: number }) {
  const colors = useChartColors()
  const option = useMemo<EChartsCoreOption>(() => {
    // echarts6 的 nice 刻度算法在数据为常量时会产生退化值域（span≈1e-323），
    // 导致 interval 下溢为 0、niceExtent 为 NaN 并触发 dev 断言抛错（整页白屏）。
    // 因此这里自行计算 y 轴范围：丢弃非有限值、保证最小跨度、改用显式数值 min/max。
    const clean = values.filter((v) => Number.isFinite(v))
    let yMin: number | undefined
    let yMax: number | undefined
    if (clean.length > 0) {
      let lo = Infinity
      let hi = -Infinity
      for (const v of clean) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const span = hi - lo
      const pad = span < 1e-6 ? Math.max(Math.abs(lo) * 0.05, 0.5) : span * 0.08
      yMin = lo - pad
      yMax = hi + pad
    }
    return {
      animation: false,
      grid: { left: 2, right: 2, top: 3, bottom: 3 },
      xAxis: { type: 'category', show: false, data: clean.map((_, i) => i) },
      yAxis: { type: 'value', show: false, min: yMin, max: yMax },
      series: [
        {
          type: 'line',
          data: clean,
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { width: 1.6, color: alert ? colors.warn : colors.muted },
          areaStyle: { color: alert ? 'rgba(251,191,36,0.10)' : 'rgba(148,163,184,0.10)' },
        },
      ],
    }
  }, [values, alert, colors])
  return <Chart option={option} height={height} className="analog-trend" />
}
