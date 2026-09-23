import { useCallback, useEffect, useState } from 'react'
import { api, type CommandOrder } from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { Modal } from '../components/Modal'
import { SUBSYSTEM_DEFS } from '../subsystems'

const STATUS_META: Record<CommandOrder['status'], { label: string; tone: string }> = {
  accepted: { label: '进行中', tone: 'info' },
  acked: { label: '已回执', tone: 'ok' },
  rejected: { label: '已拒绝', tone: 'warn' },
  failed: { label: '失败', tone: 'danger' },
  timeout: { label: '超时', tone: 'danger' },
}

const SUB_NAME: Record<string, string> = Object.fromEntries(SUBSYSTEM_DEFS.map((d) => [d.id, d.label]))

type Filters = {
  subsystem: string
  status: string
  operator: string
  since: string
  until: string
}

const EMPTY_FILTERS: Filters = { subsystem: '', status: '', operator: '', since: '', until: '' }

/** datetime-local（分钟精度）补秒，保证与库内 ISO 秒的字符串比较语义正确 */
function toIso(v: string, end: boolean): string | undefined {
  if (!v) return undefined
  return v.length === 16 ? `${v}:${end ? '59' : '00'}` : v
}

function fmtParams(params: Record<string, unknown>): string {
  const s = JSON.stringify(params)
  return s === '{}' ? '—' : s
}

/** 命令追踪：指令全生命周期——进行中队列（遥测实时）+ 历史查询（过滤 + 详情）。 */
export function CommandsPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const { frame } = useTelemetry()
  const [active, setActive] = useState<CommandOrder[]>([])
  const [history, setHistory] = useState<CommandOrder[]>([])
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [detail, setDetail] = useState<CommandOrder | null>(null)

  const refreshActive = useCallback(async () => {
    setActive(await api.commandsActive())
  }, [])

  const query = useCallback(
    async (f: Filters) => {
      setHistory(
        await api.commandHistory({
          subsystem: f.subsystem || undefined,
          status: f.status || undefined,
          operator: f.operator || undefined,
          since: toIso(f.since, false),
          until: toIso(f.until, true),
          limit: 300,
        }),
      )
    },
    [],
  )

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 挂载时拉取进行中队列与历史（与全站页面同一模式）
    refreshActive().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
    query(EMPTY_FILTERS).catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [refreshActive, query, toast])

  // 进行中队列以遥测帧为准（WS 10Hz）；帧未到时用首次拉取的库内清单
  const liveActive = frame?.commands_active ?? null

  async function onQuery() {
    try {
      await query(filters)
    } catch (err) {
      toast(err instanceof Error ? err.message : '查询失败', false)
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>
          命令追踪
          {active.length > 0 && <span className="badge info" style={{ marginLeft: 8 }}>{active.length} 条进行中</span>}
        </h1>
        <div className="page-head-side">
          <button type="button" className="btn" onClick={() => { void refreshActive(); void onQuery() }}>
            刷新
          </button>
        </div>
      </header>

      <div className="panel panel-mb">
        <div className="panel-head">
          <h2>进行中队列</h2>
          <span className="muted">已建单未回执；仿真同步回执通常为空，真机挂起时在此滞留并触发超时告警</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>命令单号</th>
              <th>子系统</th>
              <th>指令</th>
              <th>操作者</th>
              <th>建单时间</th>
              <th>已等待</th>
            </tr>
          </thead>
          <tbody>
            {liveActive
              ? liveActive.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.id}</td>
                    <td>{SUB_NAME[o.subsystem] ?? o.subsystem}</td>
                    <td className="mono">{o.command}</td>
                    <td>{o.operator}</td>
                    <td className="mono">{o.created_at.replace('T', ' ')}</td>
                    <td>{o.elapsed_s.toFixed(1)} s</td>
                  </tr>
                ))
              : active.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.id}</td>
                    <td>{SUB_NAME[o.subsystem] ?? o.subsystem}</td>
                    <td className="mono">{o.command}</td>
                    <td>{o.operator}</td>
                    <td className="mono">{o.created_at.replace('T', ' ')}</td>
                    <td>—</td>
                  </tr>
                ))}
            {(liveActive ?? active).length === 0 && (
              <tr>
                <td colSpan={6} className="muted">无进行中命令</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>历史查询</h2>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <select
            className="field"
            style={{ width: 170 }}
            value={filters.subsystem}
            onChange={(e) => setFilters({ ...filters, subsystem: e.target.value })}
          >
            <option value="">全部子系统</option>
            {SUBSYSTEM_DEFS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
          <select
            className="field"
            style={{ width: 110 }}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
          <input
            className="field"
            style={{ width: 120 }}
            placeholder="操作者"
            value={filters.operator}
            onChange={(e) => setFilters({ ...filters, operator: e.target.value })}
          />
          <input
            className="field"
            style={{ width: 200 }}
            type="datetime-local"
            title="建单时间下限"
            value={filters.since}
            onChange={(e) => setFilters({ ...filters, since: e.target.value })}
          />
          <input
            className="field"
            style={{ width: 200 }}
            type="datetime-local"
            title="建单时间上限"
            value={filters.until}
            onChange={(e) => setFilters({ ...filters, until: e.target.value })}
          />
          <button type="button" className="btn primary" onClick={() => void onQuery()}>查询</button>
          <button type="button" className="btn" onClick={() => { setFilters(EMPTY_FILTERS); void query(EMPTY_FILTERS).catch(() => undefined) }}>
            重置
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>建单时间</th>
              <th>子系统</th>
              <th>指令</th>
              <th>参数</th>
              <th>操作者</th>
              <th>状态</th>
              <th>耗时</th>
              <th>回执</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.map((o) => {
              const sm = STATUS_META[o.status] ?? { label: o.status, tone: 'dim' }
              return (
                <tr key={o.id}>
                  <td className="mono">{o.created_at.replace('T', ' ')}</td>
                  <td>{SUB_NAME[o.subsystem] ?? o.subsystem}</td>
                  <td className="mono">{o.command}</td>
                  <td className="mono muted">{fmtParams(o.params)}</td>
                  <td>{o.operator}</td>
                  <td><span className={`badge ${sm.tone}`}>{sm.label}</span></td>
                  <td className="mono">{o.duration_ms != null ? `${o.duration_ms} ms` : '—'}</td>
                  <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.receipt}>
                    {o.receipt || '—'}
                  </td>
                  <td>
                    <button type="button" className="btn" onClick={() => setDetail(o)}>详情</button>
                  </td>
                </tr>
              )
            })}
            {history.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">无匹配命令单</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 命令单详情 */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`命令单 ${detail?.id ?? ''}`}>
        {detail && (
          <div>
            <table className="table">
              <tbody>
                <tr><td className="muted">子系统</td><td>{SUB_NAME[detail.subsystem] ?? detail.subsystem}（{detail.subsystem}）</td></tr>
                <tr><td className="muted">指令</td><td className="mono">{detail.command}</td></tr>
                <tr><td className="muted">参数</td><td className="mono">{fmtParams(detail.params)}</td></tr>
                <tr><td className="muted">操作者</td><td>{detail.operator}（{detail.role}）</td></tr>
                <tr><td className="muted">状态</td><td><span className={`badge ${(STATUS_META[detail.status] ?? { tone: 'dim' }).tone}`}>{(STATUS_META[detail.status] ?? { label: detail.status }).label}</span></td></tr>
                <tr><td className="muted">回执</td><td>{detail.receipt || '—'}</td></tr>
                <tr><td className="muted">耗时</td><td className="mono">{detail.duration_ms != null ? `${detail.duration_ms} ms` : '—'}</td></tr>
                <tr><td className="muted">建单时间</td><td className="mono">{detail.created_at.replace('T', ' ')}</td></tr>
                <tr><td className="muted">闭环时间</td><td className="mono">{detail.finished_at ? detail.finished_at.replace('T', ' ') : '—'}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  )
}
