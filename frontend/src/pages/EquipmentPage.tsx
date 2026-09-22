import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  hasMinRole,
  type AiAlert,
  type EquipmentItem,
  type MaintenanceLog,
} from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { Modal } from '../components/Modal'
import { IconEye, IconPlus, IconRefresh } from '../components/icons'

const MAINTENANCE_TYPES = ['保养', '维修', '巡检', '校准']

const SEV_BADGE: Record<string, string> = { critical: 'danger', alarm: 'danger', warning: 'warn', info: 'info' }
const SEV_CN: Record<string, string> = { critical: '严重', alarm: '报警', warning: '预警', info: '提示' }

function fmtMinutes(min: number): string {
  if (min >= 60) return `${(min / 60).toFixed(1)} h`
  return `${min.toFixed(1)} min`
}

function fmtTime(ts: string | null | undefined): string {
  return ts ? ts.replace('T', ' ').slice(0, 19) : '—'
}

/** 台账状态徽标：故障 > 运行 > 就绪 > 其他连接态 */
function StateBadge({ item }: { item: EquipmentItem }) {
  if (item.fault) return <span className="badge danger">故障</span>
  if (item.running) return <span className="badge ok">运行中</span>
  if (item.ready) return <span className="badge">就绪</span>
  return <span className="badge warn">{item.state}</span>
}

/** 设备台账（一机一档）：12 子系统状态/时长/告警/维护一览 + 单机详情弹窗 */
export function EquipmentPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canMaintain = hasMinRole('维护员')
  const { frame } = useTelemetry()
  const [list, setList] = useState<EquipmentItem[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const [logs, setLogs] = useState<MaintenanceLog[]>([])
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  // 新增维护记录表单
  const [maintOpen, setMaintOpen] = useState(false)
  const [mType, setMType] = useState('保养')
  const [mContent, setMContent] = useState('')

  const refresh = useCallback(async () => {
    setList(await api.equipment())
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    const t = window.setInterval(() => refresh().catch(() => {}), 10000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 详情弹窗：维护记录 + 该子系统告警履历（含已确认，最近 10 条）
  useEffect(() => {
    if (!detailId) return
    let stop = false
    Promise.all([api.maintenanceLogs(detailId), api.aiAlerts({ limit: 500 })])
      .then(([ml, al]) => {
        if (stop) return
        setLogs(ml)
        setAlerts(al.filter((a) => a.subsystem_id === detailId).slice(0, 10))
      })
      .catch((e) => toast(String(e), false))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId])

  const detail = list.find((x) => x.subsystem_id === detailId) ?? null
  const live = useMemo(
    () => frame?.subsystems.find((s) => s.id === detailId) ?? null,
    [frame, detailId],
  )

  async function submitMaintenance() {
    if (!detailId) return
    if (!mContent.trim()) {
      toast('维护内容不能为空', false)
      return
    }
    try {
      await api.addMaintenance(detailId, { type: mType, content: mContent.trim() })
      toast('维护记录已保存')
      setMaintOpen(false)
      setMContent('')
      setLogs(await api.maintenanceLogs(detailId))
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', false)
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>设备台账</h1>
        <div className="page-head-side">
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新台账">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2>一机一档 · 12 个子系统</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>设备名称</th>
              <th>状态</th>
              <th>今日运行</th>
              <th>累计运行</th>
              <th>未确认告警</th>
              <th>最近维护</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.subsystem_id} className={detailId === x.subsystem_id ? 'row-active' : undefined}>
                <td>
                  <a className="link-btn" onClick={() => setDetailId(x.subsystem_id)}>{x.name}</a>
                  <span className="mono text-dim cell-note"> {x.subsystem_id}</span>
                </td>
                <td><StateBadge item={x} /></td>
                <td className="mono">{fmtMinutes(x.today_minutes)}</td>
                <td className="mono">{fmtMinutes(x.total_minutes)}</td>
                <td>
                  {x.unacked_alerts > 0
                    ? <span className="badge warn">{x.unacked_alerts}</span>
                    : <span className="mono">0</span>}
                </td>
                <td className="mono">{fmtTime(x.last_maintenance_at)}</td>
                <td>
                  <button
                    type="button"
                    className={`icon-btn ${detailId === x.subsystem_id ? 'active' : ''}`}
                    onClick={() => setDetailId(x.subsystem_id)}
                    title="打开单机档案"
                  >
                    <IconEye size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">台账加载中…</div>}
      </div>

      {/* 单机档案：实时状态 + 维护记录 + 告警履历 */}
      <Modal
        open={!!detailId}
        onClose={() => setDetailId(null)}
        size="lg"
        title={detail ? `单机档案 · ${detail.name}` : '单机档案'}
      >
        {detail && (
          <>
            <div className="badge-row">
              <StateBadge item={detail} />
              <span className="badge info">{detail.mode === 'simulation' ? '仿真' : '真机'}</span>
              <span className="badge">连接：{live?.state ?? detail.state}</span>
              <span className="badge mono">今日 {fmtMinutes(detail.today_minutes)}</span>
              <span className="badge mono">累计 {fmtMinutes(detail.total_minutes)}</span>
            </div>
            {live && (
              <div className="badge-row">
                {live.points.filter((p) => typeof p.value === 'number').slice(0, 6).map((p) => (
                  <span key={p.key} className="badge">
                    {p.label} <span className="mono">{Number(p.value).toFixed(1)}{p.unit ? ` ${p.unit}` : ''}</span>
                  </span>
                ))}
              </div>
            )}

            <div className="panel-head">
              <h2 className="section-sub">维护记录</h2>
              {canMaintain && (
                <button type="button" className="icon-btn" onClick={() => setMaintOpen(true)} title="新增维护记录">
                  <IconPlus size={16} />
                </button>
              )}
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>内容</th>
                    <th>操作人</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">{fmtTime(m.created_at)}</td>
                      <td><span className="badge info">{m.type}</span></td>
                      <td>{m.content}</td>
                      <td>{m.operator}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!logs.length && <div className="empty">暂无维护记录{canMaintain ? '，点击右上角「+」新增' : ''}</div>}

            <h2 className="section-sub">告警履历（最近 10 条，含已确认）</h2>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>级别</th>
                    <th>内容</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{fmtTime(a.ts)}</td>
                      <td><span className={`badge ${SEV_BADGE[a.severity] ?? ''}`}>{SEV_CN[a.severity] ?? a.severity}</span></td>
                      <td>{a.message}</td>
                      <td>{a.acked ? <span className="badge">已确认</span> : <span className="badge warn">未确认</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!alerts.length && <div className="empty">该子系统暂无告警记录</div>}
          </>
        )}
      </Modal>

      {/* 新增维护记录 */}
      <Modal
        open={maintOpen}
        onClose={() => setMaintOpen(false)}
        size="sm"
        title="新增维护记录"
        footer={
          <>
            <button className="btn" onClick={() => setMaintOpen(false)}>取消</button>
            <button className="btn primary" onClick={submitMaintenance}>保存</button>
          </>
        }
      >
        <div className="form-row">
          <label>类型</label>
          <select value={mType} onChange={(e) => setMType(e.target.value)}>
            {MAINTENANCE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>内容</label>
          <textarea
            rows={4}
            autoFocus
            value={mContent}
            onChange={(e) => setMContent(e.target.value)}
            placeholder="维护/巡检/校准内容与结论"
          />
        </div>
      </Modal>
    </>
  )
}
