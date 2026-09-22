import { useCallback, useEffect, useState } from 'react'
import { api, getCurrentUser, type Customer, type Experiment, type Order, type OrderDetail, type Project } from '../api'
import { Modal } from '../components/Modal'
import { ExperimentDataModal } from '../components/ExperimentDataModal'
import { IconEye, IconPortal, IconRefresh } from '../components/icons'
import { orderStatusTone } from './OrdersPage'

/** 客户门户：仅展示当前登录客户名下的订单（后端按客户自动过滤），按项目分组 */
export function PortalPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const user = getCurrentUser()
  const [list, setList] = useState<Order[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  // 当前账号关联的客户档案（有则顶部展示公司名称）
  const [profile, setProfile] = useState<Customer | null>(null)
  // 「实验数据」弹窗目标（订单详情里点某个实验的查看按钮）
  const [dataExp, setDataExp] = useState<Experiment | null>(null)

  const refresh = useCallback(async () => {
    const [orders, projs] = await Promise.all([api.listOrders(), api.listProjects()])
    setList(orders)
    setProjects(projs)
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
    // 客户角色调 /customers 只会返回本人档案
    api.listCustomers()
      .then((cs) => setProfile(cs[0] ?? null))
      .catch(() => {})
  }, [])

  async function openDetail(o: Order) {
    try {
      setDetail(await api.orderDetail(o.id))
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载订单详情失败', false)
    }
  }

  /** 订单按项目分组：有项目的按项目分组（组标题 = 项目号 + 项目名），无项目归入「未归属项目」 */
  const groups: { key: string; title: string; orders: Order[] }[] = []
  if (list) {
    const byProject = new Map<string, Order[]>()
    for (const o of list) {
      const key = o.project_id || ''
      const arr = byProject.get(key) ?? []
      arr.push(o)
      byProject.set(key, arr)
    }
    for (const p of projects) {
      const orders = byProject.get(p.id)
      if (orders?.length) {
        groups.push({ key: p.id, title: `${p.project_no} · ${p.name}`, orders })
        byProject.delete(p.id)
      }
    }
    // 项目已被删除/不可见但订单仍挂着的，一并归入未归属
    const rest = [...byProject.values()].flat()
    if (rest.length) groups.push({ key: '', title: '未归属项目', orders: rest })
  }

  return (
    <>
      <header className="page-head">
        <h1>我的订单</h1>
        <div className="page-head-side">
          {profile && <span className="badge ok">{profile.name}</span>}
          {user && <span className="badge info">{user.display_name}</span>}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新订单">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      {!list ? (
        <div className="empty">加载中…</div>
      ) : !list.length ? (
        <div className="panel">
          <div className="empty">暂无订单，请联系风洞运营方</div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.key || 'none'} className="panel">
            <div className="panel-head">
              <h2>{g.title}</h2>
            </div>
            <div className="sub-card-grid">
              {g.orders.map((o) => (
                <button key={o.id} type="button" className="sub-card" onClick={() => openDetail(o)} title="查看订单详情">
                  <div className="sub-card-top">
                    <span className="sub-card-icon">
                      <IconPortal size={20} />
                    </span>
                    <div>
                      <div className="sub-card-name mono">{o.order_no}</div>
                      <div className="sub-card-meta">{o.created_at.replace('T', ' ').slice(0, 10)}</div>
                    </div>
                    <span className={`badge ${orderStatusTone(o.status)} sub-card-status`}>{o.status}</span>
                  </div>
                  <div className="sub-card-name">{o.title}</div>
                  {o.note && <div className="sub-card-meta">{o.note}</div>}
                </button>
              ))}
            </div>
          </div>
        ))
      )}

      {/* 订单详情弹窗：订单信息 + 关联实验（只读）。实验数据弹窗打开时屏蔽 Esc/遮罩关闭，避免两层一起被关掉 */}
      <Modal open={!!detail} onClose={() => { if (!dataExp) setDetail(null) }} size="lg" title={`订单详情 · ${detail?.order_no ?? ''}`}>
        {detail && (
          <>
            <div className="badge-row">
              <span className={`badge ${orderStatusTone(detail.status)}`}>{detail.status}</span>
              <span className="badge mono">创建于 {detail.created_at.replace('T', ' ').slice(0, 19)}</span>
            </div>
            <div className="form-row">
              <label>标题</label>
              <span>{detail.title}</span>
            </div>
            {detail.note && (
              <div className="form-row">
                <label>备注</label>
                <span>{detail.note}</span>
              </div>
            )}
            <h2 className="section-sub">试验进展</h2>
            <table className="table">
              <thead>
                <tr><th>实验</th><th>状态</th><th>创建时间</th><th>数据</th></tr>
              </thead>
              <tbody>
                {detail.experiments.map((x) => (
                  <tr key={x.id}>
                    <td>{x.title}</td>
                    <td>{x.phase}</td>
                    <td className="mono">{x.created_at.replace('T', ' ').slice(0, 19)}</td>
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => setDataExp(x)}
                        title="查看实验过程数据（run / 曲线 / 报告）"
                      >
                        <IconEye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.experiments.length && <div className="empty">该订单暂未安排实验，请耐心等待运营方排期</div>}
          </>
        )}
      </Modal>

      {/* 实验过程数据弹窗（只读） */}
      <ExperimentDataModal exp={dataExp} toast={toast} onClose={() => setDataExp(null)} />
    </>
  )
}
