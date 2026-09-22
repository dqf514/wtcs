import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CONTROL_STYLES, type ControlStyle } from './constants'

export type ThemeMode = 'dark' | 'light'

export type { ControlStyle }

type ThemeCtx = {
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
  toggle: () => void
  ctlStyle: ControlStyle
  setCtlStyle: (s: ControlStyle) => void
}

const Ctx = createContext<ThemeCtx | null>(null)
const KEY = 'wtcs_theme'
const CTL_KEY = 'wtcs_ctl_style'

function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme)
}

function applyCtlStyle(style: ControlStyle) {
  document.documentElement.setAttribute('data-ctl', style)
}

function loadCtlStyle(): ControlStyle {
  const saved = localStorage.getItem(CTL_KEY) as ControlStyle | null
  return CONTROL_STYLES.some((s) => s.key === saved) ? (saved as ControlStyle) : 'classic'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(KEY) as ThemeMode | null
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })
  const [ctlStyle, setCtlStyleState] = useState<ControlStyle>(loadCtlStyle)

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(KEY, theme)
  }, [theme])

  useEffect(() => {
    applyCtlStyle(ctlStyle)
    localStorage.setItem(CTL_KEY, ctlStyle)
  }, [ctlStyle])

  const value = useMemo(
    () => ({
      theme,
      setTheme: (t: ThemeMode) => setThemeState(t),
      toggle: () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
      ctlStyle,
      setCtlStyle: (s: ControlStyle) => setCtlStyleState(s),
    }),
    [theme, ctlStyle],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
