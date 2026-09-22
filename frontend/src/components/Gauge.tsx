import { useMemo } from 'react'
import { Chart, type EChartsCoreOption } from './Chart'
import { useChartColors } from './chartColors'

interface GaugeProps {
  label: string
  value: number | null | undefined
  unit?: string
  /** 显示量程 */
  min: number
  max: number
  /** 正常区间（区间内中性色带，越限指针变色） */
  normal: [number, number]
  /** 设定值：副指针（短针，accent 色） */
  setpoint?: number | null
  precision?: number
  height?: number
}

/**
 * ISA-101 半圆仪表：正常区间为色带（中性色），当前值主指针、设定值副指针；
 * 颜色只表异常——越限才变 warn，否则 accent 中性强调。
 */
export function Gauge({ label, value, unit, min, max, normal, setpoint, precision = 1, height = 170 }: GaugeProps) {
  const colors = useChartColors()
  const valid = typeof value === 'number' && Number.isFinite(value)
  const outOfRange = valid && (value < normal[0] || value > normal[1])
  const pointerColor = !valid ? colors.muted : outOfRange ? colors.warn : colors.accent
  const valueText = valid ? (value as number).toFixed(precision) : '--'
  const option = useMemo<EChartsCoreOption>(() => {
    const span = max - min || 1
    const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / span))
    const series: Record<string, unknown>[] = [
      {
        type: 'gauge',
        startAngle: 200,
        endAngle: -20,
        min,
        max,
        radius: '100%',
        center: ['50%', '62%'],
        axisLine: {
          lineStyle: {
            width: 12,
            color: [
              [frac(normal[0]), colors.split],
              [frac(normal[1]), colors.line],
              [1, colors.split],
            ],
          },
        },
        pointer: { length: '58%', width: 3, itemStyle: { color: pointerColor } },
        anchor: { show: true, size: 8, itemStyle: { color: pointerColor } },
        axisTick: { distance: -12, length: 4, lineStyle: { color: colors.muted, width: 1 } },
        splitLine: { distance: -12, length: 12, lineStyle: { color: colors.muted, width: 1 } },
        axisLabel: { distance: 16, color: colors.muted, fontSize: 10, fontFamily: 'Ubuntu Mono, Cascadia Mono, monospace' },
        // 数值不在盘内渲染（避免压刻度/指针），由盘下方 DOM 读数区显示
        detail: { show: false },
        data: [{ value: valid ? value : min, name: '' }],
      },
    ]
    // 设定值副指针（短针，accent-2，随表盘同刻度）
    if (typeof setpoint === 'number' && Number.isFinite(setpoint)) {
      series.push({
        type: 'gauge',
        startAngle: 200,
        endAngle: -20,
        min,
        max,
        radius: '100%',
        center: ['50%', '62%'],
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { length: '74%', width: 2, itemStyle: { color: colors.accent2 } },
        anchor: { show: false },
        detail: { show: false },
        data: [{ value: Math.min(max, Math.max(min, setpoint)), name: '' }],
      })
    }
    return {
      animation: false,
      series,
    } as EChartsCoreOption
  }, [value, valid, pointerColor, min, max, normal, setpoint, colors])

  return (
    <div className="gauge">
      <Chart option={option} height={height} />
      {/* 盘下读数区：大字数值 + 单位一行，副标签独占一行，均不与刻度/指针重叠 */}
      <div className="gauge-readout">
        <span className="gauge-value mono" style={{ color: pointerColor }}>
          {valueText}
          {unit && <em>{unit}</em>}
        </span>
        {label && <span className="gauge-label label-cap">{label}</span>}
      </div>
    </div>
  )
}
