import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, hasMinRole, type Experiment, type Order, type Project, type Schedule } from '../api'
import { Modal } from '../components/Modal'
import { Tabs } from '../components/Tabs'
import { IconPlus, IconRefresh, IconScreen, IconTrash, IconWall } from '../components/icons'

const SCHEDULE_STATUSES = ['计划中', '已确认', '进行中', '已完成', '已取消']
const SCHEDULE_RESOURCES = ['风洞洞体', '主风机系统', '滚动路面', '移测架', '声学测量', '压力测量']
const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 日视图时间轴窗口：7:00 ~ 21:00 */
const DAY_START_HOUR = 7
const DAY_END_HOUR = 21
const DAY_SPAN_MIN = (DAY_END_HOUR - DAY_START_HOUR) * 60

type SchedView = 'day' | 'week' | 'month'

/** 排程状态徽标配色：进行中 info、已完成 ok、已取消 dim、其他默认 */
function scheduleStatusTone(status: string): string {
  switch (status) {
    case '进行中':
      return 'info'
    case '已完成':
      return 'ok'
    case '已取消':
      return 'dim'
    default:
      return ''
  }
}

/** 本地日期 → YYYY-MM-DD（toISOString 会偏时区，这里手动拼） */
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本周周一 00:00（weekOffset 以周为单位平移） */
function weekMonday(weekOffset: number): Date {
  const now = new Date()
  const dow = (now.getDay() + 6) % 7 // 周一=0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + weekOffset * 7)
  monday.setHours(0, 0, 0, 0)
  return monday
}

/** 今天 + dayOffset 天的 00:00 */
function dayAnchor(dayOffset: number): Date {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset)
  d.setHours(0, 0, 0, 0)
  return d
}

/** 本月 + monthOffset 月的 1 号 00:00 */
function monthAnchor(monthOffset: number): Date {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  d.setHours(0, 0, 0, 0)
  return d
}

/** ISO/存储时间 → datetime-local 输入值（YYYY-MM-DDTHH:MM） */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16)
}

/** ISO 时间 → 当天分钟数（日视图定位用） */
function minutesOf(iso: string): number {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16))
}

/** 日视图泳道布局：同一天多条重叠排程分到不同列，互不遮挡 */
function layoutLanes(items: Schedule[]): { placed: { s: Schedule; lane: number }[]; laneCount: number } {
  const sorted = [...items].sort((a, b) => a.start_at.localeCompare(b.start_at))
  const laneEnds: number[] = []
  const placed = sorted.map((s) => {
    const start = minutesOf(s.start_at)
    const end = Math.max(minutesOf(s.end_at), start + 15)
    let lane = laneEnds.findIndex((e) => e <= start)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else {
      laneEnds[lane] = end
    }
    return { s, lane }
  })
  return { placed, laneCount: Math.max(1, laneEnds.length) }
}

export function SchedulePage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canManage = hasMinRole('维护员') // 排程写操作需维护员+；操作员只读查看
  const [view, setView] = useState<SchedView>('week')
  const [dayOffset, setDayOffset] = useState(0)
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [list, setList] = useState<Schedule[]>([])
  // 新建/编辑弹窗的关联下拉数据
  const [projects, setProjects] = useState<Project[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  // 新建/编辑/只读详情弹窗
  const [editTarget, setEditTarget] = useState<Schedule | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [viewTarget, setViewTarget] = useState<Schedule | null>(null)
  const [fTitle, setFTitle] = useState('')
  const [fProjectId, setFProjectId] = useState('')
  const [fOrderId, setFOrderId] = useState('')
  const [fExperimentId, setFExperimentId] = useState('')
  const [fResource, setFResource] = useState('风洞洞体')
  const [fStart, setFStart] = useState('')
  const [fEnd, setFEnd] = useState('')
  const [fStatus, setFStatus] = useState('计划中')
  const [fNote, setFNote] = useState('')

  const dayDate = useMemo(() => dayAnchor(dayOffset), [dayOffset])
  const days = useMemo(() => {
    const monday = weekMonday(weekOffset)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      return d
    })
  }, [weekOffset])
  const monthFirst = useMemo(() => monthAnchor(monthOffset), [monthOffset])

  /** 当前视图拉取范围 [from, to]（ISO） */
  const range = useMemo((): [string, string] => {
    if (view === 'day') {
      const key = dayKey(dayDate)
      return [`${key}T00:00`, `${key}T23:59:59`]
    }
    if (view === 'month') {
      const last = new Date(monthFirst.getFullYear(), monthFirst.getMonth() + 1, 0)
      return [`${dayKey(monthFirst)}T00:00`, `${dayKey(last)}T23:59:59`]
    }
    return [`${dayKey(days[0])}T00:00`, `${dayKey(days[6])}T23:59:59`]
  }, [view, dayDate, monthFirst, days])

  const refresh = useCallback(async () => {
    setList(await api.listSchedules({ from: range[0], to: range[1] }))
  }, [range])

  useEffect(() => {
    refresh().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [refresh])

  // 关联下拉数据（维护员+ 才需要新建/编辑；实验列表操作员也可读，无需按角色区分）
  useEffect(() => {
    if (!canManage) return
    Promise.all([api.listProjects(), api.listOrders(), api.experiments()])
      .then(([p, o, e]) => {
        setProjects(p)
        setOrders(o)
        setExperiments(e)
      })
      .catch(() => {})
  }, [canManage])

  const projectNameOf = useCallback(
    (id: string | null) => {
      const p = projects.find((x) => x.id === id)
      return p ? `${p.project_no} · ${p.name}` : ''
    },
    [projects],
  )
  const orderNameOf = useCallback(
    (id: string | null) => {
      const o = orders.find((x) => x.id === id)
      return o ? `${o.order_no} · ${o.title}` : ''
    },
    [orders],
  )

  // 关联订单随项目过滤；关联实验随订单过滤
  const orderOptions = fProjectId ? orders.filter((o) => o.project_id === fProjectId) : orders
  const experimentOptions = fOrderId ? experiments.filter((x) => x.order_id === fOrderId) : experiments

  /** 按天分桶：YYYY-MM-DD → 当日排程（按开始时间升序） */
  const byDay = useMemo(() => {
    const map: Record<string, Schedule[]> = {}
    for (const s of list) {
      const key = s.start_at.slice(0, 10)
      ;(map[key] ||= []).push(s)
    }
    for (const items of Object.values(map)) {
      items.sort((a, b) => a.start_at.localeCompare(b.start_at))
    }
    return map
  }, [list])

  /** 新建弹窗默认日期跟随当前视图锚点 */
  function openCreate() {
    let anchor = weekMonday(weekOffset)
    if (view === 'day') anchor = dayDate
    else if (view === 'month') {
      const now = new Date()
      anchor =
        now.getFullYear() === monthFirst.getFullYear() && now.getMonth() === monthFirst.getMonth()
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
          : monthFirst
    }
    setFTitle('')
    setFProjectId('')
    setFOrderId('')
    setFExperimentId('')
    setFResource('风洞洞体')
    setFStart(`${dayKey(anchor)}T08:30`)
    setFEnd(`${dayKey(anchor)}T10:00`)
    setFStatus('计划中')
    setFNote('')
    setCreateOpen(true)
  }

  function openEdit(s: Schedule) {
    setFTitle(s.title)
    setFProjectId(s.project_id ?? '')
    setFOrderId(s.order_id ?? '')
    setFExperimentId(s.experiment_id ?? '')
    setFResource(s.resource)
    setFStart(toLocalInput(s.start_at))
    setFEnd(toLocalInput(s.end_at))
    setFStatus(s.status)
    setFNote(s.note)
    setEditTarget(s)
  }

  function openItem(s: Schedule) {
    if (canManage) openEdit(s)
    else setViewTarget(s)
  }

  /** 月视图点某天 → 切到该天的日视图 */
  function gotoDay(d: Date) {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    setDayOffset(Math.round((d.getTime() - today.getTime()) / 86400000))
    setView('day')
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createSchedule({
        title: fTitle,
        project_id: fProjectId || null,
        order_id: fOrderId || null,
        experiment_id: fExperimentId || null,
        resource: fResource,
        start_at: fStart,
        end_at: fEnd,
        status: fStatus,
        note: fNote,
      })
      toast('排程已创建')
      setCreateOpen(false)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败', false)
    }
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault()
    if (!editTarget) return
    try {
      // 后端约定：关联字段空字符串表示清除
      await api.updateSchedule(editTarget.id, {
        title: fTitle,
        project_id: fProjectId || '',
        order_id: fOrderId || '',
        experiment_id: fExperimentId || '',
        resource: fResource,
        start_at: fStart,
        end_at: fEnd,
        status: fStatus,
        note: fNote,
      })
      toast('排程已更新')
      setEditTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', false)
    }
  }

  async function removeSchedule(s: Schedule) {
    try {
      await api.deleteSchedule(s.id)
      toast(`排程「${s.title}」已删除`)
      setEditTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', false)
    }
  }

  const todayKey = dayKey(new Date())
  const rangeLabel =
    view === 'day'
      ? dayKey(dayDate)
      : view === 'month'
        ? `${monthFirst.getFullYear()}-${String(monthFirst.getMonth() + 1).padStart(2, '0')}`
        : `${dayKey(days[0])} ~ ${dayKey(days[6])}`

  const nav = (
    <div className="sched-week-switch">
      {view === 'day' && (
        <>
          <button type="button" className="btn" onClick={() => setDayOffset((v) => v - 1)}>前一天</button>
          <button type="button" className="btn primary" onClick={() => setDayOffset(0)}>今天</button>
          <button type="button" className="btn" onClick={() => setDayOffset((v) => v + 1)}>后一天</button>
        </>
      )}
      {view === 'week' && (
        <>
          <button type="button" className="btn" onClick={() => setWeekOffset((v) => v - 1)}>上周</button>
          <button type="button" className="btn primary" onClick={() => setWeekOffset(0)}>本周</button>
          <button type="button" className="btn" onClick={() => setWeekOffset((v) => v + 1)}>下周</button>
        </>
      )}
      {view === 'month' && (
        <>
          <button type="button" className="btn" onClick={() => setMonthOffset((v) => v - 1)}>上月</button>
          <button type="button" className="btn primary" onClick={() => setMonthOffset(0)}>本月</button>
          <button type="button" className="btn" onClick={() => setMonthOffset((v) => v + 1)}>下月</button>
        </>
      )}
    </div>
  )

  // —— 日视图数据：当日排程 + 泳道布局 + 小时刻度 ——
  const { placed, laneCount } = layoutLanes(byDay[dayKey(dayDate)] ?? [])
  const hourMarks = useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => DAY_START_HOUR + i),
    [],
  )

  // —— 月视图数据：覆盖整月的周网格（周一开头） ——
  const monthWeeks = useMemo(() => {
    const firstDow = (monthFirst.getDay() + 6) % 7 // 周一=0
    const start = new Date(monthFirst)
    start.setDate(monthFirst.getDate() - firstDow)
    const last = new Date(monthFirst.getFullYear(), monthFirst.getMonth() + 1, 0)
    const weeks: Date[][] = []
    const cursor = new Date(start)
    while (cursor <= last || weeks.length === 0) {
      const week = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(cursor)
        d.setDate(cursor.getDate() + i)
        return d
      })
      weeks.push(week)
      cursor.setDate(cursor.getDate() + 7)
      if (weeks.length >= 6) break
    }
    return weeks
  }, [monthFirst])

  const linkFields = (
    <>
      <div className="form-row">
        <label>关联项目</label>
        <select
          value={fProjectId}
          onChange={(e) => {
            setFProjectId(e.target.value)
            setFOrderId('')
            setFExperimentId('')
          }}
        >
          <option value="">（不关联）</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.project_no} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>关联订单</label>
        <select
          value={fOrderId}
          onChange={(e) => {
            setFOrderId(e.target.value)
            setFExperimentId('')
          }}
        >
          <option value="">（不关联）</option>
          {orderOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.order_no} · {o.title}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>关联实验</label>
        <select value={fExperimentId} onChange={(e) => setFExperimentId(e.target.value)}>
          <option value="">（不关联）</option>
          {experimentOptions.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </div>
    </>
  )

  const timeFields = (
    <>
      <div className="form-row">
        <label>开始时间</label>
        <input type="datetime-local" value={fStart} onChange={(e) => setFStart(e.target.value)} required />
      </div>
      <div className="form-row">
        <label>结束时间</label>
        <input type="datetime-local" value={fEnd} onChange={(e) => setFEnd(e.target.value)} required />
      </div>
    </>
  )

  return (
    <>
      <header className="page-head">
        <h1>排程计划</h1>
        <div className="page-head-side">
          <span className="badge mono hide-sm">{rangeLabel}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => window.open('/screen?mode=schedule&privacy=1&kiosk=1', '_blank')}
            title="候客大屏（去标识化，新窗口打开）"
            aria-label="候客大屏"
          >
            <IconScreen size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => window.open('/screen?mode=schedule&privacy=0&kiosk=1', '_blank')}
            title="调度大屏（控制室完整视图，新窗口打开）"
            aria-label="调度大屏"
          >
            <IconWall size={18} />
          </button>
          {canManage && (
            <button type="button" className="icon-btn" onClick={openCreate} title="新建排程">
              <IconPlus size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新排程">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head panel-head--tabs">
          <Tabs
            tabs={[
              { key: 'day', label: '日视图' },
              { key: 'week', label: '周视图' },
              { key: 'month', label: '月视图' },
            ]}
            value={view}
            onChange={(k) => setView(k as SchedView)}
            param="view"
            ariaLabel="排程视图切换"
          />
          {nav}
        </div>

        {view === 'day' && (
          <div className="sched-tl">
            <div className="sched-tl-axis">
              {hourMarks.map((h) => (
                <div key={h} className="sched-tl-tick mono" style={{ top: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            <div className="sched-tl-canvas">
              {hourMarks.map((h) => (
                <div key={h} className="sched-tl-line" style={{ top: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }} />
              ))}
              {placed.map(({ s, lane }) => {
                const rawStart = minutesOf(s.start_at)
                const rawEnd = Math.max(minutesOf(s.end_at), rawStart + 15)
                const topMin = Math.max(0, Math.min(DAY_SPAN_MIN, rawStart - DAY_START_HOUR * 60))
                const bottomMin = Math.max(topMin + 20, Math.min(DAY_SPAN_MIN, rawEnd - DAY_START_HOUR * 60))
                const tone = scheduleStatusTone(s.status)
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`sched-tl-block${tone ? ` sched-tl-block--${tone}` : ''}`}
                    style={{
                      top: `${(topMin / DAY_SPAN_MIN) * 100}%`,
                      height: `${((bottomMin - topMin) / DAY_SPAN_MIN) * 100}%`,
                      left: `${(lane / laneCount) * 100}%`,
                      width: `${100 / laneCount}%`,
                    }}
                    onClick={() => openItem(s)}
                    title={canManage ? '查看 / 编辑排程' : '查看排程'}
                  >
                    <div className="sched-card-title">{s.title}</div>
                    <div className="sched-card-meta mono">
                      {s.start_at.slice(11, 16)}~{s.end_at.slice(11, 16)} · {s.resource}
                    </div>
                    <span className={`badge ${tone}`.trim()}>{s.status}</span>
                  </button>
                )
              })}
              {!placed.length && <div className="sched-tl-empty">当日暂无排程</div>}
            </div>
          </div>
        )}

        {view === 'week' && (
          <div className="sched-week">
            {days.map((d, i) => {
              const key = dayKey(d)
              const items = byDay[key] ?? []
              return (
                <div key={key} className={`sched-day ${key === todayKey ? 'sched-day--today' : ''}`}>
                  <div className="sched-day-head">
                    <span className="sched-day-name">{WEEKDAY_CN[i]}</span>
                    <span className="sched-day-date mono">{key.slice(5)}</span>
                  </div>
                  <div className="sched-day-body">
                    {items.map((s) => (
                      <button key={s.id} type="button" className="sched-card" onClick={() => openItem(s)} title={canManage ? '查看 / 编辑排程' : '查看排程'}>
                        <div className="sched-card-title">{s.title}</div>
                        <div className="sched-card-meta mono">
                          {s.start_at.slice(11, 16)}~{s.end_at.slice(11, 16)} · {s.resource}
                        </div>
                        <span className={`badge ${scheduleStatusTone(s.status)}`.trim()}>{s.status}</span>
                      </button>
                    ))}
                    {!items.length && <div className="sched-day-empty">—</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {view === 'month' && (
          <div className="sched-month">
            <div className="sched-month-row sched-month-row--head">
              {WEEKDAY_CN.map((w) => (
                <div key={w} className="sched-month-weekday">{w}</div>
              ))}
            </div>
            {monthWeeks.map((week, wi) => (
              <div key={wi} className="sched-month-row">
                {week.map((d) => {
                  const key = dayKey(d)
                  const items = byDay[key] ?? []
                  const inMonth = d.getMonth() === monthFirst.getMonth()
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`sched-mcell${inMonth ? '' : ' sched-mcell--out'}${key === todayKey ? ' sched-mcell--today' : ''}`}
                      onClick={() => gotoDay(d)}
                      title="查看该天日视图"
                    >
                      <span className="sched-mcell-date mono">{d.getDate()}</span>
                      {items.slice(0, 3).map((s) => (
                        <span key={s.id} className={`sched-chip${scheduleStatusTone(s.status) ? ` sched-chip--${scheduleStatusTone(s.status)}` : ''}`}>
                          <span className="mono">{s.start_at.slice(11, 16)}</span> {s.title}
                        </span>
                      ))}
                      {items.length > 3 && <span className="sched-chip sched-chip--more">+{items.length - 3}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新建排程弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="sm"
        title="新建排程"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-schedule-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-schedule-create" onSubmit={submitCreate}>
          <div className="form-row">
            <label>标题</label>
            <input autoFocus value={fTitle} onChange={(e) => setFTitle(e.target.value)} required />
          </div>
          {linkFields}
          <div className="form-row">
            <label>资源</label>
            <select value={fResource} onChange={(e) => setFResource(e.target.value)}>
              {SCHEDULE_RESOURCES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          {timeFields}
          <div className="form-row">
            <label>状态</label>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              {SCHEDULE_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>备注</label>
            <textarea rows={3} value={fNote} onChange={(e) => setFNote(e.target.value)} />
          </div>
        </form>
      </Modal>

      {/* 编辑排程弹窗 */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        size="sm"
        title={`编辑排程 · ${editTarget?.title ?? ''}`}
        footer={
          <>
            <button className="btn danger" onClick={() => editTarget && void removeSchedule(editTarget)}>
              <IconTrash size={14} /> 删除
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-schedule-edit" type="submit">保存</button>
          </>
        }
      >
        <form id="wtcs-schedule-edit" onSubmit={submitEdit}>
          <div className="form-row">
            <label>标题</label>
            <input autoFocus value={fTitle} onChange={(e) => setFTitle(e.target.value)} required />
          </div>
          {linkFields}
          <div className="form-row">
            <label>资源</label>
            <select value={fResource} onChange={(e) => setFResource(e.target.value)}>
              {SCHEDULE_RESOURCES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          {timeFields}
          <div className="form-row">
            <label>状态</label>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              {SCHEDULE_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>备注</label>
            <textarea rows={3} value={fNote} onChange={(e) => setFNote(e.target.value)} />
          </div>
        </form>
      </Modal>

      {/* 只读详情弹窗（操作员/客户等无写权限角色） */}
      <Modal open={!!viewTarget} onClose={() => setViewTarget(null)} size="sm" title={`排程详情 · ${viewTarget?.title ?? ''}`}>
        {viewTarget && (
          <>
            <div className="badge-row">
              <span className={`badge ${scheduleStatusTone(viewTarget.status)}`.trim()}>{viewTarget.status}</span>
              <span className="badge">{viewTarget.resource}</span>
              <span className="badge mono">
                {viewTarget.start_at.replace('T', ' ').slice(0, 16)} ~ {viewTarget.end_at.replace('T', ' ').slice(0, 16)}
              </span>
            </div>
            {viewTarget.project_id && projectNameOf(viewTarget.project_id) && (
              <div className="form-row">
                <label>关联项目</label>
                <span>{projectNameOf(viewTarget.project_id)}</span>
              </div>
            )}
            {viewTarget.order_id && orderNameOf(viewTarget.order_id) && (
              <div className="form-row">
                <label>关联订单</label>
                <span>{orderNameOf(viewTarget.order_id)}</span>
              </div>
            )}
            {viewTarget.note && (
              <div className="form-row">
                <label>备注</label>
                <span>{viewTarget.note}</span>
              </div>
            )}
            <div className="form-row">
              <label>创建人</label>
              <span className="mono">{viewTarget.created_by}</span>
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
