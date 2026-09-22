import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useBranding } from '../hooks/useBranding'
import {
  IconChevron,
  IconCollapse,
  IconExpand,
  IconMenu,
  IconClose,
  NAV_ICONS,
  type IconComponent,
} from './icons'

/** 导航项实时状态点（ISA-101：正常中性灰，warn/danger 才上色） */
export type NavDot = 'ok' | 'warn' | 'danger'

export type NavItem = {
  key: string
  to: string
  label: string
  end?: boolean
  group?: string
  /** 图标覆盖（默认按 key 查 NAV_ICONS；子系统项传 SUBSYSTEM_ICONS 里的图标） */
  icon?: IconComponent
  /** 右侧实时状态点 */
  dot?: NavDot
  /** 状态点/折叠态 tooltip 补充说明（如连接状态） */
  dotTitle?: string
}

/** 侧栏状态徽标：count = mono 数字小方块；pulse = 运行中脉冲点 */
export type NavBadge = {
  kind: 'count' | 'pulse'
  tone: 'danger' | 'accent'
  count?: number
  title?: string
}

const STORAGE_KEY = 'wtcs_sidebar_collapsed'
/** 分组展开状态：key=组名，value=是否展开；缺省（含新用户）一律视为收起，即默认全折叠 */
const GROUPS_KEY = 'wtcs_nav_groups_open'

function loadOpenGroups(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** 与 NavLink 相同的命中规则：end 精确匹配，否则允许子路径（如 /subsystems/main_fan） */
function itemMatches(item: NavItem, pathname: string): boolean {
  if (item.to === pathname) return true
  if (item.end) return false
  return pathname.startsWith(item.to.endsWith('/') ? item.to : `${item.to}/`)
}

export function Sidebar({
  items,
  badges = {},
  brandTitle = '合肥汽车风洞',
  brandSub = 'WTCS 测控系统',
}: {
  items: NavItem[]
  badges?: Record<string, NavBadge>
  brandTitle?: string
  brandSub?: string
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(loadOpenGroups)
  const branding = useBranding()
  const location = useLocation()

  useEffect(() => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(openGroups))
  }, [openGroups])

  // 路由变化时自动展开当前页所在分组（用户手动收起的其他分组保持原状）。
  // 用「渲染期间派生状态」模式而非 effect，避免级联渲染告警。
  const [lastPath, setLastPath] = useState('')
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname)
    const active = items.find((it) => itemMatches(it, location.pathname))
    const g = active?.group || '功能'
    if (!openGroups[g]) setOpenGroups((prev) => ({ ...prev, [g]: true }))
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded')
  }, [collapsed])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'expanded')
  }, [])

  const groups = items.reduce<Record<string, NavItem[]>>((acc, item) => {
    const g = item.group || '功能'
    ;(acc[g] ||= []).push(item)
    return acc
  }, {})

  return (
    <>
      <button
        type="button"
        className="sidebar-mobile-toggle"
        aria-label="打开菜单"
        onClick={() => setMobileOpen(true)}
      >
        <IconMenu size={22} />
      </button>

      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo" aria-hidden>
            <img src={branding.mark_url} alt="" />
          </div>
          {!collapsed && (
            <div className="sidebar-brand-text">
              <strong>{brandTitle}</strong>
              <span>{brandSub}</span>
            </div>
          )}
          <button
            type="button"
            className="sidebar-close-mobile"
            aria-label="关闭菜单"
            onClick={() => setMobileOpen(false)}
          >
            <IconClose size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {Object.entries(groups).map(([group, list]) => {
            const open = !collapsed && (openGroups[group] ?? false)
            // 分组收起时，把组内最严重的徽标聚合成一个点提示（danger 优先）
            const aggTone = list.some((it) => badges[it.key]?.tone === 'danger')
              ? 'danger'
              : list.some((it) => badges[it.key])
                ? 'accent'
                : null
            return (
              <div key={group} className="sidebar-group">
                {!collapsed && (
                  <button
                    type="button"
                    className={`sidebar-group-label ${open ? 'open' : ''}`}
                    onClick={() => setOpenGroups((prev) => ({ ...prev, [group]: !open }))}
                    aria-expanded={open}
                  >
                    <span>{group}</span>
                    {!open && aggTone && <span className={`nav-dot nav-dot--${aggTone}`} aria-hidden />}
                    <IconChevron size={14} className="sidebar-group-caret" />
                  </button>
                )}
                {(collapsed || open) && list.map((item) => {
                const Icon = item.icon || NAV_ICONS[item.key] || NAV_ICONS.dashboard
                const badge = badges[item.key]
                const tip = [badge?.title, item.dotTitle].filter(Boolean).join('；') || undefined
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                    title={collapsed ? (tip ? `${item.label}（${tip}）` : item.label) : tip}
                  >
                    <span className="sidebar-icon">
                      <Icon size={20} />
                    </span>
                    {!collapsed && <span className="sidebar-label">{item.label}</span>}
                    {badge && !collapsed && badge.kind === 'count' && (
                      <span className={`nav-badge nav-badge--${badge.tone}`}>{badge.count}</span>
                    )}
                    {badge && !collapsed && badge.kind === 'pulse' && (
                      <span className={`nav-pulse nav-pulse--${badge.tone}`} aria-hidden />
                    )}
                    {badge && collapsed && (
                      <span
                        className={`nav-dot nav-dot--${badge.tone}${badge.kind === 'pulse' ? ' nav-dot--pulse' : ''}`}
                        aria-hidden
                      />
                    )}
                    {item.dot && (!collapsed || !badge) && (
                      <span className={`nav-status nav-status--${item.dot}`} aria-hidden />
                    )}
                  </NavLink>
                )
              })}
              </div>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开菜单' : '折叠菜单'}
          >
            {collapsed ? <IconExpand size={18} /> : <IconCollapse size={18} />}
            {!collapsed && <span>折叠菜单</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
