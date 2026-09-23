import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  api,
  getToken,
  setToken,
  setCurrentUser,
  hasMinRole,
  type AlertSummary,
  type UserInfo,
} from './api'
import { ThemeProvider } from './theme'
import { alarmSoundEnabled } from './constants'
import { Sidebar, type NavBadge, type NavItem } from './components/Sidebar'
import { SUBSYSTEM_ICONS, IconScreen, IconHealth } from './components/icons'
import { SUBSYSTEM_DEFS, subsystemTone } from './subsystems'
import { StatusBar } from './components/StatusBar'
import { PageErrorBoundary } from './components/PageErrorBoundary'
import { FullscreenButton, UserMenu } from './components/UserMenu'
import { AlertCenterModal } from './components/AlertCenterModal'
import { FeedbackWidget } from './components/FeedbackWidget'
import { CommandPalette } from './components/CommandPalette'
import { useTelemetry } from './hooks/useTelemetry'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { ExperimentsPage } from './pages/ExperimentsPage'
import { SubsystemsPage } from './pages/SubsystemsPage'
import { EquipmentPage } from './pages/EquipmentPage'
import { DataPage } from './pages/DataPage'
import { InsightPage } from './pages/InsightPage'
import { InterlocksPage } from './pages/InterlocksPage'
import { CommandsPage } from './pages/CommandsPage'
import { ScreenPage } from './pages/ScreenPage'
import { SettingsPage } from './pages/SettingsPage'
import { OrdersPage } from './pages/OrdersPage'
import { PortalPage } from './pages/PortalPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { CustomersPage } from './pages/CustomersPage'
import { SchedulePage } from './pages/SchedulePage'

/** 主导航项：page 对应角色矩阵下发的页面权限 key，导航与路由守卫按它过滤 */
type AppNavItem = NavItem & { page: string }

const ALL_NAV: AppNavItem[] = [
  { key: 'dashboard', to: '/', label: '总控台', end: true, group: '运行', page: 'dashboard' },
  { key: 'schedule', to: '/schedule', label: '排程计划', group: '运行', page: 'schedule' },
  { key: 'portal', to: '/portal', label: '我的订单', group: '运行', page: 'portal' },
  { key: 'projects', to: '/projects', label: '项目管理', group: '项目', page: 'projects' },
  { key: 'customers', to: '/customers', label: '客户管理', group: '项目', page: 'customers' },
  { key: 'orders', to: '/orders', label: '订单管理', group: '项目', page: 'orders' },
  { key: 'experiments', to: '/experiments', label: '试验中心', group: '试验', page: 'experiments' },
  { key: 'data', to: '/data', label: '数据中心', group: '试验', page: 'data' },
  { key: 'insight', to: '/insight', label: '智能洞察', group: '系统', page: 'insight' },
  { key: 'interlocks', to: '/interlocks', label: '联锁矩阵', group: '系统', page: 'interlocks' },
  { key: 'commands', to: '/commands', label: '命令追踪', group: '系统', page: 'commands' },
  { key: 'settings', to: '/settings', label: '系统设置', group: '系统', page: 'settings' },
]

const PAGE_TITLES: Record<string, string> = {
  '/': '总控台',
  '/subsystems': '子系统',
  '/experiments': '试验中心',
  '/projects': '项目管理',
  '/customers': '客户管理',
  '/orders': '订单管理',
  '/schedule': '排程计划',
  '/portal': '我的订单',
  '/data': '数据中心',
  '/insight': '智能洞察',
  '/interlocks': '联锁矩阵',
  '/commands': '命令追踪',
  '/screen': '大屏',
  '/settings': '系统设置',
  '/equipment': '设备台账',
}

/** 路径 → 页面权限 key；不在表内的路径（旧路由重定向等）返回 null，不做守卫 */
function pageOfPath(pathname: string): string | null {
  if (pathname === '/') return 'dashboard'
  if (pathname.startsWith('/subsystems')) return 'subsystems'
  const key = pathname.split('/')[1]
  return ['portal', 'experiments', 'orders', 'projects', 'customers', 'schedule', 'data', 'insight', 'screen', 'settings', 'equipment', 'interlocks', 'commands'].includes(key) ? key : null
}

/** 旧路由 → 新路由重定向（保留既有 query，如 ?new=1 / ?run=xxx；可指定落入的 tab） */
function RedirectTo({ to, tab }: { to: string; tab?: string }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  if (tab) params.set('tab', tab)
  const search = params.toString()
  return <Navigate to={`${to}${search ? `?${search}` : ''}`} replace />
}

/** 页面守卫：当前路径不在用户 pages 内时，重定向到首个可用页（优先门户，其次总控台）；两者都没有则登出回登录 */
function PageGuard({ user, onLogout, children }: { user: UserInfo; onLogout: () => void; children: React.ReactNode }) {
  const location = useLocation()
  const page = pageOfPath(location.pathname)
  // pages 尚未加载（如 /auth/me 补拉途中）时放行，不误判为无权限
  const pages = user.pages ?? []
  const denied = user.pages !== undefined && page !== null && !pages.includes(page)
  const first = pages.includes('portal') ? '/portal' : pages.includes('dashboard') ? '/' : null

  useEffect(() => {
    if (denied && first === null) onLogout()
  }, [denied, first, onLogout])

  if (denied) return first ? <Navigate to={first} replace /> : null
  return <>{children}</>
}

/** Web Audio 蜂鸣（报警横幅用，默认关闭，设置页可开启） */
function beep(ctxRef: React.MutableRefObject<AudioContext | null>) {
  try {
    if (!ctxRef.current) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctxRef.current = new AC()
    }
    const ctx = ctxRef.current
    if (ctx.state === 'suspended') void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.6)
  } catch {
    /* 浏览器不支持音频时静默 */
  }
}

const SEVERITY_ORDER = ['critical', 'alarm', 'warning', 'info'] as const
const SEVERITY_CN: Record<string, string> = { critical: '严重', alarm: '报警', warning: '预警', info: '提示' }

/** 告警 summary 轮询（4s）：提升到 Shell 层，AlertBanner 与 Sidebar 徽标共享同一份数据 */
function useAlertSummary() {
  const [summary, setSummary] = useState<AlertSummary | null>(null)
  const prevUrgentRef = useRef(0)
  const audioRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const s = await api.aiAlertSummary()
        if (stop) return
        const urgent = (s.critical ?? 0) + (s.alarm ?? 0)
        if (urgent > prevUrgentRef.current && alarmSoundEnabled()) beep(audioRef)
        prevUrgentRef.current = urgent
        setSummary(s)
      } catch {
        /* 轮询失败保持现状 */
      }
    }
    poll()
    const t = window.setInterval(poll, 4000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [])

  return summary
}

function AlertBanner({ summary, onOpen }: { summary: AlertSummary | null; onOpen: () => void }) {
  if (!summary || !summary.total) return null
  const top = SEVERITY_ORDER.find((k) => (summary[k] ?? 0) > 0) ?? 'info'
  const urgent = top === 'critical' || top === 'alarm'

  return (
    <div
      className={`alert-banner ${urgent ? 'alert-banner--danger' : 'alert-banner--warn'}`}
      onClick={onOpen}
      role="alert"
    >
      <span className="alert-banner-title">
        未确认报警：最高级别「{SEVERITY_CN[top]}」
      </span>
      <span className="alert-banner-counts">
        {SEVERITY_ORDER.map((k) =>
          summary[k] ? (
            <span key={k} className={`badge ${k === 'critical' || k === 'alarm' ? 'danger' : k === 'warning' ? 'warn' : 'info'}`}>
              {SEVERITY_CN[k]} {summary[k]}
            </span>
          ) : null,
        )}
      </span>
      <span className="alert-banner-link">就地处理 →</span>
    </div>
  )
}

function Shell({ user, onLogout }: { user: UserInfo; onLogout: () => void }) {
  const [toastMsg, setToastMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [now, setNow] = useState('')
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [alertCenterOpen, setAlertCenterOpen] = useState(false)
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const isPopout = params.get('popout') === '1'
  // kiosk 模式（大屏）：隐藏侧栏、顶栏与报警横幅（大屏顶栏自带告警计数徽标）
  const isKiosk = params.get('kiosk') === '1' && location.pathname === '/screen'
  // popout 未知路径的兜底：支持 ?page=/xxx 直达，否则回子系统详情页
  const pageParam = params.get('page') || ''
  const popoutFallback = ['/', '/screen', '/insight', '/subsystems'].includes(pageParam) ? pageParam : '/subsystems/main_fan'

  // Shell 级共享数据：WS 遥测快照（侧栏徽标 / 命令面板复用，避免各开一份订阅）
  const { frame } = useTelemetry()
  const alertSummary = useAlertSummary()

  // 「子系统」顶级分层：12 个子系统直接可点（实时状态点来自 Shell 共享的 WS 快照，不新增轮询）
  // 导航按用户 pages 过滤；子系统组整组要求 pages 含 'subsystems'
  const navItems = useMemo<NavItem[]>(() => {
    const pages = user.pages ?? []
    const main = ALL_NAV.filter((n) => pages.includes(n.page))
    const subs = frame?.subsystems ?? []
    const subGroup: NavItem[] = pages.includes('subsystems')
      ? SUBSYSTEM_DEFS.map((d) => {
          const live = subs.find((s) => s.id === d.id)
          return {
            key: `sub:${d.id}`,
            to: `/subsystems/${d.id}`,
            label: live?.name ?? d.label,
            group: '子系统',
            icon: SUBSYSTEM_ICONS[d.id] || SUBSYSTEM_ICONS.main_fan,
            dot: subsystemTone(live),
            dotTitle: live ? `${live.state} · ${live.mode === 'simulation' ? '仿真' : '真机'}` : undefined,
          }
        })
      : []
    // 「子系统」组末尾：设备台账（一机一档），独立页面权限 key
    if (pages.includes('equipment')) {
      subGroup.push({ key: 'equipment', to: '/equipment', label: '设备台账', group: '子系统', icon: IconHealth })
    }
    // 子系统组插在「数据中心」后（保持原有分层顺序：…试验 → 子系统 → 系统）
    const idx = main.findIndex((n) => n.key === 'data')
    return idx < 0 ? [...main, ...subGroup] : [...main.slice(0, idx + 1), ...subGroup, ...main.slice(idx + 1)]
  }, [frame, user])

  // 试验矩阵执行状态轮询（侧栏"运行中"脉冲徽标；仅主窗口需要）
  const [matrixActive, setMatrixActive] = useState(false)
  useEffect(() => {
    if (isKiosk || isPopout) return
    let stop = false
    const poll = async () => {
      try {
        const ms = await api.matrices()
        if (stop) return
        setMatrixActive(ms.some((m) => m.exec_status === 'running' || m.exec_status === 'paused'))
      } catch {
        /* 轮询失败保持现状 */
      }
    }
    poll()
    const t = window.setInterval(poll, 5000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [isKiosk, isPopout])

  // 侧栏状态徽标：AI 未确认(严重+报警) / 故障子系统 / 试验进行中（矩阵或实验）
  const navBadges = useMemo(() => {
    const b: Record<string, NavBadge> = {}
    const urgent = (alertSummary?.critical ?? 0) + (alertSummary?.alarm ?? 0)
    if (urgent > 0) b.insight = { kind: 'count', tone: 'danger', count: urgent, title: `未确认严重/报警 ${urgent} 条` }
    // 子系统故障由各导航项的实时状态点表达，不再单独计数徽标
    const phase = frame?.overview.experiment_phase
    const expRunning = !!phase && phase !== '空闲'
    if (matrixActive || expRunning) {
      const title = [
        matrixActive ? '有试验矩阵运行中' : '',
        expRunning ? `实验进行中：${phase}` : '',
      ].filter(Boolean).join('；')
      b.experiments = { kind: 'pulse', tone: 'accent', title }
    }
    return b
  }, [alertSummary, frame, matrixActive])

  // Ctrl+K / ⌘K 呼出命令面板（仅主窗口）
  useEffect(() => {
    if (isKiosk || isPopout) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isKiosk, isPopout])

  const pageTitle = useMemo(() => {
    if (location.pathname.startsWith('/subsystems')) return '子系统'
    return PAGE_TITLES[location.pathname] || 'WTCS'
  }, [location.pathname])

  function toast(text: string, ok = true) {
    setToastMsg({ text, ok })
    window.setTimeout(() => setToastMsg(null), 3500)
  }

  useEffect(() => {
    const tick = () => {
      const d = new Date()
      setNow(d.toLocaleString('zh-CN', { hour12: false }))
    }
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [])

  if (isKiosk) {
    // kiosk 大屏：无侧栏顶栏；告警由大屏自身顶栏徽标表达，不再渲染 AlertBanner
    return (
      <div className="app-shell app-shell--kiosk">
        <main className="main main--kiosk">
          <ScreenPage />
        </main>
        {toastMsg && <div className={`toast badge ${toastMsg.ok ? 'ok' : 'danger'}`}>{toastMsg.text}</div>}
      </div>
    )
  }

  if (isPopout) {
    return (
      <div className="app-shell app-shell--popout">
        <header className="topbar topbar--compact">
          <div className="topbar-left">
            <h1 className="page-title">{pageTitle} · 多屏窗口</h1>
          </div>
          <div className="top-meta">
            <span className="badge info">{user.display_name} · {user.role}</span>
          </div>
        </header>
        <AlertBanner summary={alertSummary} onOpen={() => setAlertCenterOpen(true)} />
        <main className="main">
          <div key={location.pathname} className="page-fade">
            <PageErrorBoundary>
            <Routes>
              <Route path="/subsystems" element={<Navigate to={{ pathname: '/subsystems/main_fan', search: location.search }} replace />} />
              <Route path="/subsystems/:id" element={<SubsystemsPage toast={toast} />} />
              <Route path="/screen" element={<ScreenPage />} />
              <Route path="/insight" element={<InsightPage toast={toast} />} />
              {/* 未知路径：优先按 ?page= 参数直达，注意保留 search 维持 popout 模式 */}
              <Route path="*" element={<Navigate to={{ pathname: popoutFallback, search: location.search }} replace />} />
            </Routes>
            </PageErrorBoundary>
          </div>
        </main>
        <StatusBar user={user} />
        <AlertCenterModal open={alertCenterOpen} onClose={() => setAlertCenterOpen(false)} toast={toast} />
        {toastMsg && <div className={`toast badge ${toastMsg.ok ? 'ok' : 'danger'}`}>{toastMsg.text}</div>}
      </div>
    )
  }

  return (
    <div className="app-shell app-shell--sidebar">
      <Sidebar items={navItems} badges={navBadges} />

      <div className="app-main-column">
        <header className="topbar topbar--compact">
          <div className="topbar-left">
            <h1 className="page-title">{pageTitle}</h1>
            {/* 系统级状态机徽章：全站可见，一眼判定当前能否开车 */}
            {frame?.system_state && (
              <span className={`badge ${frame.system_state.tone}`} title={frame.system_state.unready_aux.length ? `未就绪：${frame.system_state.unready_aux.join('、')}` : '系统级运行状态'}>
                系统 · {frame.system_state.label}
              </span>
            )}
            <span className="badge ok hide-sm">建设期全仿真</span>
          </div>
          <div className="top-meta">
            <button
              type="button"
              className="kbd-trigger hide-sm"
              onClick={() => setCmdkOpen(true)}
              title="命令面板（Ctrl+K）"
            >
              <span className="mono">Ctrl K</span>
            </button>
            <span className="mono hide-sm topbar-clock">{now}</span>
            {/* 大屏在新窗口打开（可拖到投影/电视后 F11），不顶掉当前操作台页面 */}
            <button
              type="button"
              className="icon-btn"
              onClick={() => window.open('/screen', '_blank')}
              title="总控大屏（新窗口打开）"
              aria-label="总控大屏"
            >
              <IconScreen size={16} />
            </button>
            <FullscreenButton />
            <UserMenu user={user} onLogout={onLogout} toast={toast} />
          </div>
        </header>

        {/* 未确认报警横幅：仅运营人员（操作员及以上）可见，不向客户暴露内部告警 */}
        {hasMinRole('操作员') && (
          <AlertBanner summary={alertSummary} onOpen={() => setAlertCenterOpen(true)} />
        )}

        <main className="main">
          <div key={location.pathname} className="page-fade">
            <PageErrorBoundary>
            <PageGuard user={user} onLogout={onLogout}>
            <Routes>
              <Route path="/" element={<DashboardPage toast={toast} />} />
              <Route path="/subsystems" element={<Navigate to={{ pathname: '/subsystems/main_fan', search: location.search }} replace />} />
              <Route path="/subsystems/:id" element={<SubsystemsPage toast={toast} />} />
              <Route path="/equipment" element={<EquipmentPage toast={toast} />} />
              <Route path="/experiments" element={<ExperimentsPage toast={toast} />} />
              <Route path="/orders" element={<OrdersPage toast={toast} />} />
              <Route path="/projects" element={<ProjectsPage toast={toast} />} />
              <Route path="/customers" element={<CustomersPage toast={toast} />} />
              <Route path="/schedule" element={<SchedulePage toast={toast} />} />
              <Route path="/portal" element={<PortalPage toast={toast} />} />
              <Route path="/data" element={<DataPage toast={toast} />} />
              <Route path="/insight" element={<InsightPage toast={toast} />} />
              <Route path="/interlocks" element={<InterlocksPage toast={toast} />} />
              <Route path="/commands" element={<CommandsPage toast={toast} />} />
              <Route path="/screen" element={<ScreenPage />} />
              <Route path="/settings" element={<SettingsPage toast={toast} />} />
              {/* 旧路由重定向（书签兼容）：保留既有 query 并落入对应 tab */}
              <Route path="/matrices" element={<RedirectTo to="/experiments" tab="matrices" />} />
              <Route path="/connectivity" element={<RedirectTo to="/subsystems" />} />
              <Route path="/reports" element={<RedirectTo to="/data" tab="reports" />} />
              <Route path="/audit" element={<RedirectTo to="/data" tab="audit" />} />
              <Route path="/twin" element={<RedirectTo to="/insight" tab="twin" />} />
              <Route path="/ai" element={<RedirectTo to="/insight" tab="ai" />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </PageGuard>
            </PageErrorBoundary>
          </div>
        </main>

        <StatusBar user={user} />
      </div>

      <CommandPalette items={navItems} frame={frame} toast={toast} open={cmdkOpen} onClose={() => setCmdkOpen(false)} />

      <AlertCenterModal open={alertCenterOpen} onClose={() => setAlertCenterOpen(false)} toast={toast} />

      {/* 全站反馈入口：右下角悬浮按钮（登录后常规界面常驻；kiosk 大屏/弹窗模式不显示） */}
      <FeedbackWidget toast={toast} />

      {toastMsg && (
        <div className={`toast badge ${toastMsg.ok ? 'ok' : 'danger'}`}>{toastMsg.text}</div>
      )}
    </div>
  )
}

function AppInner() {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    if (!getToken()) {
      setBooting(false)
      return
    }
    api.me()
      .then((u) => {
        setCurrentUser(u)
        setUser(u)
      })
      .catch(() => setToken(null))
      .finally(() => setBooting(false))
  }, [])

  // api 层 / WS 收到 401/4401 时统一回到登录页
  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener('wtcs:unauthorized', onUnauthorized)
    return () => window.removeEventListener('wtcs:unauthorized', onUnauthorized)
  }, [])

  if (booting) return <div className="login-page">加载中…</div>
  if (!user) {
    return (
      <LoginPage
        onLogin={(u) => {
          // 登录响应不含 pages：先补拉 /auth/me 拿到角色页面集合再进入 Shell，
          // 否则 PageGuard 会把 pages 为空的用户判定为无权限并立即登出
          api.me()
            .then((full) => {
              setCurrentUser(full)
              setUser(full)
            })
            .catch(() => {
              setCurrentUser(u)
              setUser(u)
            })
        }}
      />
    )
  }

  return (
    <Shell
      user={user}
      onLogout={() => {
        setToken(null)
        setCurrentUser(null)
        setUser(null)
      }}
    />
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  )
}
