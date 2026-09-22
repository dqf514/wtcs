import { useCallback, useEffect, useState } from 'react'
import { api, getToken, type Feedback, type FeedbackStatus } from '../api'
import { Modal, ConfirmModal } from './Modal'
import { IconEye, IconRefresh, IconTrash } from './icons'

const STATUS_FILTERS: (FeedbackStatus | '')[] = ['', '未处理', '处理中', '已处理']
const STATUS_TONE: Record<FeedbackStatus, string> = {
  未处理: 'danger',
  处理中: 'warn',
  已处理: 'ok',
}
/** 状态流转：点一下进一格，便于在列表里快速处理 */
const NEXT_STATUS: Record<FeedbackStatus, FeedbackStatus> = {
  未处理: '处理中',
  处理中: '已处理',
  已处理: '未处理',
}

/** 截图缩略图：接口要 Bearer，<img> 直链行不通，fetch 成 blob URL */
function FeedbackShot({ id, big }: { id: string; big?: boolean }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let alive = true
    let obj = ''
    const token = getToken()
    fetch(api.feedbackScreenshotUrl(id), {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!alive) return
        obj = URL.createObjectURL(b)
        setUrl(obj)
      })
      .catch(() => {})
    return () => {
      alive = false
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [id])
  if (!url) return <span className="muted">加载中…</span>
  return <img className={big ? undefined : 'feedback-thumb'} src={url} alt="反馈截图" style={big ? { maxWidth: '100%' } : undefined} />
}

/** 用户反馈管理（仅管理员）：列表 + 详情 + 状态流转 + 删除 */
export function FeedbackPanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [list, setList] = useState<Feedback[]>([])
  const [filter, setFilter] = useState<FeedbackStatus | ''>('')
  const [detail, setDetail] = useState<Feedback | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Feedback | null>(null)
  // 手动刷新计数器：effect 依赖它重新拉取（避免在 effect 里同步 setState）
  const [reload, setReload] = useState(0)
  const refresh = useCallback(() => setReload((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    api
      .listFeedbacks(filter || undefined)
      .then((rows) => {
        if (alive) setList(rows)
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), false))
    return () => {
      alive = false
    }
  }, [filter, reload, toast])

  async function advance(f: Feedback) {
    try {
      await api.updateFeedback(f.id, NEXT_STATUS[f.status])
      toast(`已标记为「${NEXT_STATUS[f.status]}」`)
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', false)
    }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try {
      await api.deleteFeedback(deleteTarget.id)
      toast('反馈已删除')
      setDeleteTarget(null)
      setDetail(null)
      refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', false)
    }
  }

  const pendingCount = list.filter((f) => f.status === '未处理').length

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>用户反馈{pendingCount > 0 ? ` · ${pendingCount} 条未处理` : ''}</h2>
        <div className="page-head-side">
          <select value={filter} onChange={(e) => setFilter(e.target.value as FeedbackStatus | '')} aria-label="按状态过滤">
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s || '全部状态'}</option>
            ))}
          </select>
          <button type="button" className="icon-btn" onClick={refresh} title="刷新">
            <IconRefresh size={18} />
          </button>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>内容</th>
            <th>页面</th>
            <th>截图</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.created_at.replace('T', ' ').slice(0, 19)}</td>
              <td>
                <span className="badge info">{f.username}</span>{' '}
                <span className="muted">{f.role}</span>
              </td>
              <td className="feedback-content-cell">{f.content.length > 60 ? `${f.content.slice(0, 60)}…` : f.content}</td>
              <td className="mono muted">{f.page_url || '—'}</td>
              <td>{f.has_screenshot ? <FeedbackShot id={f.id} /> : <span className="muted">—</span>}</td>
              <td>
                <button
                  type="button"
                  className={`badge ${STATUS_TONE[f.status]}`}
                  style={{ cursor: 'pointer', border: 'none' }}
                  title="点击推进状态"
                  onClick={() => advance(f)}
                >
                  {f.status}
                </button>
              </td>
              <td>
                <div className="actions" style={{ marginTop: 0 }}>
                  <button type="button" className="icon-btn" onClick={() => setDetail(f)} title="查看详情">
                    <IconEye size={16} />
                  </button>
                  <button type="button" className="icon-btn danger" onClick={() => setDeleteTarget(f)} title="删除">
                    <IconTrash size={16} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <div className="empty">暂无反馈</div>}

      {/* 详情弹窗：全文 + 大图 + 提交人信息 */}
      <Modal open={!!detail} onClose={() => setDetail(null)} size="lg" title={`反馈详情 · ${detail?.username ?? ''}`}>
        {detail && (
          <>
            <div className="badge-row">
              <span className={`badge ${STATUS_TONE[detail.status]}`}>{detail.status}</span>
              <span className="badge info">{detail.username} · {detail.role}</span>
              <span className="badge mono">{detail.created_at.replace('T', ' ').slice(0, 19)}</span>
              {detail.email && <span className="badge">{detail.email}</span>}
            </div>
            <div className="form-row form-row--top">
              <label>内容</label>
              <span className="feedback-content-cell">{detail.content}</span>
            </div>
            <div className="form-row">
              <label>提交页面</label>
              <span className="mono">{detail.page_url || '—'}</span>
            </div>
            {!!detail.has_screenshot && (
              <div className="form-row form-row--top">
                <label>截图</label>
                <FeedbackShot id={detail.id} big />
              </div>
            )}
            <div className="actions actions-end">
              <button className="btn" onClick={() => advance(detail)}>
                标记为「{NEXT_STATUS[detail.status]}」
              </button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        title="删除反馈"
        message={`确定删除 ${deleteTarget?.username ?? ''} 的这条反馈吗？截图将一并删除，不可恢复。`}
        confirmLabel="删除"
        danger
      />
    </div>
  )
}
