import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type HistoryQueryResult, type OpenPointMeta, type StatsOverview } from '../api'
import { Tabs } from '../components/Tabs'
import { Modal } from '../components/Modal'
import { Chart, type EChartsCoreOption } from '../components/Chart'
import { useChartColors } from '../components/chartColors'
import {
  IconPlus,
  IconRefresh,
  IconExport,
  IconEye,
  IconPrint,
  IconDatabase,
  IconSearch,
} from '../components/icons'

/** 本地时间 → ISO（不带时区，与后端 local_now 一致） */
function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/* ================= 数据查询（宽表历史：测点树 + 时间窗 + 聚合 + 多轴折线 + CSV） ================= */

const MAX_QUERY_POINTS = 6

const TIME_PRESETS = [
  { key: '-15m', label: '近 15 分钟' },
  { key: '-1h', label: '近 1 小时' },
  { key: '-8h', label: '近 8 小时' },
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'custom', label: '自定义' },
] as const

const BUCKETS = [
  { sec: 1, label: '原始 (1s)' },
  { sec: 10, label: '10 秒' },
  { sec: 60, label: '1 分钟' },
  { sec: 600, label: '10 分钟' },
]

const PALETTE = ['#38bdf8', '#fb923c', '#2dd4bf', '#fbbf24', '#a78bfa', '#34d399']

function QuerySection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const colors = useChartColors()
  const [meta, setMeta] = useState<OpenPointMeta[]>([])
  const [metaLoaded, setMetaLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>(['main_fan.wind_speed'])
  const [preset, setPreset] = useState<string>('-15m')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [bucket, setBucket] = useState(10)
  const [agg, setAgg] = useState<'avg' | 'min' | 'max'>('avg')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<HistoryQueryResult | null>(null)

  useEffect(() => {
    api
      .openPoints()
      .then((r) => {
        setMeta(r.points.filter((p) => p.logged))
        setMetaLoaded(true)
      })
      .catch((e) => toast(String(e), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const keyOf = (p: OpenPointMeta) => `${p.subsystem}.${p.point}`

  // 按子系统分组 + 搜索过滤（中文名 / 键 / 别名）
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out: { name: string; points: OpenPointMeta[] }[] = []
    for (const p of meta) {
      if (q) {
        const hay = `${p.subsystem_name} ${p.name} ${p.point} ${(p.aliases as string[] | undefined)?.join(' ') ?? ''}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      const g = out.find((x) => x.name === p.subsystem_name)
      if (g) g.points.push(p)
      else out.push({ name: p.subsystem_name, points: [p] })
    }
    return out
  }, [meta, search])

  const metaByKey = useMemo(() => new Map(meta.map((p) => [keyOf(p), p])), [meta])

  function toggle(key: string) {
    setSelected((sel) => {
      if (sel.includes(key)) return sel.filter((k) => k !== key)
      if (sel.length >= MAX_QUERY_POINTS) {
        toast(`最多同时查询 ${MAX_QUERY_POINTS} 个测点`, false)
        return sel
      }
      return [...sel, key]
    })
  }

  function timeRange(): { from?: string; to?: string } {
    const now = new Date()
    if (preset === 'custom') {
      return { from: customFrom || undefined, to: customTo || undefined }
    }
    if (preset === 'today') {
      const from = new Date(now)
      from.setHours(0, 0, 0, 0)
      return { from: fmtLocal(from) }
    }
    if (preset === 'yesterday') {
      const from = new Date(now)
      from.setDate(from.getDate() - 1)
      from.setHours(0, 0, 0, 0)
      const to = new Date(from)
      to.setHours(23, 59, 59, 0)
      return { from: fmtLocal(from), to: fmtLocal(to) }
    }
    return { from: preset } // 相对时间，如 -15m
  }

  const runQuery = useCallback(async () => {
    if (!selected.length) {
      toast('请先勾选至少一个测点', false)
      return
    }
    if (preset === 'custom' && (!customFrom || !customTo)) {
      toast('自定义时间窗需填写起止时间', false)
      return
    }
    setLoading(true)
    try {
      const r = await api.historyQuery({ points: selected, ...timeRange(), bucket_sec: bucket, agg })
      setResult(r)
      if (!r.raw_rows) toast('该时间窗内无历史数据', false)
    } catch (e) {
      toast(e instanceof Error ? e.message : '查询失败', false)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, preset, customFrom, customTo, bucket, agg])

  // 多轴折线：不同单位自动分配左/右轴（第 3 种单位起右轴依次外移）
  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!result) return null
    const seriesList = result.points.filter((s) => s.points.length)
    if (!seriesList.length) return null
    const units: string[] = []
    for (const s of seriesList) {
      const u = s.unit || '值'
      if (!units.includes(u)) units.push(u)
    }
    const yAxis = units.map((u, i) => ({
      type: 'value' as const,
      name: u,
      scale: true,
      position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
      offset: i > 1 ? (i - 1) * 48 : 0,
      nameTextStyle: { color: colors.muted, fontSize: 11 },
      axisLabel: { color: colors.muted, fontSize: 11 },
      splitLine: { show: i === 0, lineStyle: { color: colors.split } },
    }))
    return {
      animation: false,
      color: PALETTE,
      grid: { left: 60, right: units.length > 1 ? 60 + (units.length - 2) * 48 : 30, top: 34, bottom: 56 },
      legend: { top: 0, textStyle: { color: colors.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.card,
        borderColor: colors.line,
        textStyle: { color: colors.text, fontSize: 12 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : '--'),
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.line } },
      },
      yAxis,
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 6, borderColor: colors.line, textStyle: { color: colors.muted, fontSize: 10 } },
      ],
      series: seriesList.map((s) => ({
        name: s.unit ? `${s.name} (${s.unit})` : s.name,
        type: 'line' as const,
        yAxisIndex: units.indexOf(s.unit || '值'),
        data: s.points,
        showSymbol: false,
        lineStyle: { width: 1.6 },
      })),
    }
  }, [result, colors])

  function exportCsv() {
    if (!result) return
    const esc = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const seriesList = result.points
    // 时间轴并集（升序），各测点按时间查值
    const times = Array.from(new Set(seriesList.flatMap((s) => s.points.map((p) => p[0])))).sort()
    const lookup = seriesList.map((s) => new Map(s.points))
    const lines = [
      ['时间', ...seriesList.map((s) => (s.unit ? `${s.name}(${s.unit})` : s.name))].map(esc).join(','),
      ...times.map((t) =>
        [t.replace('T', ' '), ...lookup.map((m) => m.get(t)?.toFixed(4) ?? '')].map(esc).join(','),
      ),
    ]
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wtcs-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(`已导出 ${times.length} 行 × ${seriesList.length} 测点`)
  }

  return (
    <div className="layout-query">
      <div className="panel">
        <div className="panel-head">
          <h2>测点选择（{selected.length}/{MAX_QUERY_POINTS}）</h2>
        </div>
        <input
          className="field"
          placeholder="搜索测点 / 子系统 / 别名"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="point-tree">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="label-cap point-group-label">{g.name}</div>
              <div className="badge-row-flush">
                {g.points.map((p) => {
                  const key = keyOf(p)
                  const on = selected.includes(key)
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`badge badge-check ${on ? 'on' : ''}`}
                      onClick={() => toggle(key)}
                      title={`${key}${p.unit ? ` · 单位 ${p.unit}` : ''}`}
                    >
                      {p.name}{p.unit ? ` (${p.unit})` : ''}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {metaLoaded && !groups.length && <div className="empty">无匹配测点</div>}
          {!metaLoaded && <div className="empty">测点元数据加载中…</div>}
        </div>

        <h2 className="section-sub section-sub-loose">时间窗</h2>
        <div className="badge-row-flush">
          {TIME_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`badge badge-check ${preset === p.key ? 'on' : ''}`}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="actions">
            <input className="field" type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} title="起始时间" />
            <input className="field" type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} title="截止时间" />
          </div>
        )}

        <h2 className="section-sub section-sub-loose">聚合</h2>
        <div className="actions actions-flush">
          <select className="field field-auto" value={bucket} onChange={(e) => setBucket(Number(e.target.value))} title="聚合粒度">
            {BUCKETS.map((b) => (
              <option key={b.sec} value={b.sec}>{b.label}</option>
            ))}
          </select>
          <select className="field field-auto" value={agg} onChange={(e) => setAgg(e.target.value as 'avg' | 'min' | 'max')} title="桶内聚合方式">
            <option value="avg">平均值</option>
            <option value="min">最小值</option>
            <option value="max">最大值</option>
          </select>
          <button type="button" className="btn primary" disabled={loading || !selected.length} onClick={runQuery} title="执行历史查询">
            <IconSearch size={14} /> {loading ? '查询中…' : '查询'}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>历史曲线</h2>
          <div className="actions actions-flush">
            {result && (
              <span className="badge mono" title="实际生效的聚合桶与原始行数">
                bucket={result.bucket_sec}s · {result.raw_rows} 行
              </span>
            )}
            <button type="button" className="icon-btn" onClick={exportCsv} disabled={!result?.points.some((s) => s.points.length)} title="导出查询结果为 CSV">
              <IconExport size={16} />
            </button>
          </div>
        </div>
        {!result && (
          <div className="empty">
            <IconDatabase size={28} />
            <div>在左侧勾选测点（最多 {MAX_QUERY_POINTS} 个）、选择时间窗后点击「查询」</div>
          </div>
        )}
        {result && !option && <div className="empty">该时间窗内所选测点无数据，可扩大时间窗或减小聚合粒度</div>}
        {option && <Chart option={option} height={420} />}
        {result && (
          <p className="panel-desc hint-tight">
            已选：{result.points.map((s) => metaByKey.get(s.key)?.name ?? s.key).join('、')}
            {' · '}窗口 {result.from.replace('T', ' ')} ~ {result.to.replace('T', ' ')}
          </p>
        )}
      </div>
    </div>
  )
}

/* ================= 统计分析（消费 /api/stats/overview） ================= */

const SEVERITY_CN: Record<string, string> = { info: '提示', warning: '预警', alarm: '报警', critical: '严重' }

function StatsSection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const colors = useChartColors()
  const [days, setDays] = useState(7)
  const [data, setData] = useState<StatsOverview | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (d: number) => {
    setLoading(true)
    try {
      setData(await api.statsOverview(d))
    } catch (e) {
      toast(e instanceof Error ? e.message : '统计加载失败', false)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load(days)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  const baseTooltip = useMemo(
    () => ({
      backgroundColor: colors.card,
      borderColor: colors.line,
      textStyle: { color: colors.text, fontSize: 12 },
    }),
    [colors],
  )

  const pieOption = useMemo<EChartsCoreOption>(() => ({
    animation: false,
    color: PALETTE,
    tooltip: { ...baseTooltip, trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: colors.muted, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    series: [{
      type: 'pie',
      radius: ['42%', '68%'],
      center: ['50%', '44%'],
      label: { color: colors.muted, fontSize: 11 },
      data: (data?.experiments.by_scenario ?? []).map((x) => ({ name: x.name, value: x.count })),
    }],
  }), [data, colors, baseTooltip])

  const alertDayOption = useMemo<EChartsCoreOption>(() => ({
    animation: false,
    tooltip: { ...baseTooltip, trigger: 'axis' },
    grid: { left: 44, right: 16, top: 20, bottom: 28 },
    xAxis: {
      type: 'category',
      data: (data?.alerts.by_day ?? []).map((d) => d.day.slice(5)),
      axisLabel: { color: colors.muted, fontSize: 10 },
      axisLine: { lineStyle: { color: colors.line } },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: colors.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: colors.split } },
    },
    series: [{
      type: 'bar',
      data: (data?.alerts.by_day ?? []).map((d) => d.count),
      itemStyle: { color: colors.warn },
      barMaxWidth: 22,
    }],
  }), [data, colors, baseTooltip])

  const hbar = (items: { name: string; count: number }[], color: string): EChartsCoreOption => ({
    animation: false,
    tooltip: { ...baseTooltip, trigger: 'axis' },
    grid: { left: 8, right: 30, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: colors.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: colors.split } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: items.map((x) => x.name),
      axisLabel: { color: colors.text, fontSize: 11 },
      axisLine: { lineStyle: { color: colors.line } },
    },
    series: [{ type: 'bar', data: items.map((x) => x.count), itemStyle: { color }, barMaxWidth: 16 }],
  })

  return (
    <div>
      <div className="panel panel-mb">
        <div className="panel-head">
          <h2>运行统计汇总</h2>
          <div className="actions actions-flush">
            {[7, 30].map((d) => (
              <button
                key={d}
                type="button"
                className={`badge badge-check ${days === d ? 'on' : ''}`}
                onClick={() => setDays(d)}
              >
                近 {d} 天
              </button>
            ))}
            <button type="button" className="icon-btn" onClick={() => load(days)} title="刷新统计">
              <IconRefresh size={16} />
            </button>
          </div>
        </div>
        <div className="grid-kpi grid-kpi--4">
          <div className="kpi">
            <label>实验总数</label>
            <strong>{data?.experiments.total ?? '--'}</strong>
          </div>
          <div className="kpi">
            <label>采集 run</label>
            <strong>{data?.runs.total ?? '--'}</strong>
            <em>平均 {data?.runs.avg_duration_sec != null ? `${data.runs.avg_duration_sec}s` : '--'}</em>
          </div>
          <div className="kpi">
            <label>矩阵成功率</label>
            <strong>{data?.matrices.success_rate != null ? `${Math.round(data.matrices.success_rate * 100)}%` : '--'}</strong>
            <em>{data ? `${data.matrices.rows_completed}/${data.matrices.rows_total} 工况行` : ''}</em>
          </div>
          <div className="kpi">
            <label>告警总数</label>
            <strong>{data?.alerts.total ?? '--'}</strong>
            <em>
              {data
                ? Object.entries(data.alerts.by_severity).filter(([, n]) => n > 0).map(([k, n]) => `${SEVERITY_CN[k] ?? k}${n}`).join(' ') || '无'
                : ''}
            </em>
          </div>
        </div>
      </div>

      {loading && !data && <div className="empty">统计加载中…</div>}
      {data && (
        <div className="stat-grid">
          <div className="panel">
            <div className="panel-head"><h2>实验按场景分布</h2></div>
            {data.experiments.by_scenario.length ? <Chart option={pieOption} height={240} /> : <div className="empty">窗口内无实验</div>}
          </div>
          <div className="panel">
            <div className="panel-head"><h2>告警按天趋势</h2></div>
            <Chart option={alertDayOption} height={240} />
          </div>
          <div className="panel">
            <div className="panel-head"><h2>告警子系统 Top5</h2></div>
            {data.alerts.by_subsystem.length ? <Chart option={hbar(data.alerts.by_subsystem, colors.danger)} height={240} /> : <div className="empty">窗口内无告警</div>}
          </div>
          <div className="panel">
            <div className="panel-head"><h2>审计操作量 Top</h2></div>
            {data.audit.top_actions.length ? <Chart option={hbar(data.audit.top_actions.map((a) => ({ name: a.action, count: a.count })), colors.accent)} height={240} /> : <div className="empty">窗口内无审计记录</div>}
          </div>
        </div>
      )}
    </div>
  )
}

/* ================= 分析报告（预览 Modal 化） ================= */

function ReportsSection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [list, setList] = useState<{ id: string; title: string; created_at: string; created_by: string; experiment_id?: string }[]>([])
  const [exps, setExps] = useState<{ id: string; title: string }[]>([])
  const [title, setTitle] = useState('风洞实验运行报告')
  const [expId, setExpId] = useState('')
  const [preview, setPreview] = useState<{ id: string; title: string; html: string } | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  async function refresh() {
    setList(await api.reports())
    setExps(await api.experiments())
  }

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    try {
      const r = await api.createReport({ title, experiment_id: expId || null })
      toast('报告已生成')
      await refresh()
      await open(r.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : '生成失败', false)
    }
  }

  async function open(id: string) {
    const r = await api.report(id)
    setPreview({ id: r.id, title: r.title, html: r.html })
  }

  function printReport() {
    const win = frameRef.current?.contentWindow
    if (!win) {
      toast('预览尚未加载完成', false)
      return
    }
    win.focus()
    win.print()
  }

  const expTitle = (id?: string) => exps.find((x) => x.id === id)?.title ?? (id ? id.slice(0, 8) : '—')

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>实验报告</h2>
      </div>
      <div className="report-gen">
        <input className="field field-lg" value={title} onChange={(e) => setTitle(e.target.value)} title="报告标题" />
        <select className="field field-lg" value={expId} onChange={(e) => setExpId(e.target.value)} title="关联实验">
          <option value="">仅运行概览</option>
          {exps.map((x) => (
            <option key={x.id} value={x.id}>{x.title}</option>
          ))}
        </select>
        <button className="btn primary" onClick={create} title="基于当前运行概览（+关联实验 runs）生成 HTML 报告">
          <IconPlus size={14} /> 一键生成
        </button>
      </div>

      <table className="table">
        <thead>
          <tr><th>标题</th><th>关联实验</th><th>时间</th><th>生成者</th><th>操作</th></tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td>
                <button type="button" className="link-btn report-title" onClick={() => open(r.id)} title="打开报告预览">
                  {r.title}
                </button>
              </td>
              <td>{expTitle(r.experiment_id)}</td>
              <td className="mono">{r.created_at.replace('T', ' ').slice(0, 19)}</td>
              <td>{r.created_by || '—'}</td>
              <td>
                <button type="button" className="icon-btn" onClick={() => open(r.id)} title="预览该报告">
                  <IconEye size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <div className="empty">暂无报告，在上方填写标题后「一键生成」；也可在试验中心的实验数据面板直接生成</div>}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        size="lg"
        title={preview?.title ?? '报告预览'}
        footer={
          <button type="button" className="btn" onClick={printReport}>
            <IconPrint size={14} /> 打印
          </button>
        }
      >
        {preview && (
          <iframe ref={frameRef} className="report-frame report-frame--modal" title="report" srcDoc={preview.html} sandbox="allow-same-origin allow-modals" />
        )}
      </Modal>
    </div>
  )
}

/* ================= 审计日志 ================= */

type AuditRow = { id: string; ts: string; user: string; action: string; detail: string }

const PAGE_SIZE = 20

function AuditSection({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [fUser, setFUser] = useState('')
  const [fAction, setFAction] = useState('')
  const [page, setPage] = useState(0)

  async function refresh() {
    setRows(await api.audit(500))
  }

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 筛选条件变化时回到第一页（在事件里复位，不用 effect）
  function onFilterUser(v: string) {
    setFUser(v)
    setPage(0)
  }
  function onFilterAction(v: string) {
    setFAction(v)
    setPage(0)
  }

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!fUser || r.user.includes(fUser)) &&
          (!fAction || r.action.includes(fAction) || r.detail.includes(fAction)),
      ),
    [rows, fUser, fAction],
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function exportCsv() {
    const esc = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const lines = [
      ['时间', '用户', '动作', '详情'].map(esc).join(','),
      ...filtered.map((r) => [r.ts.replace('T', ' ').slice(0, 19), r.user, r.action, r.detail].map(esc).join(',')),
    ]
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wtcs-audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast(`已导出 ${filtered.length} 条审计记录`)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>操作审计日志</h2>
        <div className="actions actions-flush">
          <button type="button" className="icon-btn" onClick={() => refresh().catch((e) => toast(String(e), false))} title="刷新">
            <IconRefresh size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={exportCsv} disabled={!filtered.length} title="导出筛选结果为 CSV">
            <IconExport size={16} />
          </button>
        </div>
      </div>
      <div className="actions actions-flush actions-mb">
        <input className="field field-md" placeholder="按操作者筛选" value={fUser} onChange={(e) => onFilterUser(e.target.value)} />
        <input className="field field-lg" placeholder="按动作 / 详情关键词筛选" value={fAction} onChange={(e) => onFilterAction(e.target.value)} />
        <span className="badge mono">{filtered.length} 条</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>动作</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.ts.replace('T', ' ').slice(0, 19)}</td>
              <td>{r.user}</td>
              <td>{r.action}</td>
              <td>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!pageRows.length && <div className="empty">暂无符合条件的记录，可调整筛选条件或点击「刷新」</div>}
      {pageCount > 1 && (
        <div className="actions actions-center">
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
          <span className="mono text-dim">{page + 1} / {pageCount}</span>
          <button className="btn" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>下一页</button>
        </div>
      )}
    </div>
  )
}

/* ================= 数据中心 ================= */

export function DataPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [tab, setTab] = useState('query')

  return (
    <div>
      <header className="page-head">
        <h1>数据中心</h1>
      </header>
      <Tabs
        tabs={[
          { key: 'query', label: '数据查询' },
          { key: 'stats', label: '统计分析' },
          { key: 'reports', label: '分析报告' },
          { key: 'audit', label: '审计日志' },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel="数据中心分段"
      />
      {tab === 'query' && <QuerySection toast={toast} />}
      {tab === 'stats' && <StatsSection toast={toast} />}
      {tab === 'reports' && <ReportsSection toast={toast} />}
      {tab === 'audit' && <AuditSection toast={toast} />}
    </div>
  )
}
