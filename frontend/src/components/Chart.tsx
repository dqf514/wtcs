import { Component, useEffect, useRef, type ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, GaugeChart, LineChart, PieChart } from 'echarts/charts'
import {
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

// 按需注册：折线/仪表/饼/柱图 + 网格/提示/图例/缩放/标线标区，控制包体积
echarts.use([
  LineChart,
  GaugeChart,
  PieChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  MarkAreaComponent,
  MarkLineComponent,
  CanvasRenderer,
])

export type { EChartsCoreOption }

interface ChartProps {
  option: EChartsCoreOption
  /** 数值或 CSS 长度；省略时高度完全由 className 控制 */
  height?: number | string
  className?: string
}

/** 单个图表渲染失败时只降级该图表（显示空槽位），绝不允许整页白屏 */
class ChartErrorBoundary extends Component<ChartProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.error('[wtcs] 图表渲染失败', err)
  }
  componentDidUpdate(prev: ChartProps) {
    // option 变化（数据刷新/主题切换）后允许重试渲染
    if (this.state.failed && prev.option !== this.props.option) this.setState({ failed: false })
  }
  render(): ReactNode {
    if (this.state.failed) {
      return <div className={this.props.className} style={{ width: '100%', height: this.props.height ?? 120 }} />
    }
    return <ChartInner {...this.props} />
  }
}

/** ECharts React 封装：init/resize/dispose + 主题变化时整图重设（调用方把 useChartColors 加入 option 依赖即可） */
function ChartInner({ option, height, className }: ChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let chart: echarts.ECharts
    try {
      chart = echarts.init(el)
    } catch (err) {
      console.error('[wtcs] 图表初始化失败', err)
      return
    }
    chartRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    try {
      chart.setOption(option, { notMerge: true })
    } catch (err) {
      // 单个 option 异常（如退化数据触发 echarts 内部断言）只记录并保留上一帧，不上抛
      console.error('[wtcs] 图表 setOption 失败', err)
    }
  }, [option])

  return (
    <div
      ref={ref}
      className={className}
      style={height !== undefined ? { width: '100%', height } : { width: '100%' }}
    />
  )
}

export function Chart(props: ChartProps) {
  return <ChartErrorBoundary {...props} />
}
