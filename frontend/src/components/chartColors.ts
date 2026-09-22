import { useMemo } from 'react'
import { useTheme } from '../theme'

/** 图表配色：与 index.css 双主题变量保持一致的数值副本（canvas 无法读 CSS 变量，主题切换时整图重设） */
export interface ChartColors {
  text: string
  muted: string
  line: string
  split: string
  accent: string
  accent2: string
  warn: string
  danger: string
  ok: string
  card: string
}

const DARK: ChartColors = {
  text: '#d6dee8',
  muted: '#8593a4',
  line: '#2b3543',
  split: '#222b37',
  accent: '#4aa8e0',
  accent2: '#6d9cc0',
  warn: '#fbbf24',
  danger: '#f87171',
  ok: '#34d399',
  card: '#151c26',
}

const LIGHT: ChartColors = {
  text: '#1d2733',
  muted: '#5d6a78',
  line: '#c8ced6',
  split: '#dde2e9',
  accent: '#1f6fb2',
  accent2: '#4a7ba6',
  warn: '#b45309',
  danger: '#b91c1c',
  ok: '#047857',
  card: '#ffffff',
}

export function useChartColors(): ChartColors {
  const { theme } = useTheme()
  return useMemo(() => (theme === 'light' ? LIGHT : DARK), [theme])
}

/** 大屏专用：强制深色配色（大屏容器不随主题切换，canvas 需要数值副本） */
export const CHART_COLORS_DARK: ChartColors = DARK
