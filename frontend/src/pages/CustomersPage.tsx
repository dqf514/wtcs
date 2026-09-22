import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, hasMinRole, type Customer, type CustomerDetail } from '../api'
import { Modal, ConfirmModal } from '../components/Modal'
import { IconEye, IconPlus, IconRefresh, IconEdit, IconTrash } from '../components/icons'
import { orderStatusTone } from './OrdersPage'

/** 项目状态徽标配色（详情弹窗内项目列表复用） */
function projectStatusTone(status: string): string {
  switch (status) {
    case '进行中':
      return 'info'
    case '验收':
      return 'ok'
    default:
      return 'dim'
  }
}

/** 客户管理：客户档案 CRUD + 名下项目/订单详情（只读） */
export function CustomersPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canManage = hasMinRole('维护员') // 客户写操作需维护员+
  const canDelete = hasMinRole('管理员') // 删除仅管理员
  const [list, setList] = useState<Customer[]>([])
  // 新建/编辑弹窗
  const [editTarget, setEditTarget] = useState<Customer | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fCode, setFCode] = useState('')
  const [fName, setFName] = useState('')
  const [fContact, setFContact] = useState('')
  const [fPhone, setFPhone] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fAddress, setFAddress] = useState('')
  const [fNotes, setFNotes] = useState('')
  const [fIndustry, setFIndustry] = useState('')
  const [fContactTitle, setFContactTitle] = useState('')
  const [fUsername, setFUsername] = useState('')
  // 详情 / 删除
  const [detail, setDetail] = useState<CustomerDetail | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)

  const refresh = useCallback(async () => {
    setList(await api.listCustomers())
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [])

  function resetForm() {
    setFCode('')
    setFName('')
    setFContact('')
    setFPhone('')
    setFEmail('')
    setFAddress('')
    setFNotes('')
    setFIndustry('')
    setFContactTitle('')
    setFUsername('')
  }

  function openCreate() {
    resetForm()
    setCreateOpen(true)
  }

  function openEdit(c: Customer) {
    setFName(c.name)
    setFContact(c.contact)
    setFPhone(c.phone)
    setFEmail(c.email)
    setFAddress(c.address)
    setFNotes(c.notes)
    setFIndustry(c.industry ?? '')
    setFContactTitle(c.contact_title ?? '')
    setFUsername(c.username ?? '')
    setEditTarget(c)
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createCustomer({
        code: fCode,
        name: fName,
        contact: fContact,
        phone: fPhone,
        email: fEmail,
        address: fAddress,
        notes: fNotes,
        industry: fIndustry,
        contact_title: fContactTitle,
        username: fUsername || null,
      })
      toast(`客户 ${fCode} 已创建`)
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
      await api.updateCustomer(editTarget.id, {
        name: fName,
        contact: fContact,
        phone: fPhone,
        email: fEmail,
        address: fAddress,
        notes: fNotes,
        industry: fIndustry,
        contact_title: fContactTitle,
        // 后端约定：空字符串表示清除账号关联
        username: fUsername || '',
      })
      toast('客户档案已更新')
      setEditTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', false)
    }
  }

  async function openDetail(c: Customer) {
    try {
      setDetail(await api.customerDetail(c.id))
    } catch (err) {
      toast(err instanceof Error ? err.message : '加载客户详情失败', false)
    }
  }

  async function removeCustomer(c: Customer) {
    try {
      await api.deleteCustomer(c.id)
      toast(`客户 ${c.code} 已删除`)
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', false)
    }
  }

  const formFields = (codeReadOnly: boolean) => (
    <>
      <div className="form-row">
        <label>客户编号</label>
        {codeReadOnly ? (
          <input value={editTarget?.code ?? ''} readOnly disabled />
        ) : (
          <input autoFocus value={fCode} onChange={(e) => setFCode(e.target.value)} required placeholder="如 HF-001" />
        )}
      </div>
      <div className="form-row">
        <label>客户/公司名称</label>
        <input autoFocus={codeReadOnly} value={fName} onChange={(e) => setFName(e.target.value)} required />
      </div>
      <div className="form-row">
        <label>行业</label>
        <input list="wtcs-industry-options" value={fIndustry} onChange={(e) => setFIndustry(e.target.value)} placeholder="选择或手输行业" />
        <datalist id="wtcs-industry-options">
          <option value="整车厂" />
          <option value="零部件" />
          <option value="科研院所" />
          <option value="高校" />
          <option value="其他" />
        </datalist>
      </div>
      <div className="form-row">
        <label>联系人</label>
        <input value={fContact} onChange={(e) => setFContact(e.target.value)} />
      </div>
      <div className="form-row">
        <label>联系人职务</label>
        <input value={fContactTitle} onChange={(e) => setFContactTitle(e.target.value)} placeholder="如 试验主管" />
      </div>
      <div className="form-row">
        <label>电话</label>
        <input value={fPhone} onChange={(e) => setFPhone(e.target.value)} />
      </div>
      <div className="form-row">
        <label>邮箱</label>
        <input type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
      </div>
      <div className="form-row">
        <label>地址</label>
        <input value={fAddress} onChange={(e) => setFAddress(e.target.value)} />
      </div>
      <div className="form-row">
        <label>关联账号</label>
        <input value={fUsername} onChange={(e) => setFUsername(e.target.value)} placeholder="客户角色登录账号，可空" />
      </div>
      <div className="form-row">
        <label>备注</label>
        <textarea rows={3} value={fNotes} onChange={(e) => setFNotes(e.target.value)} />
      </div>
    </>
  )

  return (
    <>
      <header className="page-head">
        <h1>客户管理</h1>
        <div className="page-head-side">
          {canManage && (
            <button type="button" className="icon-btn" onClick={openCreate} title="新建客户">
              <IconPlus size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新客户列表">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <div className="panel">
        <div className="panel-head">
          <h2>客户列表</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>编号</th>
              <th>名称</th>
              <th>行业</th>
              <th>联系人</th>
              <th>电话</th>
              <th>关联账号</th>
              <th>项目数</th>
              <th>订单数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.code}</td>
                <td>{c.name}</td>
                <td>{c.industry || '—'}</td>
                <td>{c.contact || '—'}</td>
                <td className="mono">{c.phone || '—'}</td>
                <td className="mono">{c.username || '—'}</td>
                <td className="mono">{c.project_count ?? 0}</td>
                <td className="mono">{c.order_count ?? 0}</td>
                <td>
                  <div className="actions actions-flush">
                    <button type="button" className="icon-btn" onClick={() => openDetail(c)} title="客户详情与名下项目/订单">
                      <IconEye size={16} />
                    </button>
                    {canManage && (
                      <button type="button" className="icon-btn" onClick={() => openEdit(c)} title="编辑客户">
                        <IconEdit size={16} />
                      </button>
                    )}
                    {canDelete && (
                      <button type="button" className="icon-btn danger" onClick={() => setDeleteTarget(c)} title="删除客户">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无客户{canManage ? '，点击右上角「+」新建客户' : ''}</div>}
      </div>

      {/* 新建客户弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="sm"
        title="新建客户"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-customer-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-customer-create" onSubmit={submitCreate}>
          {formFields(false)}
        </form>
      </Modal>

      {/* 编辑客户弹窗（编号只读） */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        size="sm"
        title={`编辑客户 · ${editTarget?.code ?? ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-customer-edit" type="submit">保存</button>
          </>
        }
      >
        <form id="wtcs-customer-edit" onSubmit={submitEdit}>
          {formFields(true)}
        </form>
      </Modal>

      {/* 客户详情弹窗：档案信息 + 名下项目/订单（只读） */}
      <Modal open={!!detail} onClose={() => setDetail(null)} size="lg" title={`客户详情 · ${detail?.code ?? ''}`}>
        {detail && (
          <>
            <div className="badge-row">
              <span className="badge info">{detail.name}</span>
              {detail.industry && <span className="badge">{detail.industry}</span>}
              <span className="badge mono">创建于 {detail.created_at.replace('T', ' ').slice(0, 19)}</span>
            </div>
            <div className="form-row">
              <label>行业</label>
              <span>{detail.industry || '—'}</span>
            </div>
            <div className="form-row">
              <label>联系人</label>
              <span>{detail.contact || '—'}</span>
            </div>
            <div className="form-row">
              <label>联系人职务</label>
              <span>{detail.contact_title || '—'}</span>
            </div>
            <div className="form-row">
              <label>电话</label>
              <span className="mono">{detail.phone || '—'}</span>
            </div>
            <div className="form-row">
              <label>邮箱</label>
              <span>{detail.email || '—'}</span>
            </div>
            <div className="form-row">
              <label>地址</label>
              <span>{detail.address || '—'}</span>
            </div>
            <div className="form-row">
              <label>备注</label>
              <span>{detail.notes || '—'}</span>
            </div>
            <h2 className="section-sub">关联账号</h2>
            {detail.username ? (
              <div className="badge-row">
                <span className="badge info">账号 {detail.username}</span>
                <span className="badge warn">外部账号</span>
              </div>
            ) : (
              <div className="empty">未关联登录账号</div>
            )}
            <div className="hint">外部登录账号（创建、停用、重置密码）请到「系统设置 → 用户与权限」维护，此处仅维护与客户档案的关联。</div>
            <h2 className="section-sub">名下项目</h2>
            <table className="table">
              <thead>
                <tr><th>项目号</th><th>名称</th><th>状态</th><th>创建时间</th></tr>
              </thead>
              <tbody>
                {detail.projects.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.project_no}</td>
                    <td>{p.name}</td>
                    <td>
                      <span className={`badge ${projectStatusTone(p.status)}`}>{p.status}</span>
                    </td>
                    <td className="mono">{p.created_at.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.projects.length && <div className="empty">该客户名下暂无项目</div>}
            <h2 className="section-sub">名下订单</h2>
            <table className="table">
              <thead>
                <tr><th>订单号</th><th>标题</th><th>状态</th><th>创建时间</th></tr>
              </thead>
              <tbody>
                {detail.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.order_no}</td>
                    <td>{o.title}</td>
                    <td>
                      <span className={`badge ${orderStatusTone(o.status)}`}>{o.status}</span>
                    </td>
                    <td className="mono">{o.created_at.replace('T', ' ').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!detail.orders.length && <div className="empty">该客户名下暂无订单</div>}
          </>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void removeCustomer(deleteTarget)
        }}
        title="删除客户"
        danger
        confirmLabel="删除"
        message={`确认删除客户「${deleteTarget?.code ?? ''} ${deleteTarget?.name ?? ''}」？名下仍有项目或订单时无法删除。`}
      />
    </>
  )
}
