import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, hasMinRole } from '../api'
import { useTheme } from '../theme'
import type { TelemetryFrame } from '../hooks/useTelemetry'
import type { NavItem } from './Sidebar'

type Entry = {
  id: string
  group: string
  label: string
  hint?: string
  keywords: string
  run: () => void | Promise<void>
}

/**
 * Ctrl+K 命令面板：页面 / 子系统 / 操作 三类条目，中文子串模糊匹配，
 * ↑↓ 选择、Enter 执行、Esc 关闭。操作类按角色过滤（customer 仅导航类）。
 * 外层按 open 挂载/卸载内层，保证每次打开都是全新输入态。
 */
export function CommandPalette({
  items,
  frame,
  toast,
  open,
  onClose,
}: {
  items: NavItem[]
  frame: TelemetryFrame | null
  toast: (msg: string, ok?: boolean) => void
  open: boolean
  onClose: () => void
}) {
  if (!open) return null
  return <PaletteInner items={items} frame={frame} toast={toast} onClose={onClose} />
}

function PaletteInner({
  items,
  frame,
  toast,
  onClose,
}: {
  items: NavItem[]
  frame: TelemetryFrame | null
  toast: (msg: string, ok?: boolean) => void
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = []
    for (const n of items) {
      if (n.key.startsWith('sub:')) continue // 子系统导航项由下方 frame 条目覆盖，避免重复
      list.push({
        id: `page:${n.key}`,
        group: `页面 · ${n.group ?? '功能'}`,
        label: n.label,
        keywords: `${n.label} ${n.key} ${n.to}`.toLowerCase(),
        run: () => navigate(n.to),
      })
    }
    for (const s of frame?.subsystems ?? []) {
      list.push({
        id: `sub:${s.id}`,
        group: '子系统',
        label: s.name,
        hint: s.fault ? '故障' : s.state,
        keywords: `${s.name} ${s.id}`.toLowerCase(),
        run: () => navigate(`/subsystems/${s.id}`),
      })
    }
    const canOp = hasMinRole('操作员')
    list.push({
      id: 'act:screen',
      group: '操作',
      label: '全屏大屏（kiosk）',
      keywords: '全屏 大屏 screen kiosk 总览',
      run: () => navigate('/screen?kiosk=1'),
    })
    if (canOp) {
      list.push({
        id: 'act:new-matrix',
        group: '操作',
        label: '新建试验矩阵',
        keywords: '新建 试验 矩阵 matrix new create',
        run: () => navigate('/experiments?tab=matrices&new=1'),
      })
      list.push({
        id: 'act:inspect',
        group: '操作',
        label: '触发 AI 巡检',
        keywords: '触发 ai 巡检 inspect 告警',
        run: async () => {
          try {
            const r = await api.aiInspect()
            toast(`巡检完成，发现 ${r.count} 条`)
            navigate('/insight?tab=ai')
          } catch (e) {
            toast(e instanceof Error ? e.message : '巡检失败', false)
          }
        },
      })
    }
    list.push({
      id: 'act:theme',
      group: '操作',
      label: theme === 'dark' ? '切换主题 → 浅色' : '切换主题 → 深色',
      keywords: '切换 主题 theme dark light 深色 浅色',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    })
    return list
  }, [items, frame, navigate, toast, theme, setTheme])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.label.toLowerCase().includes(q) || e.keywords.includes(q))
  }, [entries, query])

  // 渲染期收敛选中下标（过滤结果缩短时不越界）
  const current = Math.min(active, Math.max(0, filtered.length - 1))

  // 选中项保持可见（DOM 同步，非状态）
  useEffect(() => {
    listRef.current
      ?.querySelector('.cmdk-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  function execute(e: Entry) {
    onClose()
    void e.run()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(Math.min(filtered.length - 1, current + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(Math.max(0, current - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[current]
      if (item) execute(item)
    }
  }

  let lastGroup = ''

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" role="dialog" aria-label="命令面板" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="cmdk-input"
          placeholder="输入页面、子系统或操作名称…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" ref={listRef}>
          {!filtered.length && <div className="empty cmdk-empty">无匹配条目</div>}
          {filtered.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null
            lastGroup = e.group
            return (
              <div key={e.id}>
                {header && <div className="label-cap cmdk-group">{header}</div>}
                <div
                  className={`cmdk-item ${i === current ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => execute(e)}
                >
                  <span>{e.label}</span>
                  {e.hint && <span className={`badge ${e.hint === '故障' ? 'danger' : ''}`}>{e.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="cmdk-footer mono">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
      </div>
    </div>
  )
}
