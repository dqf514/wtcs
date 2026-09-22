/**
 * 大屏 ECharts option 构造：固定深色配色（大屏不随主题切换），字号随屏幕短边缩放。
 * 纯展示：关闭 tooltip / dataZoom / 动画。
 */
import type { EChartsCoreOption } from '../Chart'
import { CHART_COLORS_DARK as C } from '../chartColors'
import type { HistorySeries } from '../../api'
import { POINT_META } from '../../paramMeta'

function metaOf(key: string) {
  return POINT_META[key.split('.')[1]]
}

export interface TrendLine {
  key: string
  yAxisIndex?: number
  color?: string
  width?: number
  dashed?: boolean
  /** 绘制正常区间 markArea（取 POINT_META.normal） */
  normalBand?: boolean
  /** 目标值 markLine（来自实时遥测设定值） */
  target?: number | null
}

/** 多序列折线（time 轴，固定量程避免自适应掩盖小幅异常；可选正常区间带 / 目标标线） */
export function buildTrendOption(
  data: Map<string, HistorySeries>,
  lines: TrendLine[],
  yAxisNames: string[],
  scale: number,
): EChartsCoreOption {
  const fs = (n: number) => Math.round(n * scale)
  return {
    animation: false,
    grid: { left: fs(10), right: fs(10), top: fs(38), bottom: fs(6), containLabel: true },
    legend: {
      top: 0,
      left: 0,
      icon: 'rect',
      itemWidth: fs(18),
      itemHeight: fs(3),
      itemGap: fs(16),
      textStyle: { color: C.muted, fontSize: fs(13) },
    },
    tooltip: { show: false },
    xAxis: {
      type: 'time',
      axisLabel: { color: C.muted, fontSize: fs(12), hideOverlap: true },
      axisLine: { lineStyle: { color: C.line } },
      splitLine: { show: false },
    },
    yAxis: yAxisNames.map((name, i) => {
      const meta = metaOf(lines.find((l) => (l.yAxisIndex ?? 0) === i)?.key ?? '')
      return {
        type: 'value',
        name,
        position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
        min: meta?.min,
        max: meta?.max,
        nameTextStyle: { color: C.muted, fontSize: fs(12) },
        axisLabel: { color: C.muted, fontSize: fs(12) },
        splitLine: { show: i === 0, lineStyle: { color: C.split } },
      }
    }),
    series: lines.map((l) => {
      const meta = metaOf(l.key)
      const s = data.get(l.key)
      return {
        name: s ? `${s.name}${s.unit ? ` ${s.unit}` : ''}` : l.key,
        type: 'line',
        yAxisIndex: l.yAxisIndex ?? 0,
        data: s?.points ?? [],
        showSymbol: false,
        smooth: 0.2,
        lineStyle: { width: l.width ?? 2.5, color: l.color ?? C.accent2, type: (l.dashed ? 'dashed' : 'solid') as 'dashed' | 'solid' },
        ...(l.normalBand && meta
          ? {
              markArea: {
                silent: true,
                itemStyle: { color: 'rgba(148, 163, 184, 0.07)' },
                label: { show: false },
                data: [[{ yAxis: meta.normal[0] }, { yAxis: meta.normal[1] }]],
              },
            }
          : {}),
        ...(l.target != null && l.target > 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: C.accent, type: 'dashed' as const, width: 1.5 },
                label: { color: C.accent, fontSize: fs(11), formatter: `目标 ${l.target}` },
                data: [{ yAxis: l.target }],
              },
            }
          : {}),
      }
    }),
  }
}

/** 近 N 天告警分布柱图（statsOverview.alerts.by_day） */
export function buildDailyAlertsOption(days: { day: string; count: number }[], scale: number): EChartsCoreOption {
  const fs = (n: number) => Math.round(n * scale)
  return {
    animation: false,
    grid: { left: fs(10), right: fs(10), top: fs(24), bottom: fs(6), containLabel: true },
    tooltip: { show: false },
    xAxis: {
      type: 'category',
      data: days.map((d) => d.day.slice(5)),
      axisLabel: { color: C.muted, fontSize: fs(12) },
      axisLine: { lineStyle: { color: C.line } },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: C.muted, fontSize: fs(12) },
      splitLine: { lineStyle: { color: C.split } },
    },
    series: [
      {
        type: 'bar',
        data: days.map((d) => d.count),
        barMaxWidth: fs(36),
        itemStyle: { color: C.accent2 },
        label: { show: true, position: 'top', color: C.text, fontSize: fs(12) },
      },
    ],
  }
}
