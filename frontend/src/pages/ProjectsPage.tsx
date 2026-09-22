import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, hasMinRole, type Customer, type Project, type ProjectDetail } from '../api'
import { Modal, ConfirmModal } from '../components/Modal'
import { IconEye, IconPlus, IconRefresh, IconEdit, IconTrash } from '../components/icons'
import { orderStatusTone } from './OrdersPage'

const PROJECT_STATUSES = ['商机', '立项', '进行中', '验收', '已归档']

/** 项目状态徽标配色 */
function projectStatusTone(status: string): string {
  switch (status) {
    case '进行中':
      return 'info'
    case '验收':
      return 'ok'
    case '已归档':
      return 'dim'
    default:
      return 'dim'
  }
}

export function ProjectsPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canManage = hasMinRole('维护员') // 项目写操作需维护员+
  const isAdmin = hasMinRole('管理员')
  const [list, setList] = useState<Project[]>([])
  // 项目号 → 订单数（详情接口汇总，列表页展示用）
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({})
  // 新建/编辑弹窗
  const [editTarget, setEditTarget] = useState<Project | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fProjectNo, setFProjectNo] = useState('')
  const [fName, setFName] = useState('')
  const [fCustomer, setFCustomer] = useState('')
  const [fCustomerId, setFCustomerId] = useState('')
  const [fStatus, setFStatus] = useState('立项')
  const [fNote, setFNote] = useState('')
  // 客户档案下拉（内部角色可读 /customers；客户角色不会进本页写操作）
  const [customers, setCustomers] = useState<Customer[]>([])
  // admin 场景客户下拉：角色页面含 portal 的用户
  const [customerOptions, setCustomerOptions] = useState<{ username: string; display_name: string }[]>([])
  // 详情 / 删除
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)

  const refresh = useCallback(async () => {
    const [projects, orders, custs] = await Promise.all([api.listProjects(), api.listOrders(), api.listCustomers()])
    setList(projects)
    setCustomers(custs)
    const counts: Record<string, number> = {}
    for (const o of orders) {
      if (o.project_id) counts[o.project_id] = (counts[o.project_id] ?? 0) + 1
    }
    setOrderCounts(counts)
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
    setFProjectNo('')
    setFName('')
    setFCustomer(customerOptions[0]?.username ?? '')
    setFCustomerId('')
    setFStatus('立项')
    setFNote('')
    setCreateOpen(true)
  }

  function openEdit(p: Project) {
    setFName(p.name)
    setFCustomer(p.customer_username)
    setFCustomerId(p.customer_id ?? '')
    setFStatus(p.status)
    setFNote(p.note)
    setEditTarget(p)
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
      await api.createProject({
        project_no: fProjectNo,
        name: fName,
        customer_username: fCustomer,
        customer_id: fCustomerId || null,
        status: fStatus,
        note: fNote,
      })
      toast(`项目 ${fProjectNo} 已创建`)
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
      await api.updateProject(editTarget.id, {
        name: fName,
        customer_username: fCustomer,
        // 后端约定：空字符串表示清除客户档案归属
        customer_id: fCustomerId || '',
        status: fStatus,
        note: fNote,
      })
      toast('项目已更新')
      setEditTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', false)
    }
  }

  async function openDetail(p: Project) {
    try {
      setDetail(await api.projectDetail(p.id))
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载项目详情失败', false)
    }
  }

  async function removeProject(p: Project) {
    try {
      await api.deleteProject(p.id)
      toast(`项目 ${p.project_no} 已删除`)
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
        <h1>项目管理</h1>
        <div className="page-head-side">
          {canManage && (
            <button type="button" className="icon-btn" onClick={openCreate} title="新建项目">
              <IconPlus size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新项目列表">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2>项目列表</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>项目号</th>
              <th>名称</th>
              <th>客户</th>
              <th>状态</th>
              <th>订单数</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.project_no}</td>
                <td>{p.name}</td>
                <td>{p.customer_name || <span className="mono">{p.customer_username}</span>}</td>
                <td>
                  <span className={`badge ${projectStatusTone(p.status)}`}>{p.status}</span>
                </td>
                <td className="mono">{orderCounts[p.id] ?? 0}</td>
                <td className="mono">{p.created_at.replace('T', ' ').slice(0, 19)}</td>
                <td>
                  <div className="actions actions-flush">
                    <button type="button" className="icon-btn" onClick={() => openDetail(p)} title="项目详情与关联订单">
                      <IconEye size={16} />
                    </button>
                    {canManage && (
                      <button type="button" className="icon-btn" onClick={() => openEdit(p)} title="编辑项目">
                        <IconEdit size={16} />
                      </button>
                    )}
                    {canManage && (
                      <button type="button" className="icon-btn danger" onClick={() => setDeleteTarget(p)} title="删除项目">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无项目{canManage ? '，点击右上角「+」新建项目' : ''}</div>}
      </div>

      {/* 新建项目弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="sm"
        title="新建项目"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-project-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-project-create" onSubmit={submitCreate}>
          <div className="form-row">
            <label>项目号</label>
            <input autoFocus value={fProjectNo} onChange={(e) => setFProjectNo(e.target.value)} required placeholder="如 HF-2026-01" />
          </div>
          <div className="form-row">
            <label>名称</label>
            <input value={fName} onChange={(e) => setFName(e.target.value)} required />
          </div>
          <div className="form-row">
            <label>客户档案</label>
            {customerProfileField}
          </div>
          <div className="form-row">
            <label>客户账号</label>
            {customerField()}
          </div>
          <div className="form-row">
            <label>状态</label>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              {PROJECT_STATUSES.map((s) => (
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

      {/* 编辑项目弹窗（项目号只读） */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        size="sm"
        title={`编辑项目 · ${editTarget?.project_no ?? ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-project-edit" type="submit">保存</button>
          </>
        }
      >
        <form id="wtcs-project-edit" onSubmit={submitEdit}>
          <div className="form-row">
            <label>项目号</label>
            <input value={editTarget?.project_no ?? ''} readOnly disabled />
          </div>
          <div className="form-row">
            <label>名称</label>
            <input autoFocus value={fName} onChange={(e) => setFName(e.target.value)} required />
          </div>
          <div className="form-row">
            <label>客户档案</label>
            {customerProfileField}
          </div>
          <div className="form-row">
            <label>客户账号</label>
            {customerField()}
          </div>
          <div className="form-row">
            <label>状态</label>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              {PROJECT_STATUSES.map((s) => (
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

      {/* 项目详情弹窗：项目信息 + 其下订单 */}
      <Modal open={!!detail} onClose={() => setDetail(null)} size="lg" title={`项目详情 · ${detail?.project_no ?? ''}`}>
        {detail && (
          <>
            <div className="badge-row">
              <span className={`badge ${projectStatusTone(detail.status)}`}>{detail.status}</span>
              <span className="badge">客户 {detail.customer_name || detail.customer_username}</span>
              <span className="badge mono">创建于 {detail.created_at.replace('T', ' ').slice(0, 19)}</span>
            </div>
            <div className="form-row">
              <label>名称</label>
              <span>{detail.name}</span>
            </div>
            {detail.customer_id && (
              <>
                <h2 className="section-sub">客户信息</h2>
                <div className="form-row">
                  <label>客户名称</label>
                  <span>{customers.find((c) => c.id === detail.customer_id)?.name ?? detail.customer_name ?? '—'}</span>
                </div>
                <div className="form-row">
                  <label>联系人</label>
                  <span>{customers.find((c) => c.id === detail.customer_id)?.contact || '—'}</span>
                </div>
                <div className="form-row">
                  <label>电话</label>
                  <span className="mono">{customers.find((c) => c.id === detail.customer_id)?.phone || '—'}</span>
                </div>
              </>
            )}
            {detail.note && (
              <div className="form-row">
                <label>备注</label>
                <span>{detail.note}</span>
              </div>
            )}
            <h2 className="section-sub">项目订单</h2>
            <table className="table">
              <thead>
                <tr><th>订单号</th><th>标题</th><th>状态</th><th>实验数</th><th>创建时间</th></tr>
              </thead>
              <tbody>
                {detail.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.order_no}</td>
                    <td>{o.title}</td>
                    <td>
                      <span className={`badge ${orderStatusTone(o.status)}`}>{o.status}</span>
                    </td>
                    <td className="mono">{o.experiment_count}</td>
                    <td className="mono">{o.created_at.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.orders.length && <div className="empty">该项目还没有关联订单，可在订单管理中新建订单时绑定</div>}
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void removeProject(deleteTarget)
        }}
        title="删除项目"
        danger
        confirmLabel="删除"
        message={`确认删除项目「${deleteTarget?.project_no ?? ''}」？项目下仍有订单时无法删除。`}
      />
    </>
  )
}
