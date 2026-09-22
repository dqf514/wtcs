import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

export type TabDef = {
  key: string
  label: string
  /** 可选数字徽标（mono 小方块） */
  count?: number
  disabled?: boolean
  /** 追加在标签后的弱化说明，如「（预留）」 */
  suffix?: string
}

/**
 * 统一页内 Tab：role=tablist/tab，底部发丝线 + 激活 2px accent 下划线，
 * ←/→ 键盘切换，URL ?tab= 同步（刷新 / 弹窗 / 分享链接保持位置）。
 * @param param 同步的 query 参数名；传 null 关闭 URL 同步
 */
export function Tabs({
  tabs,
  value,
  onChange,
  param = 'tab',
  ariaLabel,
}: {
  tabs: TabDef[]
  value: string
  onChange: (key: string) => void
  param?: string | null
  ariaLabel?: string
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])

  // URL → 状态（含初始深链与浏览器前进/后退）；tabs 可能异步就绪，随之重校验
  useEffect(() => {
    if (!param) return
    const q = searchParams.get(param)
    if (q && q !== value && tabs.some((t) => t.key === q && !t.disabled)) onChange(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, tabs, value, param])

  function select(key: string) {
    if (key === value) return
    onChange(key)
    if (param) {
      const next = new URLSearchParams(searchParams)
      next.set(param, key)
      setSearchParams(next, { replace: true })
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    for (let step = 1; step <= tabs.length; step++) {
      const next = (idx + dir * step + tabs.length * step) % tabs.length
      if (!tabs[next].disabled) {
        select(tabs[next].key)
        btnRefs.current[next]?.focus()
        break
      }
    }
  }

  return (
    <div className="tabs-nav" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t, i) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            ref={(el) => {
              btnRefs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`tab ${active ? 'active' : ''}`}
            disabled={t.disabled}
            onClick={() => select(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.suffix && <span className="tab-suffix">{t.suffix}</span>}
            {t.count != null && <span className="tab-count">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
