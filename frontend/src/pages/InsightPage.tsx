import { useEffect, useState } from 'react'
import { api, hasMinRole, type AiAlert, type AlertSeverity, type AskSource, type HealthPoint, type HealthStatus, type TwinHealthReport } from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { DeviationBar } from '../components/DeviationBar'
import { Tabs } from '../components/Tabs'
import { ConfirmModal } from '../components/Modal'
import { IconRefresh, IconFullscreen, IconHealth, IconSearch } from '../components/icons'

const STATUS_BADGE: Record<HealthStatus, string> = {
  learning: 'dim',
  normal: '',
  attention: 'warn',
  abnormal: 'danger',
}

function fmt(v: number | null | undefined, precision = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(precision) : '--'
}

/** 健康基线：子系统级卡片 + 选中展开测点明细 */
function HealthPanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [report, setReport] = useState<TwinHealthReport | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<{ id: string; name: string } | null>(null)
  const canReset = hasMinRole('维护员')

  async function refresh() {
    setReport(await api.twinHealth())
  }

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    const t = window.setInterval(() => refresh().catch(() => {}), 4000)
    return () => window.clearInterval(t)
  }, [])

  async function reset(sub: { id: string; name: string }) {
    try {
      await api.twinHealthReset(sub.id)
      toast(`「${sub.name}」基线已重置，重新进入学习期`)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '重置失败', false)
    }
  }

  const subs = report?.subsystems ?? []
  const active = subs.find((s) => s.id === selected) ?? subs[0] ?? null
  const points: HealthPoint[] = active ? (report?.points ?? []).filter((p) => p.subsystem === active.id) : []

  return (
    <div className="panel panel-mb">
      <div className="panel-head">
        <h2>健康基线</h2>
        {report && (
          <span className={`badge ${report.learning_enabled ? 'ok' : 'warn'}`}>
            {report.learning_enabled ? '基线学习中' : '基线学习已暂停'}
          </span>
        )}
      </div>
      {!report && <div className="empty">健康数据加载中…</div>}
      {report && !report.learning_enabled && (
        <div className="hint hint-tight">基线学习已暂停，当前评分基于已冻结的基线数据。</div>
      )}
      {subs.map((s) => (
        <div key={s.id} className={`health-item${active?.id === s.id ? ' active' : ''}`}>
          <div className="panel-head health-item-head">
            <button className="link-btn health-name" onClick={() => setSelected(active?.id === s.id ? null : s.id)}>
              {s.name}
              <span className="text-dim health-points-count">{s.monitored_points} 测点</span>
            </button>
            <span className="badge-row badge-row-flush">
              <span className={`badge ${STATUS_BADGE[s.status]}`}>{s.status_cn}</span>
              <span className="mono">{s.score ?? '--'}</span>
              {canReset && (
                <button className="btn btn-xs" onClick={() => setResetTarget(s)} title="清空基线样本，重新进入学习期">重置基线</button>
              )}
            </span>
          </div>
          <div className={`health-bar health-bar--${s.status}`}>
            <i style={{ width: `${s.score ?? 0}%` }} />
          </div>
        </div>
      ))}

      {active && points.length > 0 && (
        <div className="health-detail">
          <div className="section-sub">测点明细 · {active.name}</div>
          {points.map((p) => (
            <div key={`${p.subsystem}/${p.point}`} className="health-point">
              <div className="panel-head health-item-head">
                <span>
                  {p.name}
                  <span className="text-dim health-point-key">{p.point}</span>
                </span>
                <span className="mono">
                  {p.status === 'learning'
                    ? `学习中 ${p.sample_count}/${report?.min_samples ?? '?'}`
                    : `${fmt(p.current)}${p.unit ? ` ${p.unit}` : ''}`}
                </span>
              </div>
              {p.status === 'learning' ? (
                <div className="health-bar">
                  <i style={{ width: `${Math.min(100, (p.sample_count / (report?.min_samples || 1)) * 100)}%` }} />
                </div>
              ) : (
                <>
                  <DeviationBar zScore={p.z_score} status={p.status} />
                  <div className="health-point-meta mono">
                    基线 {fmt(p.baseline_mean)}±{fmt(p.baseline_std)} · z={fmt(p.z_score)}
                    {p.violation_cycles > 0 && ` · 连续越限 ${p.violation_cycles} 周期`}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        onConfirm={() => {
          if (resetTarget) void reset(resetTarget)
          setResetTarget(null)
        }}
        title="重置健康基线"
        danger
        confirmLabel="确认重置"
        message={`确认重置「${resetTarget?.name ?? ''}」的健康基线？重置后该子系统将重新进入学习期，学习期内不产生越限告警。`}
      />
    </div>
  )
}

/** 数字孪生分区（原 TwinPage 内容） */
function TwinSection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const { frame } = useTelemetry()
  const [twin, setTwin] = useState<Record<string, any> | null>(null)
  const [layer, setLayer] = useState('streamline')

  async function refresh() {
    setTwin(await api.twin())
  }

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    const t = window.setInterval(() => refresh().catch(() => {}), 3000)
    return () => window.clearInterval(t)
  }, [])

  const live = twin?.live || {}
  const cameras = (twin?.cameras || []) as { id: string; name: string; type: string; online: boolean; temp_max: number | null }[]
  const wind = frame?.overview.wind_speed ?? live.wind_speed ?? 0

  return (
    <div className="layout-2">
      <div className="panel">
        <div className="panel-head">
          <h2>场景 · {String(twin?.phase || '加载中')}</h2>
          <div className="actions actions-flush">
            <button
              type="button"
              className="icon-btn"
              onClick={() => window.open(`${window.location.origin}/insight?popout=1&tab=twin`, 'wtcs_twin', 'popup=yes,width=1280,height=860')}
              title="新窗口打开，可拖到其他屏幕"
            >
              <IconFullscreen size={16} />
            </button>
            <button type="button" className="icon-btn" onClick={refresh} title="刷新">
              <IconRefresh size={16} />
            </button>
          </div>
        </div>
        <Tabs
          tabs={((twin?.cfd_layers || [{ id: 'streamline', name: '流线' }]) as { id: string; name: string; ready?: boolean }[]).map((l) => ({
            key: l.id,
            label: l.name,
            disabled: l.ready === false,
            suffix: l.ready === false ? '（预留）' : undefined,
          }))}
          value={layer}
          onChange={setLayer}
          param="layer"
          ariaLabel="CFD 图层"
        />
        <div className="scene scene--tall">
          <svg className="scene-svg scene-svg--tall" viewBox="0 0 900 420">
            <defs>
              <linearGradient id="twinGlow" x1="0" x2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.1" />
              </linearGradient>
            </defs>
            <rect x="60" y="120" width="780" height="180" rx="40" fill="url(#twinGlow)" stroke="var(--line)" />
            <ellipse cx="160" cy="210" rx="48" ry="48" fill="var(--bg-0)" stroke="var(--accent-2)" strokeWidth="3" />
            <text x="160" y="215" textAnchor="middle" fill="var(--text)" fontSize="14">主风机</text>
            <rect x="380" y="150" width="160" height="120" rx="12" fill="var(--bg-0)" stroke="var(--accent)" strokeWidth="2" />
            <text x="460" y="200" textAnchor="middle" fill="var(--text)" fontSize="14">试验段 1:1</text>
            <text x="460" y="222" textAnchor="middle" fill="var(--muted)" fontSize="12">{Number(wind).toFixed(1)} m/s · yaw {Number(live.yaw || 0).toFixed(1)}°</text>
            <rect x="620" y="175" width="120" height="70" rx="10" fill="var(--bg-0)" stroke="var(--warn)" />
            <text x="680" y="205" textAnchor="middle" fill="var(--text)" fontSize="13">RRS/天平</text>
            <text x="680" y="225" textAnchor="middle" fill="var(--muted)" fontSize="11">Fx {Number(live.fx || 0).toFixed(0)}</text>
            {layer === 'streamline' && (
              /* 流线粗细/透明度随风速数据驱动，无装饰性动画 */
              <path
                d="M220 210 C 300 140, 360 280, 460 210 S 580 140, 700 210"
                fill="none"
                stroke="var(--chart-stroke)"
                strokeWidth={1.5 + Math.min(6, Number(wind) / 15)}
                opacity={Number(wind) > 0.5 ? 0.85 : 0.25}
              />
            )}
            {layer === 'section' && (
              <g stroke="var(--accent-2)" fill="none" opacity="0.8">
                <line x1="420" y1="150" x2="420" y2="270" />
                <line x1="460" y1="150" x2="460" y2="270" />
                <line x1="500" y1="150" x2="500" y2="270" />
              </g>
            )}
            <circle
              cx={460 + Number(live.traverse?.x || 0) / 20}
              cy={210 - Number(live.traverse?.z || 0) / 20}
              r="6"
              fill="var(--warn)"
            />
          </svg>
          <div className="scene-overlay">
            <span className="badge ok">{twin?.collision?.ok ? '无干涉' : '存在干涉'}</span>
            <span className="badge info">抽吸 {Number(live.suction_flow || 0).toFixed(3)}</span>
            <span className="badge">移测架 X/Y/Z {Number(live.traverse?.x || 0).toFixed(0)}/{Number(live.traverse?.y || 0).toFixed(0)}/{Number(live.traverse?.z || 0).toFixed(0)}</span>
          </div>
        </div>
      </div>

      <div>
        <HealthPanel toast={toast} />
        <div className="panel">
          <h2>摄像监视</h2>
          <div className="cam-grid">
            {cameras.map((c) => (
              <div className="cam-card" key={c.id}>
                <div className="preview">
                  <span className="preview-note">相机 SDK 接入后启用</span>
                </div>
                <div className="cam-card-name">{c.name}</div>
                <div className="meta cam-card-meta">
                  {c.type} · {c.online ? '在线' : '离线'}
                  {c.temp_max != null ? ` · 最高 ${c.temp_max}℃` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================= AI 巡检与问答（原 AiPage 内容） ================= */

const SEVERITY_CN: Record<AlertSeverity, string> = {
  critical: '严重',
  alarm: '报警',
  warning: '预警',
  info: '提示',
}

function severityClass(s: string) {
  if (s === 'critical' || s === 'alarm') return 'danger'
  if (s === 'warning') return 'warn'
  return 'info'
}

/** 问法提示：覆盖 当前值 / 统计 / 比较 / 状态 四类 */
const EXAMPLE_QUESTIONS = [
  '当前风速多少',
  '最近10分钟平均风速',
  '今天声压级最小值',
  '供水温度和回水温度哪个高',
  '天平正常吗',
  '现在有没有报警',
  '当前安全状态怎么样',
  '有故障吗',
  '有哪些子系统',
  '生成本次实验报告',
]

function AiSection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  const [fSeverity, setFSeverity] = useState('')
  const [fActive, setFActive] = useState('')
  const [fAcked, setFAcked] = useState('')
  const [ackAllOpen, setAckAllOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [chat, setChat] = useState<{ role: 'user' | 'ai'; text: string; error?: boolean; sources?: AskSource[] }[]>([])
  const [asking, setAsking] = useState(false)
  const [openSource, setOpenSource] = useState<string | null>(null)
  const canOperate = hasMinRole('操作员')

  async function refresh() {
    setAlerts(
      await api.aiAlerts({
        severity: (fSeverity || undefined) as AlertSeverity | undefined,
        active: fActive === '' ? undefined : fActive === '1',
        acked: fAcked === '' ? undefined : fAcked === '1',
        limit: 100,
      }),
    )
  }

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
  }, [fSeverity, fActive, fAcked])

  async function inspect() {
    try {
      const r = await api.aiInspect()
      toast(`巡检完成，发现 ${r.count} 条`)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '巡检失败', false)
    }
  }

  async function ack(id: string) {
    try {
      await api.aiAck(id)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '确认失败', false)
    }
  }

  async function ackAll() {
    try {
      const r = await api.aiAckAll()
      toast(`已确认全部未确认告警（${r.count} 条）`)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '一键确认失败', false)
    }
  }

  async function ask(q?: string) {
    const text = (q ?? question).trim()
    if (!text || asking) return
    setQuestion('')
    setChat((c) => [...c, { role: 'user', text }])
    setAsking(true)
    try {
      const r = await api.aiAsk(text)
      setChat((c) => [...c, { role: 'ai', text: r.answer, sources: r.sources }])
    } catch (e) {
      setChat((c) => [...c, { role: 'ai', text: `查询失败：${e instanceof Error ? e.message : '未知错误'}`, error: true }])
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="layout-2">
      <div className="panel">
        <div className="panel-head">
          <h2>AI 智能巡检</h2>
          {canOperate && (
            <button type="button" className="icon-btn" onClick={inspect} title="立即触发一次全量巡检">
              <IconHealth size={16} />
            </button>
          )}
        </div>
        <p className="panel-desc">
          建设期基于阈值与说明书规则引擎主动告警；后期可替换为内网大模型，保持只读边界。
        </p>
        <div className="actions actions-flush actions-mb">
          <select className="field field-auto" value={fSeverity} onChange={(e) => setFSeverity(e.target.value)}>
            <option value="">全部级别</option>
            <option value="critical">严重</option>
            <option value="alarm">报警</option>
            <option value="warning">预警</option>
            <option value="info">提示</option>
          </select>
          <select className="field field-auto" value={fActive} onChange={(e) => setFActive(e.target.value)}>
            <option value="">活动状态</option>
            <option value="1">活动中</option>
            <option value="0">已恢复</option>
          </select>
          <select className="field field-auto" value={fAcked} onChange={(e) => setFAcked(e.target.value)}>
            <option value="">确认状态</option>
            <option value="0">未确认</option>
            <option value="1">已确认</option>
          </select>
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新告警列表">
            <IconRefresh size={16} />
          </button>
          {canOperate && alerts.some((a) => !a.acked) && (
            <button
              type="button"
              className="btn primary"
              onClick={() => setAckAllOpen(true)}
              title="确认全部未确认告警（含未在当前筛选中显示的）"
            >
              全部确认
            </button>
          )}
        </div>
        {!alerts.length && <div className="empty">暂无符合条件的告警</div>}
        {alerts.map((a) => (
          <div
            key={a.id}
            className={a.acked ? 'alert-item acked' : 'alert-item'}
          >
            <div className="panel-head panel-head-tight">
              <span className="badge-row badge-row-flush">
                <span className={`badge ${severityClass(a.severity || a.level)}`}>
                  {SEVERITY_CN[(a.severity || a.level) as AlertSeverity] ?? a.severity ?? a.level}
                </span>
                <span className="badge">{a.subsystem_name}</span>
                {!a.active && <span className="badge">已恢复</span>}
                {a.count > 1 && <span className="badge warn">×{a.count}</span>}
              </span>
              {canOperate && !a.acked && (
                <button className="btn" onClick={() => ack(a.id)}>确认</button>
              )}
              {a.acked && <span className="badge ok">已确认{a.acked_by ? ` · ${a.acked_by}` : ''}</span>}
            </div>
            <div>{a.message}</div>
            <div className="mono alert-ts">
              {a.ts.replace('T', ' ').slice(0, 19)}
            </div>
          </div>
        ))}
        <ConfirmModal
          open={ackAllOpen}
          onClose={() => setAckAllOpen(false)}
          onConfirm={() => {
            void ackAll()
            setAckAllOpen(false)
          }}
          title="一键确认告警"
          confirmLabel="全部确认"
          message={`确认全部 ${alerts.filter((a) => !a.acked).length} 条未确认告警？将同时确认未在当前筛选中显示的其他未确认告警，操作人记录为当前登录用户。`}
        />
      </div>

      <div className="panel">
        <h2>自然语言查询（只读）</h2>
        <div className="chat-box">
          {!chat.length && !asking && <div className="empty">点击下方示例或直接输入问题开始查询</div>}
          {chat.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role === 'user' ? 'user' : ''} ${m.error ? 'chat-msg--error' : ''}`}>
              <div className="who">{m.role === 'user' ? '我' : 'WTCS 助手'}</div>
              {m.text}
              {m.sources && m.sources.length > 0 && (
                <div className="hint hint-tight">
                  数据来源（点击查看详情，数据来源可追溯）：
                  {m.sources.map((s, j) => {
                    const key = `${i}-${j}`
                    const open = openSource === key
                    return (
                      <span key={j} className="src-item">
                        <button
                          className={`badge info badge-inline link-btn${open ? ' active' : ''}`}
                          onClick={() => setOpenSource(open ? null : key)}
                        >
                          {s.subsystem_name}/{s.point_name} · {s.sample_count}点
                        </button>
                        {open && (
                          <span className="src-detail mono">
                            测点：{s.point_name}（{s.point}） · 子系统：{s.subsystem_name} · 时间窗：{s.time_range} · 样本数：{s.sample_count}
                          </span>
                        )}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
          {asking && (
            <div className="chat-msg">
              <div className="who">WTCS 助手</div>
              正在分析…
            </div>
          )}
        </div>
        <div className="ask-chips">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} className="chip" onClick={() => ask(q)} disabled={asking}>{q}</button>
          ))}
        </div>
        <div className="actions">
          <input className="field field-grow" value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="输入问题，如：当前风速多少"
            onKeyDown={(e) => e.key === 'Enter' && ask()} />
          <button className="btn primary" onClick={() => ask()} disabled={asking || !question.trim()}>
            <IconSearch size={14} /> {asking ? '查询中…' : '提问'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ================= 智能洞察 ================= */

export function InsightPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [tab, setTab] = useState('twin')

  return (
    <div>
      <header className="page-head">
        <h1>智能洞察</h1>
      </header>
      <Tabs
        tabs={[
          { key: 'twin', label: '数字孪生与健康基线' },
          { key: 'ai', label: 'AI 巡检与问答' },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel="智能洞察分段"
      />
      {tab === 'twin' && <TwinSection toast={toast} />}
      {tab === 'ai' && <AiSection toast={toast} />}
    </div>
  )
}
