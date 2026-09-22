import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, getCurrentUser, hasMinRole, hasPage, type Customer, type Order, type OrderDetail, type Project } from '../api'
import { Modal, ConfirmModal } from '../components/Modal'
import { IconEye, IconPlus, IconRefresh, IconEdit, IconTrash } from '../components/icons'

const ORDER_STATUSES = ['待启动', '进行中', '已完成', '已关闭']

/** 订单状态徽标配色（门户卡片复用） */
export function orderStatusTone(status: string): string {
  switch (status) {
    case '进行中':
      return 'info'
    case '已完成':
      return 'ok'
    case '已关闭':
      return 'warn'
    default:
      return 'dim'
  }
}

export function OrdersPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canManage = hasPage('orders') // 页面权限=新建/编辑（角色矩阵勾选即可写）
  const canDelete = hasMinRole('维护员') // 删除仍需维护员+
  const isStaff = hasMinRole('操作员') // 内部员工；客户角色归属/状态由后端锁定为本人
  const isAdmin = hasMinRole('管理员')
  const [list, setList] = useState<Order[]>([])
  // 项目下拉与「项目」列展示（project_id → 项目号）
  const [projects, setProjects] = useState<Project[]>([])
  // 新建/编辑弹窗
  const [editTarget, setEditTarget] = useState<Order | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fOrderNo, setFOrderNo] = useState('')
  const [fTitle, setFTitle] = useState('')
  const [fCustomer, setFCustomer] = useState('')
  const [fCustomerId, setFCustomerId] = useState('')
  const [fStatus, setFStatus] = useState('待启动')
  const [fNote, setFNote] = useState('')
  const [fProjectId, setFProjectId] = useState('')
  // 客户档案下拉（可空）
  const [customers, setCustomers] = useState<Customer[]>([])
  // admin 场景客户下拉：角色页面含 portal 的用户
  const [customerOptions, setCustomerOptions] = useState<{ username: string; display_name: string }[]>([])
  // 详情 / 删除
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Order | null>(null)

  const refresh = useCallback(async () => {
    const [orders, projs, custs] = await Promise.all([api.listOrders(), api.listProjects(), api.listCustomers()])
    setList(orders)
    setProjects(projs)
    setCustomers(custs)
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [])

  // 客户下拉仅 admin 可用（listUsers 需 admin 权限）；维护员场景退化为文本输入
  useEffect(() => {
    if (!isAdmin) return
    Promise.all([api.listUsers(), api.listRoles()])
      .then(([users, roles]) => {
        const portalRoles = new Set(roles.filter((r) => r.pages.includes('portal')).map((r) => r.name))
        setCustomerOptions(
          users
            .filter((u) => u.enabled && portalRoles.has(u.role))
            .map((u) => ({ username: u.username, display_name: u.display_name })),
        )
      })
      .catch(() => {})
  }, [isAdmin])

  function openCreate() {
    setFOrderNo('')
    setFTitle('')
    // 客户角色归属锁定为本人（后端强制）；内部员工默认选第一个客户账号
    setFCustomer(isStaff ? (customerOptions[0]?.username ?? '') : (getCurrentUser()?.username ?? ''))
    setFCustomerId('')
    setFStatus('待启动')
    setFNote('')
    setFProjectId('')
    setCreateOpen(true)
  }

  function openEdit(o: Order) {
    setFTitle(o.title)
    setFCustomer(o.customer_username)
    setFCustomerId(o.customer_id ?? '')
    setFStatus(o.status)
    setFNote(o.note)
    setFProjectId(o.project_id ?? '')
    setEditTarget(o)
  }

  // 选客户档案后自动带出其关联账号（无关联账号则保留原值）
  function pickCustomer(id: string) {
    setFCustomerId(id)
    const c = customers.find((x) => x.id === id)
    if (c?.username) setFCustomer(c.username)
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createOrder({
        order_no: fOrderNo,
        title: fTitle,
        customer_username: fCustomer,
        customer_id: fCustomerId || null,
        status: fStatus,
        note: fNote,
        project_id: fProjectId || null,
      })
      toast(`订单 ${fOrderNo} 已创建`)
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
      await api.updateOrder(editTarget.id, {
        title: fTitle,
        customer_username: fCustomer,
        // 后端约定：空字符串表示清除客户档案归属
        customer_id: fCustomerId || '',
        status: fStatus,
        note: fNote,
        // 后端约定：空字符串表示清除项目归属
        project_id: fProjectId || '',
      })
      toast('订单已更新')
      setEditTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', false)
    }
  }

  async function openDetail(o: Order) {
    try {
      setDetail(await api.orderDetail(o.id))
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载订单详情失败', false)
    }
  }

  async function removeOrder(o: Order) {
    try {
      await api.deleteOrder(o.id)
      toast(`订单 ${o.order_no} 已删除`)
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', false)
    }
  }

  const customerField = (autoFocus = false) =>
    isAdmin && customerOptions.length ? (
      <select autoFocus={autoFocus} value={fCustomer} onChange={(e) => setFCustomer(e.target.value)}>
        {customerOptions.map((c) => (
          <option key={c.username} value={c.username}>
            {c.display_name}（{c.username}）
          </option>
        ))}
      </select>
    ) : (
      <input value={fCustomer} onChange={(e) => setFCustomer(e.target.value)} required placeholder="客户账号，如 customer" />
    )

  const projectNoOf = (id: string | null) => projects.find((p) => p.id === id)?.project_no ?? ''

  // 项目下拉（可空）：不选表示不归属任何项目
  const projectField = (
    <select value={fProjectId} onChange={(e) => setFProjectId(e.target.value)}>
      <option value="">（不归属项目）</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.project_no} · {p.name}
        </option>
      ))}
    </select>
  )

  // 客户档案下拉（可空）：不选表示仅按客户账号归属，选了自动带出其关联账号
  const customerProfileField = (
    <select value={fCustomerId} onChange={(e) => pickCustomer(e.target.value)}>
      <option value="">（不关联客户档案）</option>
      {customers.map((c) => (
        <option key={c.id} value={c.id}>
          {c.code} · {c.name}
        </option>
      ))}
    </select>
  )

  return (
    <>
      <header className="page-head">
        <h1>订单管理</h1>
        <div className="page-head-side">
          {canManage && (
            <button type="button" className="icon-btn" onClick={openCreate} title="新建订单">
              <IconPlus size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新订单列表">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2>订单列表</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>订单号</th>
              <th>标题</th>
              <th>客户</th>
              <th>项目</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.order_no}</td>
                <td>{o.title}</td>
                <td>{o.customer_name || <span className="mono">{o.customer_username}</span>}</td>
                <td className="mono">{projectNoOf(o.project_id) || '—'}</td>
                <td>
                  <span className={`badge ${orderStatusTone(o.status)}`}>{o.status}</span>
                </td>
                <td className="mono">{o.created_at.replace('T', ' ').slice(0, 19)}</td>
                <td>
                  <div className="actions actions-flush">
                    <button type="button" className="icon-btn" onClick={() => openDetail(o)} title="订单详情与关联实验">
                      <IconEye size={16} />
                    </button>
                    {canManage && (
                      <button type="button" className="icon-btn" onClick={() => openEdit(o)} title="编辑订单">
                        <IconEdit size={16} />
                      </button>
                    )}
                    {canDelete && (
                      <button type="button" className="icon-btn danger" onClick={() => setDeleteTarget(o)} title="删除订单">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无订单{canManage ? '，点击右上角「+」新建订单' : ''}</div>}
      </div>

      {/* 新建订单弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="sm"
        title="新建订单"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-order-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-order-create" onSubmit={submitCreate}>
          <div className="form-row">
            <label>订单号</label>
            <input autoFocus value={fOrderNo} onChange={(e) => setFOrderNo(e.target.value)} required placeholder="如 WD-2026-001" />
          </div>
          <div className="form-row">
            <label>标题</label>
            <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} required />
          </div>
          {/* 归属与状态仅内部员工可指定；客户角色由后端锁定为本人/默认状态 */}
          {isStaff && (
            <div className="form-row">
              <label>客户档案</label>
              {customerProfileField}
            </div>
          )}
          {isStaff && (
            <div className="form-row">
              <label>客户账号</label>
              {customerField()}
            </div>
          )}
          <div className="form-row">
            <label>项目</label>
            {projectField}
          </div>
          {isStaff && (
            <div className="form-row">
              <label>状态</label>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                {ORDER_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-row">
            <label>备注</label>
            <textarea rows={3} value={fNote} onChange={(e) => setFNote(e.target.value)} />
          </div>
        </form>
      </Modal>

      {/* 编辑订单弹窗（订单号只读） */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        size="sm"
        title={`编辑订单 · ${editTarget?.order_no ?? ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-order-edit" type="submit">保存</button>
          </>
        }
      >
        <form id="wtcs-order-edit" onSubmit={submitEdit}>
          <div className="form-row">
            <label>订单号</label>
            <input value={editTarget?.order_no ?? ''} readOnly disabled />
          </div>
          <div className="form-row">
            <label>标题</label>
            <input autoFocus value={fTitle} onChange={(e) => setFTitle(e.target.value)} required />
          </div>
          {isStaff && (
            <div className="form-row">
              <label>客户档案</label>
              {customerProfileField}
            </div>
          )}
          {isStaff && (
            <div className="form-row">
              <label>客户账号</label>
              {customerField()}
            </div>
          )}
          <div className="form-row">
            <label>项目</label>
            {projectField}
          </div>
          {isStaff && (
            <div className="form-row">
              <label>状态</label>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                {ORDER_STATUSES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-row">
            <label>备注</label>
            <textarea rows={3} value={fNote} onChange={(e) => setFNote(e.target.value)} />
          </div>
        </form>
      </Modal>

      {/* 订单详情弹窗：订单信息 + 关联实验 */}
      <Modal open={!!detail} onClose={() => setDetail(null)} size="lg" title={`订单详情 · ${detail?.order_no ?? ''}`}>
        {detail && (
          <>
            <div className="badge-row">
              <span className={`badge ${orderStatusTone(detail.status)}`}>{detail.status}</span>
              <span className="badge">客户 {detail.customer_name || detail.customer_username}</span>
              {detail.project_id && projectNoOf(detail.project_id) && (
                <span className="badge">项目 {projectNoOf(detail.project_id)}</span>
              )}
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
            <h2 className="section-sub">关联实验</h2>
            <table className="table">
              <thead>
                <tr><th>标题</th><th>状态</th><th>创建时间</th></tr>
              </thead>
              <tbody>
                {detail.experiments.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link to="/experiments" title="前往试验中心查看">{x.title}</Link>
                    </td>
                    <td>{x.phase}</td>
                    <td className="mono">{x.created_at.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.experiments.length && <div className="empty">该订单还没有关联实验，可在试验中心新建实验时绑定</div>}
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void removeOrder(deleteTarget)
        }}
        title="删除订单"
        danger
        confirmLabel="删除"
        message={`确认删除订单「${deleteTarget?.order_no ?? ''}」？关联实验不会被删除，但会失去订单归属。`}
      />
    </>
  )
}
