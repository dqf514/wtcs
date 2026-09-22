import { useEffect, useRef, useState } from 'react'

const HOLD_MS = 1000

/**
 * 急停按钮（防误触）：按住 1 秒才触发，松开/移出即取消；
 * 视觉独占安全区（警示纹由 .safety-zone 提供）。键盘按住 Space/Enter 同样有效。
 * compact：顶栏常驻小尺寸变体（隐藏提示文字，按住时环形色带仍表达进度）。
 */
export function EStopButton({ onFire, disabled, compact }: { onFire: () => void; disabled?: boolean; compact?: boolean }) {
  const [progress, setProgress] = useState(0)
  const rafRef = useRef<number | undefined>(undefined)
  const startRef = useRef(0)
  const firedRef = useRef(false)

  const tickRef = useRef<() => void>(() => {})

  const cancel = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = undefined
    firedRef.current = false
    setProgress(0)
  }

  const start = () => {
    if (disabled || rafRef.current !== undefined) return
    startRef.current = performance.now()
    // rAF 回调在事件链中执行（非渲染期），读取 performance.now 安全
    tickRef.current = () => {
      const p = (performance.now() - startRef.current) / HOLD_MS
      if (p >= 1) {
        if (!firedRef.current) {
          firedRef.current = true
          onFire()
        }
        cancel()
        return
      }
      setProgress(p)
      rafRef.current = requestAnimationFrame(() => tickRef.current())
    }
    rafRef.current = requestAnimationFrame(() => tickRef.current())
  }

  useEffect(() => cancel, [])

  return (
    <button
      type="button"
      className={`estop-btn${compact ? ' estop-btn--compact' : ''}`}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start()
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') cancel()
      }}
      onContextMenu={(e) => e.preventDefault()}
      title="按住 1 秒触发急停"
    >
      <span className="estop-btn-ring" style={{ background: `conic-gradient(var(--danger) ${progress * 360}deg, transparent 0deg)` }} />
      <span className="estop-btn-core">{progress > 0 && !compact ? '松开取消' : '急停'}</span>
      {!compact && <span className="estop-btn-hint">{progress > 0 ? `${Math.ceil((1 - progress) * HOLD_MS / 1000)}s` : '按住 1 秒'}</span>}
    </button>
  )
}
