import { useMemo } from 'react'
import type { HistorySeries } from '../../api'
import { Chart } from '../Chart'
import { CHART_COLORS_DARK as C } from '../chartColors'
import { buildTrendOption, type TrendLine } from './charts'

interface Props {
  /** 近 30 分钟多测点序列（单次 historyQuery 返回） */
  data: Map<string, HistorySeries>
  scale: number
}

interface TrendChartDef {
  title: string
  axes: string[]
  lines: TrendLine[]
}

/** 2×2 趋势：风速+目标 / 冷却水供回 / 天平 Fx·Fz / 声学 dB（测点均在 telemetry_wide 宽表） */
const TREND_CHARTS: TrendChartDef[] = [
  {
    title: '风速跟踪 · 目标对比',
    axes: ['m/s'],
    lines: [
      { key: 'main_fan.wind_speed', color: C.accent2, width: 3, normalBand: true },
      { key: 'main_fan.target_speed', color: C.accent, width: 2, dashed: true },
    ],
  },
  {
    title: '冷却水温度 · 供水 / 回水',
    axes: ['℃'],
    lines: [
      { key: 'cooling_water.supply_temp', color: C.accent2, width: 2.5, normalBand: true },
      { key: 'cooling_water.return_temp', color: C.muted, width: 2.5 },
    ],
  },
  {
    title: '天平气动力 · Fx / Fz',
    axes: ['N'],
    lines: [
      { key: 'rrs.fx', color: C.accent2, width: 2.5 },
      { key: 'rrs.fz', color: C.muted, width: 2.5 },
    ],
  },
  {
    title: '声学声压级',
    axes: ['dB'],
    lines: [{ key: 'acoustic.spl', color: C.accent2, width: 2.5, normalBand: true }],
  },
]

export function TrendsMode({ data, scale }: Props) {
  const options = useMemo(
    () => TREND_CHARTS.map((c) => buildTrendOption(data, c.lines, c.axes, scale)),
    [data, scale],
  )
  return (
    <div className="tr-grid">
      {TREND_CHARTS.map((c, i) => {
        const latest = c.lines
          .map((l) => {
            const s = data.get(l.key)
            const last = s?.points.at(-1)
            return s && last ? `${s.name} ${last[1].toFixed(1)}${s.unit ? ` ${s.unit}` : ''}` : null
          })
          .filter(Boolean)
          .join(' · ')
        return (
          <div className="scr-panel" key={c.title}>
            <div className="scr-panel-head">
              <span className="scr-panel-title">{c.title} · 近 30 分钟</span>
              <span className="scr-panel-side mono">{latest || '--'}</span>
            </div>
            <div className="scr-panel-body">
              <Chart option={options[i]} className="scr-chart" />
            </div>
          </div>
        )
      })}
    </div>
  )
}
