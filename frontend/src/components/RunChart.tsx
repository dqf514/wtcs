import { useMemo } from 'react'
import { Chart, type EChartsCoreOption } from './Chart'
import { useChartColors } from './chartColors'
import { CHANNEL_UNIT } from './runMeta'

/** run 采样曲线（ECharts：坐标轴/单位/网格/legend/tooltip/缩放） */
export function RunChart({ title, series }: { title: string; series: { label: string; color: string; points: [number, number][] }[] }) {
  const colors = useChartColors()
  const valid = series.filter((s) => s.points.length > 1)
  const option = useMemo<EChartsCoreOption>(() => {
    return {
      animation: false,
      color: valid.map((s) => s.color),
      grid: { left: 56, right: 20, top: 34, bottom: 56 },
      legend: { top: 0, textStyle: { color: colors.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.card,
        borderColor: colors.line,
        textStyle: { color: colors.text, fontSize: 12 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '--'),
      },
      xAxis: {
        type: 'value',
        name: 't (s)',
        nameTextStyle: { color: colors.muted, fontSize: 11 },
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.line } },
        splitLine: { lineStyle: { color: colors.split } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.line } },
        splitLine: { lineStyle: { color: colors.split } },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 6, borderColor: colors.line, textStyle: { color: colors.muted, fontSize: 10 } },
      ],
      series: valid.map((s) => ({
        name: CHANNEL_UNIT[s.label] ? `${s.label} (${CHANNEL_UNIT[s.label]})` : s.label,
        type: 'line' as const,
        data: s.points,
        showSymbol: false,
        smooth: 0.1,
        lineStyle: { width: 1.6 },
      })),
    }
  }, [valid, colors])

  if (!valid.length) return null
  return (
    <div className="run-chart">
      <div className="run-chart-title">{title}</div>
      <Chart option={option} height={220} />
    </div>
  )
}
