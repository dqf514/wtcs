import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  api,
  hasMinRole,
  roleAllowed,
  type AiAlert,
  type ConnectivityReport,
  type HealthStatus,
  type Role,
  type SubsystemStatus,
  type TelemetryHistoryPoint,
  type TelemetryPoint,
  type TwinHealthReport,
} from '../api'
import { paramMeta, POINT_META } from '../paramMeta'
import { keyReadings, SUBSYSTEM_DEFS } from '../subsystems'
import { useCommand } from '../hooks/useCommand'
import { useTelemetry } from '../hooks/useTelemetry'
import {
  IconNetwork,
  IconSubsystems,
  IconFullscreen,
  SUBSYSTEM_ICONS,
} from '../components/icons'
import { AnalogBar, MiniTrend } from '../components/AnalogBar'
import { FanSchematic } from '../components/schematics/FanSchematic'
import { CoolingSchematic } from '../components/schematics/CoolingSchematic'
import { CommandButton } from '../components/CommandButton'
import { ToggleCommandButton } from '../components/ToggleCommandButton'
import type { CommandSpec } from '../api'

/** 启停命令对：start/stop、start_belt/stop_belt、start_acquire/stop_acquire 合并为一个状态感知按钮 */
const TOGGLE_PAIRS: [string, string][] = [
  ['start', 'stop'],
  ['start_belt', 'stop_belt'],
  ['start_acquire', 'stop_acquire'],
]

type CmdEntry = { kind: 'toggle'; start: CommandSpec; stop: CommandSpec } | { kind: 'single'; cmd: CommandSpec }

/** 把可见命令折叠成渲染条目：成对的启停命令合并为一个 toggle 条目，顺序保持 */
function buildCmdEntries(commands: CommandSpec[]): CmdEntry[] {
  const entries: CmdEntry[] = []
  const used = new Set<string>()
  for (const cmd of commands) {
    if (used.has(cmd.name)) continue
    const pair = TOGGLE_PAIRS.find(([a, b]) => cmd.name === a && commands.some((c) => c.name === b))
    if (pair) {
      const stop = commands.find((c) => c.name === pair[1])
      if (stop) {
        used.add(cmd.name)
        used.add(stop.name)
        entries.push({ kind: 'toggle', start: cmd, stop })
        continue
      }
    }
    used.add(cmd.name)
    entries.push({ kind: 'single', cmd })
  }
  return entries
}

/** 启停对的运行状态判定：running/acquiring 布尔点位，皮带用 belt_speed>0.01，冷却水用任一冷机 */
function pairRunning(points: TelemetryPoint[], startName: string): boolean | null {
  const boolPt = (k: string): boolean | undefined => {
    const v = points.find((p) => p.key === k)?.value
    if (v === undefined || v === null) return undefined
    return v === true || v === 1 || v === 'true'
  }
  if (startName === 'start') {
    const r = boolPt('running')
    if (r !== undefined) return r
    const chillers = ['chiller1_on', 'chiller2_on', 'chiller3_on'].map(boolPt).filter((v): v is boolean => v !== undefined)
    if (chillers.length) return chillers.some(Boolean)
    return null
  }
  if (startName === 'start_acquire') return boolPt('acquiring') ?? null
  if (startName === 'start_belt') {
    const n = Number(points.find((p) => p.key === 'belt_speed')?.value)
    return Number.isFinite(n) ? n > 0.01 : null
  }
  return null
}

/** 告警严重度徽标（与 InsightPage 语义一致） */
const SEV_BADGE: Record<string, string> = { critical: 'danger', alarm: 'danger', warning: 'warn', info: 'info' }
const SEV_CN: Record<string, string> = { critical: '严重', alarm: '报警', warning: '预警', info: '提示' }

/** 健康基线状态徽标（与 InsightPage STATUS_BADGE 一致） */
const HEALTH_BADGE: Record<HealthStatus, string> = {
  learning: 'dim',
  normal: '',
  attention: 'warn',
  abnormal: 'danger',
}

/** 布尔点位的中文化 + 颜色语义：颜色只表异常（fault/e_stop=true、ready/interlock=false 才着色） */
function boolBadge(p: TelemetryPoint) {
  const v = p.value === true || p.value === 'true' || p.value === 1
  switch (p.key) {
    case 'fault':
      return v ? <span className="badge danger">故障</span> : <span className="badge">正常</span>
    case 'e_stop':
      return v ? <span className="badge danger">已触发</span> : <span className="badge">未触发</span>
    case 'ready':
      return v ? <span className="badge">就绪</span> : <span className="badge warn">未就绪</span>
    case 'interlock_ok':
    case 'door_ok':
      return v ? <span className="badge">正常</span> : <span className="badge danger">异常</span>
    case 'local_debug':
      return v ? <span className="badge warn">本地调试</span> : <span className="badge">远程</span>
    case 'running':
      return v ? <span className="badge">运行中</span> : <span className="badge">停止</span>
    case 'acquiring':
      return v ? <span className="badge">采集中</span> : <span className="badge">空闲</span>
    case 'moving':
      return v ? <span className="badge">运动中</span> : <span className="badge">静止</span>
    default:
      return <span className="badge">{v ? '是' : '否'}</span>
  }
}

/** 点位读数：有元数据的模拟量用条形指示，布尔用 badge，其余纯数字 */
function PointValue({ point }: { point: TelemetryPoint }) {
  const n = typeof point.value === 'number' ? point.value : Number(point.value)
  const meta = POINT_META[point.key]
  if (meta && Number.isFinite(n)) {
    return (
      <AnalogBar
        label={point.label}
        value={n}
        unit={point.unit}
        min={meta.min}
        max={meta.max}
        normal={meta.normal}
        precision={point.unit === 'mm' || point.unit === '%' ? 0 : 1}
      />
    )
  }
  const isBool = point.value === true || point.value === false || point.unit === '' && (point.value === 0 || point.value === 1) && /on|ok|ready|fault|debug|running|acquiring|moving|e_stop/.test(point.key)
  if (isBool) return <div className="point-bool">{point.label}{boolBadge({ ...point, value: point.value === true || point.value === 1 })}</div>
  return (
    <div className="point-plain">
      <span>{point.label}</span>
      <span className="mono">{String(point.value)} {point.unit}</span>
    </div>
  )
}

export function SubsystemsPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { frame } = useTelemetry()
  const { send } = useCommand(toast)
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<SubsystemStatus | null>(null)

  // 连通性测试
  const [reports, setReports] = useState<ConnectivityReport[]>([])
  const [testing, setTesting] = useState(false)
  const canTest = hasMinRole('操作员')
  const canSwitch = hasMinRole('维护员')

  // 右栏态势：健康基线 + 未确认告警（5s 轮询，仅详情视图）
  const [health, setHealth] = useState<TwinHealthReport | null>(null)
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  // 最近事件：该子系统的审计操作（与告警同周期轮询）
  const [subOps, setSubOps] = useState<Awaited<ReturnType<typeof api.audit>>>([])
  // 趋势区：该子系统有宽表历史（telemetry_wide）的点 key 集合 + 历史序列
  const [loggedKeys, setLoggedKeys] = useState<Set<string>>(new Set())
  const [trendSeries, setTrendSeries] = useState<Record<string, TelemetryHistoryPoint[]>>({})

  // /subsystems/:id 深链：拉取契约详情（点位/命令元数据）
  useEffect(() => {
    if (!id) {
      setDetail(null)
      return
    }
    setParamDraft({})
    let stop = false
    api.subsystem(id)
      .then((d) => { if (!stop) setDetail(d) })
      .catch((e) => toast(String(e), false))
    return () => { stop = true }
  }, [id])

  useEffect(() => {
    if (!id) return
    let stop = false
    const poll = async () => {
      try {
        const [h, a, au] = await Promise.all([
          api.twinHealth(),
          api.aiAlerts({ acked: false, limit: 100 }),
          api.audit(100),
        ])
        if (stop) return
        setHealth(h)
        setAlerts(a)
        setSubOps(au.filter((x) => x.subsystem_id === id).slice(0, 5))
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
  }, [id])

  // 趋势区数据源：开放点位元数据标记了哪些点有宽表历史（logged）
  useEffect(() => {
    if (!id) return
    let stop = false
    api
      .openPoints()
      .then((r) => {
        if (stop) return
        setLoggedKeys(new Set(r.points.filter((p) => p.subsystem === id && p.logged).map((p) => p.point)))
      })
      .catch(() => {})
    return () => {
      stop = true
    }
  }, [id])

  const live = useMemo(
    () => frame?.subsystems.find((s) => s.id === id),
    [frame, id],
  )
  const current = detail && detail.id === id ? { ...detail, ...live, points: live?.points ?? detail.points } : live
  const canCommand = hasMinRole('操作员')
  const visibleCommands = useMemo(
    () =>
      (current?.contract?.commands || detail?.contract?.commands || []).filter((c) =>
        roleAllowed(c.min_role as Role | undefined),
      ),
    [current, detail],
  )

  // 趋势点位：契约中的数值型点且有宽表历史（最多 6 个，防图表过密）
  const trendDefs = useMemo(
    () =>
      (detail?.contract?.points ?? [])
        .filter((p) => (!p.dtype || p.dtype === 'float' || p.dtype === 'int') && loggedKeys.has(p.key))
        .slice(0, 6),
    [detail, loggedKeys],
  )

  // 趋势历史：近 30 分钟，60s 自动刷新（序列按 `${id}.${key}` 索引，切换子系统后旧数据不会被引用）
  useEffect(() => {
    if (!id || !trendDefs.length) return
    let stop = false
    const keys = trendDefs.map((d) => `${id}.${d.key}`)
    const load = () =>
      api
        .telemetryHistory(keys, 30, 360)
        .then((r) => {
          if (!stop) setTrendSeries(r.series)
        })
        .catch(() => {})
    load()
    const t = window.setInterval(load, 60000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [id, trendDefs])

  async function runCmd(name: string, paramsKeys: string[], confirmed = false) {
    if (!id) return
    const params: Record<string, unknown> = {}
    for (const k of paramsKeys) {
      const meta = paramMeta(k)
      const raw = paramDraft[k]
      if (meta.type === 'boolean') {
        params[k] = raw === '1'
        continue
      }
      if (raw === undefined || raw === '') {
        toast(`「${meta.label}」不能为空，请输入数值后再执行`, false)
        return
      }
      const n = Number(raw)
      if (Number.isNaN(n)) {
        toast(`「${meta.label}」需为数值`, false)
        return
      }
      if ((meta.min !== undefined && n < meta.min) || (meta.max !== undefined && n > meta.max)) {
        toast(`「${meta.label}」超出范围（${meta.min ?? '-∞'} ~ ${meta.max ?? '+∞'}${meta.unit ? ` ${meta.unit}` : ''}）`, false)
        return
      }
      params[k] = n
    }
    await send(id, name, params, { confirmed })
  }

  async function testOne(subId: string) {
    setTesting(true)
    try {
      const r = await api.connectivityOne(subId)
      setReports((prev) => [r, ...prev.filter((x) => x.subsystem_id !== subId)])
      toast(`${r.subsystem_id} 连通性测试${r.passed ? '通过' : '失败'}`, r.passed)
    } catch (e) {
      toast(e instanceof Error ? e.message : '测试失败', false)
    } finally {
      setTesting(false)
    }
  }

  async function testAll() {
    setTesting(true)
    try {
      const r = await api.connectivityAll()
      setReports(r.reports)
      toast(`全量测试：${r.passed}/${r.total} 通过`, r.all_ok)
    } catch (e) {
      toast(e instanceof Error ? e.message : '测试失败', false)
    } finally {
      setTesting(false)
    }
  }

  async function switchMode(subId: string, mode: 'simulation' | 'real') {
    try {
      await api.switchMode(subId, mode)
      toast(`已请求切换 ${subId} → ${mode}`)
      if (id === subId) setDetail(await api.subsystem(subId))
    } catch (e) {
      toast(e instanceof Error ? e.message : '切换失败', false)
    }
  }

  function openPopout() {
    const url = `${window.location.origin}/subsystems${id ? `/${id}` : ''}?popout=1`
    window.open(url, 'wtcs_subsystems', 'popup=yes,width=1100,height=800')
  }

  const subsystems = frame?.subsystems ?? []
  const CurrentIcon = id ? SUBSYSTEM_ICONS[id] || SUBSYSTEM_ICONS.main_fan : null
  const currentReport = reports.find((r) => r.subsystem_id === id)
  const idKnown = !!id && (SUBSYSTEM_DEFS.some((d) => d.id === id) || subsystems.some((s) => s.id === id))

  const pageHead = (
    <header className="page-head">
      <h1>{id && current ? `子系统 / ${current.name}` : '子系统'}</h1>
      <div className="page-head-side">
        {canTest && (
          <button type="button" className="icon-btn" disabled={testing} onClick={testAll} title="全量子系统连通性测试">
            <IconNetwork size={18} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={openPopout} title="新窗口打开，可拖到其他屏幕">
          <IconFullscreen size={18} />
        </button>
      </div>
    </header>
  )

  if (!subsystems.length) {
    return (
      <div>
        {pageHead}
        <div className="empty">
          <IconSubsystems size={28} />
          <div>遥测数据加载中…</div>
        </div>
      </div>
    )
  }

  // /subsystems 裸路由已在 App.tsx 重定向到 /subsystems/main_fan，此处始终有 id
  if (!id) return null

  // —— 详情：中（头部 + 点位/命令/连通性平铺）右（态势）两栏 ——
  const healthEntry = health?.subsystems.find((s) => s.id === id)
  const subAlerts = alerts.filter((a) => a.subsystem_id === id)
  const topReadings = keyReadings(current?.points ?? [], 4)

  return (
    <div>
      {pageHead}
      <div className="sub-layout">
        {/* 中栏：头部 + 点位/命令/连通性 Tabs（子系统切换走左侧主导航） */}
        <section className="panel sub-main-panel">
          {!idKnown && (
            <div className="empty">
              未找到子系统「{id}」，
              <Link to={{ pathname: '/subsystems/main_fan', search: location.search }}>查看主风机系统</Link>
            </div>
          )}
          {idKnown && !current && <div className="empty">加载中…</div>}
          {idKnown && current && (
            <>
              <div className="sub-head">
                {CurrentIcon && <span className="sub-card-icon sub-head-icon"><CurrentIcon size={22} /></span>}
                <div className="sub-head-main">
                  <div className="sub-head-title">
                    <strong>{current.name}</strong>
                    <span className="badge info">{current.mode === 'simulation' ? '仿真' : '真机'}</span>
                    <span className={`badge ${current.fault ? 'danger' : current.ready ? 'ok' : 'warn'}`}>
                      {current.fault ? '故障' : current.ready ? '就绪' : current.state}
                    </span>
                    {current.local_debug && <span className="badge warn">本地调试</span>}
                  </div>
                  {(current.contract?.description || detail?.contract?.description) && (
                    <p className="panel-desc sub-head-desc">{current.contract?.description || detail?.contract?.description}</p>
                  )}
                </div>
              </div>

              {/* 工艺示意图：主风机 / 冷却水（数据驱动，其余子系统布局不动） */}
              {id === 'main_fan' && (
                <div className="sub-sec">
                  <div className="sub-sec-head">
                    <span className="label-cap">工艺示意图</span>
                  </div>
                  <FanSchematic points={current.points} fault={current.fault} />
                </div>
              )}
              {id === 'cooling_water' && (
                <div className="sub-sec">
                  <div className="sub-sec-head">
                    <span className="label-cap">工艺示意图</span>
                  </div>
                  <CoolingSchematic points={current.points} fault={current.fault} />
                </div>
              )}

              {/* 点位 / 命令 / 连通性测试 全部平铺展示（不再 Tab 切换） */}
              <div className="sub-sec">
                <div className="sub-sec-head">
                  <span className="label-cap">点位</span>
                  <span className="mono text-dim">{current.points.length}</span>
                </div>
                <div className="point-grid">
                  {current.points.map((p) => (
                    <PointValue key={p.key} point={p} />
                  ))}
                </div>
              </div>

              {/* 趋势：该子系统有宽表历史的数值点位，近 30 分钟（60s 自动刷新） */}
              {trendDefs.length > 0 && (
                <div className="sub-sec">
                  <div className="sub-sec-head">
                    <span className="label-cap">趋势 · 近 30 分钟</span>
                    <span className="mono text-dim">{trendDefs.length}</span>
                  </div>
                  <div className="sub-kpi-grid">
                    {trendDefs.map((d) => {
                      const pts = trendSeries[`${id}.${d.key}`] ?? []
                      const last = pts.length ? pts[pts.length - 1].v : null
                      return (
                        <div key={d.key} className="instr">
                          <label className="label-cap">{d.label}</label>
                          <span className="instr-value mono">
                            {last != null ? last.toFixed(1) : '--'}
                            {d.unit && <em>{d.unit}</em>}
                          </span>
                          {pts.length > 1 ? (
                            <MiniTrend values={pts.map((p) => p.v)} height={30} />
                          ) : (
                            <div className="text-dim cell-note">历史数据积累中…</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {canCommand && (
                <div className="sub-sec">
                  <div className="sub-sec-head">
                    <span className="label-cap">命令</span>
                    <span className="mono text-dim">{visibleCommands.length}</span>
                  </div>
                  {!visibleCommands.length && <div className="empty">该子系统没有当前角色可执行的命令</div>}
                  <div className="cmd-grid">
                  {buildCmdEntries(visibleCommands).map((entry) =>
                    entry.kind === 'toggle' ? (
                      /* 启停合一：运行态显示停止、停止态显示启动，弹窗确认 */
                      <div key={entry.start.name} className="cmd-block">
                        <div className="cmd-block-head">
                          {entry.start.label} / {entry.stop.label}{' '}
                          <span className="mono cmd-name">{entry.start.name}/{entry.stop.name}</span>
                        </div>
                        <ToggleCommandButton
                          running={pairRunning(current.points, entry.start.name)}
                          startLabel={entry.start.label}
                          stopLabel={entry.stop.label}
                          onStart={() => runCmd(entry.start.name, entry.start.params, true)}
                          onStop={() => runCmd(entry.stop.name, entry.stop.params, true)}
                        />
                      </div>
                    ) : (
                    <div key={entry.cmd.name} className="cmd-block">
                      <div className="cmd-block-head">{entry.cmd.label} <span className="mono cmd-name">{entry.cmd.name}</span></div>
                      {entry.cmd.params.map((p) => {
                        const meta = paramMeta(p)
                        return (
                          <div className="form-row" key={p}>
                            <label>{meta.label}{meta.unit ? ` (${meta.unit})` : ''}</label>
                            {meta.type === 'boolean' ? (
                              <select
                                value={paramDraft[p] ?? '1'}
                                onChange={(e) => setParamDraft((d) => ({ ...d, [p]: e.target.value }))}
                              >
                                <option value="1">是</option>
                                <option value="0">否</option>
                              </select>
                            ) : (
                              <input
                                type="number"
                                min={meta.min}
                                max={meta.max}
                                step={meta.step}
                                value={paramDraft[p] ?? ''}
                                onChange={(e) => setParamDraft((d) => ({ ...d, [p]: e.target.value }))}
                                placeholder={
                                  meta.min !== undefined && meta.max !== undefined
                                    ? `${meta.min} ~ ${meta.max}`
                                    : '参数值'
                                }
                                title={meta.hint}
                              />
                            )}
                          </div>
                        )
                      })}
                      <CommandButton
                        variant={entry.cmd.require_confirm ? 'danger' : 'primary'}
                        confirmMessage={
                          entry.cmd.require_confirm
                            ? `确认对「${current.name}」执行「${entry.cmd.label}」？`
                            : undefined
                        }
                        onClick={() => runCmd(entry.cmd.name, entry.cmd.params, entry.cmd.require_confirm)}
                      >
                        执行
                      </CommandButton>
                    </div>
                    ),
                  )}
                  </div>
                </div>
              )}

              <div className="sub-sec">
                <div className="sub-sec-head">
                  <span className="label-cap">最近事件</span>
                </div>
                <div className="event-cols">
                  <div>
                    <span className="label-cap event-col-head">未确认告警</span>
                    {!subAlerts.length && <div className="empty">暂无事件</div>}
                    {subAlerts.slice(0, 5).map((a) => (
                      <div key={a.id} className="alert-entry">
                        <span className={`badge ${SEV_BADGE[a.severity] ?? ''}`}>{SEV_CN[a.severity] ?? a.severity}</span>
                        <div className="alert-entry-msg">{a.message}</div>
                        <div className="alert-ts">{a.ts}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <span className="label-cap event-col-head">最近操作</span>
                    {!subOps.length && <div className="empty">暂无事件</div>}
                    {subOps.map((op) => (
                      <div key={op.id} className="alert-entry">
                        <span className="badge info">{op.action}</span>
                        <div className="alert-entry-msg">{op.detail}</div>
                        <div className="alert-ts">{op.user} · {String(op.ts).replace('T', ' ').slice(0, 19)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="sub-sec">
                <div className="sub-sec-head">
                  <span className="label-cap">连通性测试</span>
                </div>
                <p className="panel-desc">
                    建设期默认为仿真适配器。硬件上线后：修改
                    <code className="mono"> backend/config/subsystems.yaml </code>
                    的 endpoint，关闭强制仿真并切到真机，再运行测试。
                  </p>
                  <div className="actions actions-flush actions-mb">
                    {canTest && (
                      <button className="btn primary" disabled={testing} onClick={() => testOne(current.id)}>
                        测试该子系统
                      </button>
                    )}
                    {canSwitch && (
                      <>
                        <button className="btn" onClick={() => switchMode(current.id, 'simulation')}>切仿真</button>
                        <button className="btn" onClick={() => switchMode(current.id, 'real')}>切真机</button>
                      </>
                    )}
                    <span className="mono text-dim cell-note">{current.protocol || '-'} {current.endpoint || ''}</span>
                  </div>
                  {!currentReport && <div className="empty">尚未测试，点击「测试该子系统」验证链路</div>}
                  {currentReport && (
                    <div className="report-entry">
                      <div className="panel-head">
                        <strong>{currentReport.subsystem_id}</strong>
                        <span className={`badge ${currentReport.passed ? 'ok' : 'danger'}`}>
                          {currentReport.passed ? '通过' : '失败'} · {currentReport.mode}
                        </span>
                      </div>
                      <table className="table">
                        <tbody>
                          {currentReport.items.map((it) => (
                            <tr key={it.name}>
                              <td>{it.name}</td>
                              <td className={it.ok ? '' : 'badge danger'}>{it.ok ? 'OK' : 'FAIL'}</td>
                              <td>{it.detail}{it.latency_ms != null ? ` (${it.latency_ms}ms)` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </div>
            </>
          )}
        </section>

        {/* 右栏：态势面板（关键读数 / 健康度 / 未确认告警 / 基本信息） */}
        <aside className="sub-side">
          <div className="panel">
            <div className="panel-head"><h2>关键读数</h2></div>
            {!topReadings.length && <div className="empty">暂无可指示的模拟量</div>}
            {topReadings.length > 0 && (
              <div className="sub-kpi-grid">
                {topReadings.map((r) => (
                  <div key={r.label} className="instr">
                    <label className="label-cap">{r.label}</label>
                    <span className="instr-value mono">{r.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>健康度</h2></div>
            {!health && <div className="empty">健康数据加载中…</div>}
            {health && !healthEntry && <div className="empty">该子系统暂无健康基线数据</div>}
            {healthEntry && (
              <>
                <div className="panel-head health-item-head">
                  <span className={`badge ${HEALTH_BADGE[healthEntry.status]}`}>{healthEntry.status_cn}</span>
                  <span className="mono sub-health-score">{healthEntry.score ?? '--'}</span>
                </div>
                <div className={`health-bar health-bar--${healthEntry.status}`}>
                  <i style={{ width: `${healthEntry.score ?? 0}%` }} />
                </div>
                <div className="health-point-meta mono">监测测点 {healthEntry.monitored_points} 个</div>
              </>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>未确认告警</h2></div>
            {!subAlerts.length && <div className="empty">暂无未确认告警</div>}
            {subAlerts.slice(0, 6).map((a) => (
              <button
                key={a.id}
                type="button"
                className="alert-entry alert-entry--link"
                onClick={() => navigate('/insight?tab=ai')}
                title="前往智能洞察确认告警"
              >
                <span className={`badge ${SEV_BADGE[a.severity] ?? ''}`}>{SEV_CN[a.severity] ?? a.severity}</span>
                <div className="alert-entry-msg">{a.message}</div>
                <div className="alert-ts">{a.ts}</div>
              </button>
            ))}
            {subAlerts.length > 6 && (
              <button type="button" className="link-btn text-dim cell-note" onClick={() => navigate('/insight?tab=ai')}>
                还有 {subAlerts.length - 6} 条，前往智能洞察 →
              </button>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>基本信息</h2></div>
            <div className="kv-row"><span>协议</span><span className="mono">{current?.protocol || '—'}</span></div>
            <div className="kv-row"><span>端点</span><span className="mono">{current?.endpoint || '—'}</span></div>
            <div className="kv-row"><span>运行模式</span><span>{current ? (current.mode === 'simulation' ? '仿真' : '真机') : '—'}</span></div>
            <div className="kv-row"><span>连接状态</span><span>{current?.state || '—'}</span></div>
            <div className="kv-row"><span>点位数</span><span className="mono">{current?.points.length ?? '—'}</span></div>
            <div className="kv-row"><span>命令数</span><span className="mono">{visibleCommands.length}</span></div>
          </div>
        </aside>
      </div>
    </div>
  )
}
