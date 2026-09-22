import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, hasMinRole, type AiAlert } from '../api'
import { ConfirmModal, Modal } from './Modal'

const SEV_BADGE: Record<string, string> = { critical: 'danger', alarm: 'danger', warning: 'warn', info: 'info' }
const SEV_CN: Record<string, string> = { critical: '严重', alarm: '报警', warning: '预警', info: '提示' }

/**
 * 告警弹层：点击顶部报警横幅就地打开（不跳转页面，工作上下文不丢失）。
 * 单条确认 + 一键全部确认；需要深入分析时再从底部链接进入告警中心页。
 */
export function AlertCenterModal({
  open,
  onClose,
  toast,
}: {
  open: boolean
  onClose: () => void
  toast: (msg: string, ok?: boolean) => void
}) {
  const [alerts, setAlerts] = useState<AiAlert[]>([])
  const [loading, setLoading] = useState(false)
  const [ackAllOpen, setAckAllOpen] = useState(false)
  const canOperate = hasMinRole('操作员')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setAlerts(await api.aiAlerts({ acked: false, limit: 200 }))
    } catch (e) {
      toast(e instanceof Error ? e.message : '告警加载失败', false)
    } finally {
      setLoading(false)
    }
  }, [toast])

  // 打开时加载；打开期间 5s 轮询，新告警实时进入清单
  useEffect(() => {
    if (!open) return
    refresh()
    const t = window.setInterval(refresh, 5000)
    return () => window.clearInterval(t)
  }, [open, refresh])

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
      toast(`已确认全部未确认报警（${r.count} 条）`)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '一键确认失败', false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`未确认报警（${alerts.length}）`}
      size="lg"
      footer={
        <>
          <Link to="/insight?tab=ai" className="btn" onClick={onClose}>
            打开告警中心
          </Link>
          {canOperate && (
            <button type="button" className="btn primary" disabled={!alerts.length} onClick={() => setAckAllOpen(true)}>
              全部确认
            </button>
          )}
        </>
      }
    >
      {loading && !alerts.length && <div className="empty">加载中…</div>}
      {!loading && !alerts.length && <div className="empty">暂无未确认报警，系统运行正常</div>}
      {alerts.map((a) => {
        const sev = a.severity || a.level
        return (
          <div key={a.id} className="alert-item">
            <div className="panel-head panel-head-tight">
              <span className="badge-row badge-row-flush">
                <span className={`badge ${SEV_BADGE[sev] ?? 'info'}`}>{SEV_CN[sev] ?? sev}</span>
                <span className="badge">{a.subsystem_name}</span>
                {!a.active && <span className="badge">已恢复</span>}
                {a.count > 1 && <span className="badge warn">×{a.count}</span>}
              </span>
              {canOperate && (
                <button className="btn" onClick={() => ack(a.id)}>确认</button>
              )}
            </div>
            <div>{a.message}</div>
            <div className="mono alert-ts">{a.ts.replace('T', ' ').slice(0, 19)}</div>
          </div>
        )
      })}
      <ConfirmModal
        open={ackAllOpen}
        onClose={() => setAckAllOpen(false)}
        onConfirm={() => {
          void ackAll()
          setAckAllOpen(false)
        }}
        title="一键确认报警"
        confirmLabel="全部确认"
        message={`确认全部 ${alerts.length} 条未确认报警？操作人记录为当前登录用户。`}
      />
    </Modal>
  )
}
