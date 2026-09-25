import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  api,
  downloadBackupFile,
  getCurrentUser,
  hasMinRole,
  type BackupInfo,
  type DatabaseConfig,
  type DatabaseTestResult,
  type NetworkInfo,
  type RoleDef,
  type StorageStats,
  type SystemInfo,
  type UserRow,
} from '../api'
import { useTheme } from '../theme'
import { ALARM_SOUND_KEY } from '../constants'
import { BrandingPanel } from '../components/BrandingPanel'
import { FeedbackPanel } from '../components/FeedbackPanel'
import { Modal, ConfirmModal } from '../components/Modal'
import { IconDownload, IconEdit, IconEye, IconPlus, IconRestore, IconTrash } from '../components/icons'

const SCENARIOS = ['气动实验', '声学实验', 'WLTP滑行', '参观演示']

type TabKey = 'general' | 'telemetry' | 'backup' | 'database' | 'network' | 'ai' | 'system' | 'users' | 'feedback'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'telemetry', label: '遥测与存储' },
  { key: 'backup', label: '备份' },
  { key: 'database', label: '数据库' },
  { key: 'network', label: '网络' },
  { key: 'ai', label: 'AI 与健康' },
  { key: 'system', label: '系统' },
  { key: 'users', label: '用户与权限' },
  { key: 'feedback', label: '用户反馈' },
]

/** Tab 分组：设置页按功能域分组展示，搜索时按标签与关键词过滤 */
const TAB_GROUPS: { label: string; tabs: { key: TabKey; keywords: string }[] }[] = [
  { label: '基础配置', tabs: [
    { key: 'general', keywords: '主题 场景 语言 大屏 刷新 报警 声音' },
    { key: 'telemetry', keywords: '遥测 存储 历史 审计 报警 清理' },
    { key: 'network', keywords: '网络 MQTT broker 端口 CORS API' },
  ]},
  { label: '数据管理', tabs: [
    { key: 'backup', keywords: '备份 恢复 自动' },
    { key: 'database', keywords: '数据库 SQLite 连接 迁移 导出' },
  ]},
  { label: '智能与运维', tabs: [
    { key: 'ai', keywords: 'AI 巡检 健康 基线 学习' },
    { key: 'system', keywords: '系统 信息 版本 密码 仿真 模式' },
  ]},
  { label: '权限与协作', tabs: [
    { key: 'users', keywords: '用户 角色 权限 矩阵' },
    { key: 'feedback', keywords: '反馈 意见 建议' },
  ]},
]

/** 角色矩阵的页面列（与后端页面 key 全集一致） */
const PAGE_DEFS = [
  { key: 'portal', label: '客户门户' },
  { key: 'dashboard', label: '总控台' },
  { key: 'schedule', label: '排程计划' },
  { key: 'subsystems', label: '子系统' },
  { key: 'equipment', label: '设备台账' },
  { key: 'experiments', label: '试验中心' },
  { key: 'data', label: '数据中心' },
  { key: 'insight', label: '智能洞察' },
  { key: 'screen', label: '大屏' },
  { key: 'projects', label: '项目管理' },
  { key: 'customers', label: '客户管理' },
  { key: 'orders', label: '订单管理' },
  { key: 'settings', label: '系统设置' },
]

const LEVEL_CN = ['客户', '操作员', '维护员', '管理员']

function fmtBytes(n: number | undefined) {
  if (n == null || n < 0) return '--'
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtUptime(sec: number) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分 ${sec % 60} 秒`
}

function Row({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <label className="form-row-label">
        {label}
        {tip && <span className="help-tip" data-tip={tip}>?</span>}
      </label>
      {children}
    </div>
  )
}

/** 用户与权限（仅 admin）：上半用户表，下半角色权限矩阵 */
function UsersRolesPanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const me = getCurrentUser()?.username
  const [users, setUsers] = useState<UserRow[]>([])
  const [roles, setRoles] = useState<RoleDef[]>([])
  // 角色矩阵行草稿：改动先落本地，点「保存」再 PUT（比勾选即存更稳，避免误触）
  const [drafts, setDrafts] = useState<Record<string, { level: number; pages: string[] }>>({})
  // 用户新建/编辑弹窗
  const [editTarget, setEditTarget] = useState<UserRow | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fUsername, setFUsername] = useState('')
  const [fPassword, setFPassword] = useState('')
  const [fDisplay, setFDisplay] = useState('')
  const [fRole, setFRole] = useState('')
  const [fPhone, setFPhone] = useState('')
  const [fEmail, setFEmail] = useState('')
  const [fCompany, setFCompany] = useState('')
  const [fDepartment, setFDepartment] = useState('')
  const [fPosition, setFPosition] = useState('')
  const [fNotes, setFNotes] = useState('')
  // 只读档案卡
  const [viewTarget, setViewTarget] = useState<UserRow | null>(null)
  // 内部/外部账号过滤（customer 角色 = 外部账号）
  const [scope, setScope] = useState<'all' | 'internal' | 'external'>('all')
  // 重置密码弹窗
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null)
  const [resetPwd, setResetPwd] = useState('')
  // 新建角色弹窗
  const [roleOpen, setRoleOpen] = useState(false)
  const [rName, setRName] = useState('')
  const [rLevel, setRLevel] = useState(0)
  const [rPages, setRPages] = useState<string[]>(['portal', 'dashboard'])
  // 统一确认弹窗（停用/启用/删除用户、删除角色）
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirmLabel: string
    action: () => void | Promise<void>
  } | null>(null)

  const reload = useCallback(async () => {
    const [us, rs] = await Promise.all([api.listUsers(), api.listRoles()])
    setUsers(us)
    setRoles(rs)
    setDrafts(Object.fromEntries(rs.map((r) => [r.name, { level: r.level, pages: r.pages }])))
  }, [])

  useEffect(() => {
    reload().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [])

  function openCreate() {
    setFUsername('')
    setFPassword('')
    setFDisplay('')
    setFRole(roles[0]?.name ?? '')
    setFPhone('')
    setFEmail('')
    setFCompany('合肥汽车风洞')
    setFDepartment('')
    setFPosition('')
    setFNotes('')
    setCreateOpen(true)
  }

  function openEdit(u: UserRow) {
    setFDisplay(u.display_name)
    setFRole(u.role)
    setFPhone(u.phone ?? '')
    setFEmail(u.email ?? '')
    setFCompany(u.company ?? '')
    setFDepartment(u.department ?? '')
    setFPosition(u.position ?? '')
    setFNotes(u.notes ?? '')
    setEditTarget(u)
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createUser({
        username: fUsername,
        password: fPassword,
        display_name: fDisplay,
        role: fRole,
        phone: fPhone,
        email: fEmail,
        company: fCompany,
        department: fDepartment,
        position: fPosition,
        notes: fNotes,
      })
      toast(`用户 ${fUsername} 已创建`)
      setCreateOpen(false)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败', false)
    }
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault()
    if (!editTarget) return
    try {
      await api.updateUser(editTarget.username, {
        display_name: fDisplay,
        role: fRole,
        phone: fPhone,
        email: fEmail,
        company: fCompany,
        department: fDepartment,
        position: fPosition,
        notes: fNotes,
      })
      toast('用户已更新')
      setEditTarget(null)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', false)
    }
  }

  async function submitReset(e: FormEvent) {
    e.preventDefault()
    if (!resetTarget) return
    try {
      await api.updateUser(resetTarget.username, { password: resetPwd })
      toast(`已重置 ${resetTarget.username} 的密码`)
      setResetTarget(null)
      setResetPwd('')
    } catch (err) {
      toast(err instanceof Error ? err.message : '重置失败', false)
    }
  }

  function toggleEnabled(u: UserRow) {
    setConfirm({
      title: u.enabled ? '停用用户' : '启用用户',
      message: u.enabled
        ? `确认停用「${u.display_name}（${u.username}）」？停用后该账号无法登录。`
        : `确认启用「${u.display_name}（${u.username}）」？`,
      confirmLabel: u.enabled ? '停用' : '启用',
      action: async () => {
        try {
          await api.updateUser(u.username, { enabled: !u.enabled })
          toast(u.enabled ? '已停用' : '已启用')
          await reload()
        } catch (err) {
          toast(err instanceof Error ? err.message : '操作失败', false)
        }
      },
    })
  }

  function removeUser(u: UserRow) {
    setConfirm({
      title: '删除用户',
      message: `确认删除用户「${u.display_name}（${u.username}）」？删除后不可恢复。`,
      confirmLabel: '删除',
      action: async () => {
        try {
          await api.deleteUser(u.username)
          toast('用户已删除')
          await reload()
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', false)
        }
      },
    })
  }

  async function saveRole(name: string) {
    const d = drafts[name]
    if (!d) return
    try {
      await api.updateRole(name, { level: d.level, pages: d.pages })
      toast(`角色「${name}」已保存`)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', false)
    }
  }

  function removeRole(r: RoleDef) {
    setConfirm({
      title: '删除角色',
      message: `确认删除角色「${r.name}」？仍有用户使用或内置角色无法删除。`,
      confirmLabel: '删除',
      action: async () => {
        try {
          await api.deleteRole(r.name)
          toast('角色已删除')
          await reload()
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', false)
        }
      },
    })
  }

  async function submitRole(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createRole({ name: rName, level: rLevel, pages: rPages })
      toast(`角色「${rName}」已创建`)
      setRoleOpen(false)
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败', false)
    }
  }

  function toggleDraftPage(name: string, page: string, on: boolean) {
    setDrafts((ds) => {
      const d = ds[name]
      if (!d) return ds
      const pages = on ? [...d.pages, page] : d.pages.filter((p) => p !== page)
      return { ...ds, [name]: { ...d, pages } }
    })
  }

  const roleDirty = (r: RoleDef) => {
    const d = drafts[r.name]
    if (!d) return false
    return d.level !== r.level || d.pages.length !== r.pages.length || d.pages.some((p) => !r.pages.includes(p))
  }

  // customer（客户）角色 = 外部账号（客户登录账号）；其余为内部账号
  const isExternal = (u: UserRow) => u.role === '客户'
  const filteredUsers = users.filter((u) =>
    scope === 'all' ? true : scope === 'external' ? isExternal(u) : !isExternal(u),
  )

  // 新建/编辑弹窗共用的档案字段（两列布局，备注跨整行）
  const profileRows = (
    <>
      <Row label="手机">
        <input value={fPhone} onChange={(e) => setFPhone(e.target.value)} />
      </Row>
      <Row label="邮箱">
        <input type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
      </Row>
      <Row label="公司">
        <input value={fCompany} onChange={(e) => setFCompany(e.target.value)} placeholder="合肥汽车风洞" />
      </Row>
      <Row label="部门">
        <input value={fDepartment} onChange={(e) => setFDepartment(e.target.value)} />
      </Row>
      <Row label="职位">
        <input value={fPosition} onChange={(e) => setFPosition(e.target.value)} />
      </Row>
      <div className="form-row form-row--full">
        <label>备注</label>
        <textarea rows={2} value={fNotes} onChange={(e) => setFNotes(e.target.value)} />
      </div>
    </>
  )

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>用户管理</h2>
          <div className="actions actions-flush">
            <div className="theme-toggle" role="group" aria-label="账号范围过滤">
              <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>全部</button>
              <button type="button" className={scope === 'internal' ? 'active' : ''} onClick={() => setScope('internal')}>内部</button>
              <button type="button" className={scope === 'external' ? 'active' : ''} onClick={() => setScope('external')}>外部</button>
            </div>
            <button type="button" className="btn primary" onClick={openCreate}>
              <IconPlus size={14} /> 新建用户
            </button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr><th>用户名</th><th>姓名</th><th>手机</th><th>部门</th><th>角色</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {filteredUsers.map((u) => {
              const isSelf = u.username === me
              return (
                <tr key={u.username}>
                  <td className="mono">{u.username}</td>
                  <td>{u.display_name}</td>
                  <td className="mono">{u.phone || '—'}</td>
                  <td>{u.department || '—'}</td>
                  <td>
                    {u.role}
                    {isExternal(u) && <span className="badge warn badge-inline">外部</span>}
                  </td>
                  <td>
                    <span className={`badge ${u.enabled ? 'ok' : 'dim'}`}>{u.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td>
                    <div className="actions actions-flush">
                      <button type="button" className="icon-btn" onClick={() => setViewTarget(u)} title="查看档案">
                        <IconEye size={16} />
                      </button>
                      <button type="button" className="icon-btn" disabled={isSelf} onClick={() => openEdit(u)} title={isSelf ? '不能编辑自己' : '编辑姓名、角色与档案'}>
                        <IconEdit size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={isSelf}
                        onClick={() => {
                          setResetPwd('')
                          setResetTarget(u)
                        }}
                        title={isSelf ? '不能重置自己的密码（请在「系统」tab 修改）' : '重置密码'}
                      >
                        重置密码
                      </button>
                      <button type="button" className="btn" disabled={isSelf} onClick={() => toggleEnabled(u)} title={isSelf ? '不能停用/启用自己' : ''}>
                        {u.enabled ? '停用' : '启用'}
                      </button>
                      <button type="button" className="icon-btn danger" disabled={isSelf} onClick={() => removeUser(u)} title={isSelf ? '不能删除自己' : '删除该用户'}>
                        <IconTrash size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!filteredUsers.length && (
          <div className="empty-state">
            <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <div className="empty-state-title">{users.length ? '该范围内暂无账号' : '暂无用户'}</div>
            <div className="empty-state-desc">
              {users.length ? '当前过滤条件下没有匹配的用户' : '点击右上角「新建用户」添加第一个用户'}
            </div>
          </div>
        )}
      </div>

      <div className="panel panel-mt">
        <div className="panel-head">
          <h2>角色权限矩阵</h2>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setRName('')
              setRLevel(0)
              setRPages(['portal', 'dashboard'])
              setRoleOpen(true)
            }}
          >
            <IconPlus size={14} /> 新建角色
          </button>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>角色</th>
                <th>等级</th>
                {PAGE_DEFS.map((p) => (
                  <th key={p.key}>{p.label}</th>
                ))}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => {
                const d = drafts[r.name] ?? { level: r.level, pages: r.pages }
                return (
                  <tr key={r.name}>
                    <td>
                      {r.name} {r.builtin && <span className="badge info badge-inline">内置</span>}
                    </td>
                    <td>
                      <select
                        value={d.level}
                        disabled={r.builtin}
                        onChange={(e) => setDrafts((ds) => ({ ...ds, [r.name]: { ...d, level: Number(e.target.value) } }))}
                      >
                        {LEVEL_CN.map((cn, lv) => (
                          <option key={lv} value={lv}>{lv} · {cn}</option>
                        ))}
                      </select>
                    </td>
                    {PAGE_DEFS.map((p) => (
                      <td key={p.key}>
                        <input
                          type="checkbox"
                          checked={d.pages.includes(p.key)}
                          disabled={r.builtin && r.name === '管理员'}
                          onChange={(e) => toggleDraftPage(r.name, p.key, e.target.checked)}
                        />
                      </td>
                    ))}
                    <td>
                      <div className="actions actions-flush">
                        {(!r.builtin || r.name !== '管理员') && (
                          <button type="button" className="btn" disabled={!roleDirty(r)} onClick={() => saveRole(r.name)}>
                            保存
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn danger"
                          disabled={r.builtin}
                          onClick={() => removeRole(r)}
                          title={r.builtin ? '内置角色不可删除' : '删除该角色'}
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="hint">勾选页面即授予该模块的查看与新建/编辑权限（项目/订单/客户管理等）；删除记录仍需维护员及以上。客户角色只能操作本人名下的项目/订单、编辑本人档案的联系方式。「管理员」角色锁定不可修改以防失锁；其他角色改动需点「保存」生效，用户重新登录后导航随之更新。</div>
      </div>

      {/* 新建用户弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="lg"
        title="新建用户"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-user-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-user-create" onSubmit={submitCreate}>
          <div className="form-grid-2">
            <Row label="用户名">
              <input autoFocus value={fUsername} onChange={(e) => setFUsername(e.target.value)} required placeholder="登录账号" />
            </Row>
            <Row label="初始密码">
              <input type="password" value={fPassword} onChange={(e) => setFPassword(e.target.value)} required placeholder="至少 6 位" autoComplete="new-password" />
            </Row>
            <Row label="姓名">
              <input value={fDisplay} onChange={(e) => setFDisplay(e.target.value)} required placeholder="显示名称" />
            </Row>
            <Row label="角色">
              <select value={fRole} onChange={(e) => setFRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>{r.name}</option>
                ))}
              </select>
            </Row>
            {profileRows}
          </div>
        </form>
      </Modal>

      {/* 编辑用户弹窗（用户名不可改） */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        size="lg"
        title={`编辑用户 · ${editTarget?.username ?? ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setEditTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-user-edit" type="submit">保存</button>
          </>
        }
      >
        <form id="wtcs-user-edit" onSubmit={submitEdit}>
          <div className="form-grid-2">
            <Row label="姓名">
              <input autoFocus value={fDisplay} onChange={(e) => setFDisplay(e.target.value)} required />
            </Row>
            <Row label="角色">
              <select value={fRole} onChange={(e) => setFRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>{r.name}</option>
                ))}
              </select>
            </Row>
            {profileRows}
          </div>
        </form>
      </Modal>

      {/* 用户档案卡（只读） */}
      <Modal open={!!viewTarget} onClose={() => setViewTarget(null)} size="lg" title={`用户档案 · ${viewTarget?.username ?? ''}`}>
        {viewTarget && (
          <>
            <div className="badge-row">
              <span className="badge info">{viewTarget.display_name}</span>
              <span className="badge">{viewTarget.role}</span>
              {isExternal(viewTarget) && <span className="badge warn">外部账号</span>}
              <span className={`badge ${viewTarget.enabled ? 'ok' : 'dim'}`}>{viewTarget.enabled ? '启用' : '停用'}</span>
            </div>
            <div className="form-grid-2">
              <div className="form-row"><label>用户名</label><span className="mono">{viewTarget.username}</span></div>
              <div className="form-row"><label>姓名</label><span>{viewTarget.display_name}</span></div>
              <div className="form-row"><label>手机</label><span className="mono">{viewTarget.phone || '—'}</span></div>
              <div className="form-row"><label>邮箱</label><span>{viewTarget.email || '—'}</span></div>
              <div className="form-row"><label>公司</label><span>{viewTarget.company || '—'}</span></div>
              <div className="form-row"><label>部门</label><span>{viewTarget.department || '—'}</span></div>
              <div className="form-row"><label>职位</label><span>{viewTarget.position || '—'}</span></div>
              <div className="form-row"><label>角色</label><span>{viewTarget.role}</span></div>
              <div className="form-row form-row--full"><label>备注</label><span>{viewTarget.notes || '—'}</span></div>
            </div>
            {isExternal(viewTarget) && (
              <div className="hint">外部账号为客户登录账号，关联客户档案请在「客户管理」中维护。</div>
            )}
          </>
        )}
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        size="sm"
        title={`重置密码 · ${resetTarget?.username ?? ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setResetTarget(null)}>取消</button>
            <button className="btn primary" form="wtcs-user-reset" type="submit">重置</button>
          </>
        }
      >
        <form id="wtcs-user-reset" onSubmit={submitReset}>
          <Row label="新密码">
            <input autoFocus type="password" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)} required placeholder="至少 6 位" autoComplete="new-password" />
          </Row>
        </form>
      </Modal>

      {/* 新建角色弹窗 */}
      <Modal
        open={roleOpen}
        onClose={() => setRoleOpen(false)}
        size="sm"
        title="新建角色"
        footer={
          <>
            <button className="btn" onClick={() => setRoleOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-role-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-role-create" onSubmit={submitRole}>
          <Row label="角色名">
            <input autoFocus value={rName} onChange={(e) => setRName(e.target.value)} required placeholder="如：参观客户" />
          </Row>
          <Row label="等级">
            <select value={rLevel} onChange={(e) => setRLevel(Number(e.target.value))}>
              {LEVEL_CN.map((cn, lv) => (
                <option key={lv} value={lv}>{lv} · {cn}</option>
              ))}
            </select>
          </Row>
          <Row label="页面权限">
            <div className="badge-row">
              {PAGE_DEFS.map((p) => (
                <label key={p.key} className="badge badge-check">
                  <input
                    type="checkbox"
                    checked={rPages.includes(p.key)}
                    onChange={(e) => setRPages((ps) => (e.target.checked ? [...ps, p.key] : ps.filter((x) => x !== p.key)))}
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </Row>
        </form>
      </Modal>

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.action
          setConfirm(null)
          if (action) void action()
        }}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel}
        danger
      />
    </>
  )
}

export function SettingsPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const { theme, setTheme } = useTheme()
  const canEdit = hasMinRole('维护员') // PUT /settings 需维护员+
  const isAdmin = hasMinRole('管理员')
  const [tab, setTab] = useState<TabKey>('general')
  const [search, setSearch] = useState('')
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  // 通用
  const [scenario, setScenario] = useState('气动实验')
  const [language, setLanguage] = useState('zh')
  const [refreshMs, setRefreshMs] = useState(1000)
  const [alarmSound, setAlarmSound] = useState(() => localStorage.getItem(ALARM_SOUND_KEY) === '1')
  // 遥测与存储
  const [telemetryHz, setTelemetryHz] = useState(10)
  const [histDays, setHistDays] = useState(30)
  const [auditDays, setAuditDays] = useState(180)
  const [alertRows, setAlertRows] = useState(5000)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  // 备份
  const [autoBackup, setAutoBackup] = useState(false)
  const [backupHours, setBackupHours] = useState(24)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  // 网络
  const [network, setNetwork] = useState<NetworkInfo | null>(null)
  const [mqttEnabled, setMqttEnabled] = useState(false)
  const [mqttHost, setMqttHost] = useState('127.0.0.1')
  const [mqttPort, setMqttPort] = useState(1883)
  const [mqttPrefix, setMqttPrefix] = useState('wtcs')
  // 数据库
  const [dbConfig, setDbConfig] = useState<DatabaseConfig | null>(null)
  const [dbTestResult, setDbTestResult] = useState<DatabaseTestResult | null>(null)
  const [dbTesting, setDbTesting] = useState(false)
  const [dbSaving, setDbSaving] = useState(false)
  const [dbExporting, setDbExporting] = useState(false)
  // AI 与健康
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiInterval, setAiInterval] = useState(8)
  const [healthLearning, setHealthLearning] = useState(true)
  const [healthInterval, setHealthInterval] = useState(2)
  const [healthMinSamples, setHealthMinSamples] = useState(100)
  // 系统
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  // 统一确认弹窗（替代 window.confirm / window.prompt）
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirmLabel: string
    requireText?: string
    action: () => void | Promise<void>
  } | null>(null)

  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)

  const loadSettings = useCallback(async () => {
    const s = await api.settings()
    setSettings(s)
    // 注意：主题不随服务端设置应用——主题是本浏览器偏好（localStorage 为准），
    // 服务端的 theme 字段仅在"保存通用设置"时记录当前选择。
    setScenario(str(s.default_scenario, '气动实验'))
    setLanguage(str(s.language, 'zh'))
    setRefreshMs(num(s.large_screen_refresh_ms, 1000))
    setTelemetryHz(num(s.telemetry_hz, 10))
    setHistDays(num(s.history_retention_days, 30))
    setAuditDays(num(s.audit_retention_days, 180))
    setAlertRows(num(s.alert_retention_count, 5000))
    setAiEnabled(bool(s.ai_inspect_enabled, true))
    setAiInterval(num(s.ai_inspect_interval_sec, 8))
    setAutoBackup(bool(s.auto_backup_enabled, false))
    setBackupHours(num(s.auto_backup_interval_hours, 24))
    setHealthLearning(bool(s.health_learning_enabled, true))
    setHealthInterval(num(s.health_eval_interval_sec, 2))
    setHealthMinSamples(num(s.health_min_samples, 100))
    setMqttEnabled(bool(s.mqtt_enabled, false))
    setMqttHost(str(s.mqtt_host, '127.0.0.1'))
    setMqttPort(num(s.mqtt_port, 1883))
    setMqttPrefix(str(s.mqtt_topic_prefix, 'wtcs'))
  }, [])

  useEffect(() => {
    loadSettings().catch((e) => toast(String(e), false))
    api.systemInfo().then(setSysInfo).catch(() => {})
    api.systemNetwork().then(setNetwork).catch(() => {})
    api.systemStorage().then(setStorage).catch(() => {})
  }, [])

  // 备份列表需维护员+ 权限，customer 加载会 403
  useEffect(() => {
    if (tab === 'backup' && canEdit) {
      api.listBackups().then(setBackups).catch((e) => toast(String(e), false))
    }
  }, [tab, canEdit])

  useEffect(() => {
    if (tab === 'database') {
      api.databaseConfig().then(setDbConfig).catch((e) => toast(String(e), false))
    }
  }, [tab])

  async function save(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const next = await api.saveSettings(body)
      setSettings(next)
      toast('设置已保存')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', false)
    } finally {
      setSaving(false)
    }
  }

  function toggleForceSimulation() {
    const next = !bool(settings.force_simulation, true)
    setConfirm({
      title: '切换仿真模式',
      message: `确认${next ? '开启' : '关闭'}强制仿真？切换后将重建全部适配器连接，正在进行的链路会中断。`,
      confirmLabel: next ? '开启强制仿真' : '关闭强制仿真',
      action: async () => {
        await save({ force_simulation: next })
        const info = await api.systemInfo().catch(() => null)
        if (info) setSysInfo(info)
      },
    })
  }

  function cleanup() {
    setConfirm({
      title: '清理历史数据',
      message: '按当前保留策略立即清理历史 / 审计 / 告警数据？超出保留期的记录将被删除，不可恢复。',
      confirmLabel: '立即清理',
      action: async () => {
        try {
          const r = await api.systemCleanup()
          toast(`清理完成：${Object.entries(r.removed).map(([k, v]) => `${k} ${v}`).join('，') || '无数据需清理'}`)
          setStorage(await api.systemStorage())
        } catch (e) {
          toast(e instanceof Error ? e.message : '清理失败', false)
        }
      },
    })
  }

  async function createBackup() {
    try {
      const b = await api.createBackup()
      toast(`备份已创建：${b.name}`)
      setBackups(await api.listBackups())
    } catch (e) {
      toast(e instanceof Error ? e.message : '备份失败', false)
    }
  }

  function restoreBackup(name: string) {
    setConfirm({
      title: '恢复备份',
      message: `恢复将覆盖当前数据库（恢复前自动做一次安全备份）。\n目标备份：${name}`,
      confirmLabel: '恢复',
      requireText: '确认恢复',
      action: async () => {
        try {
          const r = await api.restoreBackup(name)
          toast(`已恢复 ${r.restored}；恢复前安全备份：${r.safety_backup}`)
        } catch (e) {
          toast(e instanceof Error ? e.message : '恢复失败', false)
        }
      },
    })
  }

  function deleteBackup(name: string) {
    setConfirm({
      title: '删除备份',
      message: `确认删除备份 ${name}？删除后无法用该备份恢复。`,
      confirmLabel: '删除',
      action: async () => {
        try {
          await api.deleteBackup(name)
          toast('备份已删除')
          setBackups(await api.listBackups())
        } catch (e) {
          toast(e instanceof Error ? e.message : '删除失败', false)
        }
      },
    })
  }

  async function testDbConnection() {
    if (!dbConfig) return
    setDbTesting(true)
    setDbTestResult(null)
    try {
      const result = await api.testDatabase(dbConfig)
      setDbTestResult(result)
    } catch (e) {
      setDbTestResult({ ok: false, error: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setDbTesting(false)
    }
  }

  function saveDbConfig() {
    if (!dbConfig) return
    setConfirm({
      title: '切换数据库',
      message: dbConfig.engine === 'sqlite'
        ? `确认切换至 SQLite：${dbConfig.path}？切换后当前连接将重建。`
        : `确认切换至 ${dbConfig.engine}：${dbConfig.host}:${dbConfig.port}/${dbConfig.database}？\n\n注意：远端数据库需提前完成数据迁移，否则将使用空库。`,
      confirmLabel: '确认切换',
      requireText: '确认切换',
      action: async () => {
        setDbSaving(true)
        try {
          const result = await api.updateDatabase(dbConfig)
          toast(result.message || '数据库配置已生效')
          const cfg = await api.databaseConfig()
          setDbConfig(cfg)
        } catch (e) {
          toast(e instanceof Error ? e.message : '切换失败', false)
        } finally {
          setDbSaving(false)
        }
      },
    })
  }

  function exportDbData() {
    setConfirm({
      title: '导出数据库',
      message: '将当前 SQLite 全部数据导出为 JSON（可用于迁移到远端数据库）。导出过程可能需要数秒，请耐心等待。',
      confirmLabel: '导出',
      action: async () => {
        setDbExporting(true)
        try {
          const data = await api.exportDatabase()
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `wtcs-export-${new Date().toISOString().slice(0, 10)}.json`
          document.body.appendChild(a)
          a.click()
          a.remove()
          URL.revokeObjectURL(url)
          toast('数据库导出完成')
        } catch (e) {
          toast(e instanceof Error ? e.message : '导出失败', false)
        } finally {
          setDbExporting(false)
        }
      },
    })
  }

  async function changePassword() {
    if (!oldPwd || !newPwd) {
      toast('请填写旧密码与新密码', false)
      return
    }
    if (newPwd.length < 6) {
      toast('新密码至少 6 位', false)
      return
    }
    try {
      await api.changePassword(oldPwd, newPwd)
      toast('密码已修改')
      setOldPwd('')
      setNewPwd('')
    } catch (e) {
      toast(e instanceof Error ? e.message : '修改失败', false)
    }
  }

  const ro = !canEdit // customer/operator 只读

  return (
    <div>
      <header className="page-head">
        <h1>系统设置</h1>
        <div className="page-head-side">
          {ro && <span className="badge warn">当前角色仅可查看，修改需维护员及以上权限</span>}
        </div>
      </header>
      {/* 设置搜索与分组导航 */}
      <div className="settings-search">
        <input
          type="search"
          placeholder="搜索设置项…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="tabs-nav" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'flex-end' }}>
        {TAB_GROUPS.map((group) => {
          const groupTabs = group.tabs.filter((t) => t.key !== 'users' && t.key !== 'feedback' || isAdmin)
          const q = search.trim().toLowerCase()
          const filtered = q
            ? groupTabs.filter((t) => {
                const label = TABS.find((x) => x.key === t.key)?.label ?? ''
                return label.toLowerCase().includes(q) || t.keywords.toLowerCase().includes(q)
              })
            : groupTabs
          if (!filtered.length) return null
          return (
            <div key={group.label} className="tabs-group">
              <div className="tabs-group-label">{group.label}</div>
              {filtered.map((t) => {
                const def = TABS.find((x) => x.key === t.key)!
                const active = tab === t.key
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`tab ${active ? 'active' : ''}`}
                    onClick={() => { setTab(t.key); setSearch('') }}
                  >
                    {def.label}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {tab === 'general' && (
        <div className="panel panel-narrow">
          <h2>通用</h2>
          <Row label="界面主题">
            <div className="theme-toggle">
              <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>深色</button>
              <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>浅色</button>
            </div>
          </Row>
          <Row label="默认场景">
            <select value={scenario} disabled={ro} onChange={(e) => setScenario(e.target.value)}>
              {SCENARIOS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Row>
          <Row label="界面语言">
            <select value={language} disabled={ro} onChange={(e) => setLanguage(e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English（仅存储，翻译后续阶段提供）</option>
            </select>
          </Row>
          <Row label="大屏刷新 (ms)">
            <input type="number" min={100} max={60000} disabled={ro} value={refreshMs} onChange={(e) => setRefreshMs(Number(e.target.value))} />
          </Row>
          <Row label="报警声音">
            <select
              value={alarmSound ? '1' : '0'}
              onChange={(e) => {
                const on = e.target.value === '1'
                setAlarmSound(on)
                localStorage.setItem(ALARM_SOUND_KEY, on ? '1' : '0')
                toast(on ? '报警声音已开启（本浏览器生效）' : '报警声音已关闭')
              }}
            >
              <option value="0">关闭</option>
              <option value="1">开启</option>
            </select>
          </Row>
          {canEdit && (
            <button className="btn primary" disabled={saving} onClick={() => save({ theme, default_scenario: scenario, language, large_screen_refresh_ms: refreshMs })}>
              保存通用设置
            </button>
          )}
        </div>
      )}

      {tab === 'general' && isAdmin && <BrandingPanel toast={toast} />}

      {tab === 'telemetry' && (
        <div className="layout-2">
          <div className="panel">
            <h2>遥测与保留策略</h2>
            <Row label="遥测频率 (Hz)">
              <input type="number" min={1} max={20} disabled={ro} value={telemetryHz} onChange={(e) => setTelemetryHz(Number(e.target.value))} />
            </Row>
            <Row label="历史保留 (天)">
              <input type="number" min={1} max={3650} disabled={ro} value={histDays} onChange={(e) => setHistDays(Number(e.target.value))} />
            </Row>
            <Row label="审计保留 (天)">
              <input type="number" min={1} max={3650} disabled={ro} value={auditDays} onChange={(e) => setAuditDays(Number(e.target.value))} />
            </Row>
            <Row label="告警保留 (条)">
              <input type="number" min={100} max={100000} disabled={ro} value={alertRows} onChange={(e) => setAlertRows(Number(e.target.value))} />
            </Row>
            {canEdit && (
              <button
                className="btn primary"
                disabled={saving}
                onClick={() =>
                  save({
                    telemetry_hz: telemetryHz,
                    history_retention_days: histDays,
                    audit_retention_days: auditDays,
                    alert_retention_count: alertRows,
                  })
                }
              >
                保存遥测与存储设置
              </button>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>存储占用</h2>
              {canEdit && <button className="btn danger" onClick={cleanup}>立即清理</button>}
            </div>
            {!storage ? (
              <div style={{ padding: '8px 0' }}>
                <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                <div className="skeleton skeleton-line" style={{ width: '80%' }} />
                <div className="skeleton skeleton-line" style={{ width: '45%' }} />
                <div className="skeleton skeleton-block" style={{ marginTop: 8, width: '40%' }} />
              </div>
            ) : (
              <>
                <div className="badge-row">
                  <span className="badge info">DB 文件 {fmtBytes(storage.db_file_bytes)}</span>
                  <span className="badge">WAL {fmtBytes(storage.wal_file_bytes)}</span>
                  <span className="badge">估算 {fmtBytes(storage.estimated_bytes)}</span>
                </div>
                <table className="table">
                  <thead>
                    <tr><th>表</th><th>行数</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(storage.tables).map(([t, n]) => (
                      <tr key={t}>
                        <td className="mono">{t}</td>
                        <td className="mono">{n < 0 ? '--' : n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'backup' && (
        <div className="layout-2">
          <div className="panel">
            <h2>自动备份</h2>
            <Row label="自动备份">
              <select disabled={ro} value={autoBackup ? '1' : '0'} onChange={(e) => setAutoBackup(e.target.value === '1')}>
                <option value="0">停用</option>
                <option value="1">启用</option>
              </select>
            </Row>
            <Row label="间隔 (小时)">
              <input type="number" min={1} max={720} disabled={ro} value={backupHours} onChange={(e) => setBackupHours(Number(e.target.value))} />
            </Row>
            {canEdit && (
              <div className="actions">
                <button className="btn primary" disabled={saving} onClick={() => save({ auto_backup_enabled: autoBackup, auto_backup_interval_hours: backupHours })}>
                  保存备份设置
                </button>
                <button className="btn" onClick={createBackup}>立即创建备份</button>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>备份列表</h2>
              {canEdit && <button className="btn" onClick={() => api.listBackups().then(setBackups).catch(() => {})}>刷新</button>}
            </div>
            {!canEdit ? (
              <div className="empty">备份管理需维护员及以上权限</div>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr><th>名称</th><th>大小</th><th>时间</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {(backups ?? []).map((b) => (
                      <tr key={b.name}>
                        <td className="mono">{b.name}</td>
                        <td className="mono">{fmtBytes(b.size_bytes)}</td>
                        <td className="mono">{b.created_at.replace('T', ' ').slice(0, 19)}</td>
                        <td>
                          <div className="actions actions-flush">
                            <button type="button" className="icon-btn" onClick={() => downloadBackupFile(b.name).catch((e) => toast(String(e), false))} title="下载备份文件">
                              <IconDownload size={16} />
                            </button>
                            {isAdmin && (
                              <button type="button" className="icon-btn danger" onClick={() => restoreBackup(b.name)} title="恢复该备份（覆盖当前库，需输入确认）">
                                <IconRestore size={16} />
                              </button>
                            )}
                            {isAdmin && (
                              <button type="button" className="icon-btn danger" onClick={() => deleteBackup(b.name)} title="删除该备份">
                                <IconTrash size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!backups?.length && (
                  <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <div className="empty-state-title">暂无备份</div>
                    <div className="empty-state-desc">可点击「立即创建备份」生成第一份系统备份</div>
                  </div>
                )}
                <div className="hint">恢复操作会先自动创建一份当前库的安全备份，再用所选备份替换。</div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'database' && (
        <div className="layout-2">
          <div className="panel">
            <h2>数据库配置</h2>
            {!dbConfig ? (
              <div style={{ padding: '8px 0' }}>
                <div className="skeleton skeleton-block" style={{ marginBottom: 12 }} />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line" />
              </div>
            ) : (
              <>
                <Row label="数据库引擎" tip="SQLite 适合单机部署，PostgreSQL/MySQL 适合多用户或云端部署">
                  <select
                    disabled={!isAdmin}
                    value={dbConfig.engine}
                    onChange={(e) => {
                      const engine = e.target.value as DatabaseConfig['engine']
                      setDbConfig({
                        ...dbConfig,
                        engine,
                        port: engine === 'postgresql' ? 5432 : engine === 'mysql' ? 3306 : dbConfig.port,
                      })
                      setDbTestResult(null)
                    }}
                  >
                    <option value="sqlite">SQLite（本地文件）</option>
                    <option value="postgresql">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                  </select>
                </Row>
                {dbConfig.engine === 'sqlite' ? (
                  <Row label="数据库路径" tip="相对于后端运行目录的路径">
                    <input
                      disabled={!isAdmin}
                      value={dbConfig.path}
                      onChange={(e) => setDbConfig({ ...dbConfig, path: e.target.value })}
                      placeholder="data/wtcs.db"
                    />
                  </Row>
                ) : (
                  <>
                    <Row label="主机地址" tip="IP 地址或域名，如 192.168.1.100">
                      <input
                        disabled={!isAdmin}
                        value={dbConfig.host}
                        onChange={(e) => setDbConfig({ ...dbConfig, host: e.target.value })}
                        placeholder="192.168.1.100"
                      />
                    </Row>
                    <Row label="端口" tip={dbConfig.engine === 'postgresql' ? 'PostgreSQL 默认 5432' : 'MySQL 默认 3306'}>
                      <input
                        type="number"
                        disabled={!isAdmin}
                        value={dbConfig.port}
                        onChange={(e) => setDbConfig({ ...dbConfig, port: Number(e.target.value) })}
                      />
                    </Row>
                    <Row label="用户名">
                      <input
                        disabled={!isAdmin}
                        value={dbConfig.username}
                        onChange={(e) => setDbConfig({ ...dbConfig, username: e.target.value })}
                        autoComplete="off"
                      />
                    </Row>
                    <Row label="密码">
                      <input
                        type="password"
                        disabled={!isAdmin}
                        value={dbConfig.password}
                        onChange={(e) => setDbConfig({ ...dbConfig, password: e.target.value })}
                        placeholder="留空保持不变"
                        autoComplete="new-password"
                      />
                    </Row>
                    <Row label="数据库名">
                      <input
                        disabled={!isAdmin}
                        value={dbConfig.database}
                        onChange={(e) => setDbConfig({ ...dbConfig, database: e.target.value })}
                        placeholder="wtcs"
                      />
                    </Row>
                    <Row label="连接池大小" tip="同时保持的最大连接数，一般 5-20 即可">
                      <input
                        type="number"
                        min={1}
                        max={50}
                        disabled={!isAdmin}
                        value={dbConfig.pool_size}
                        onChange={(e) => setDbConfig({ ...dbConfig, pool_size: Number(e.target.value) })}
                      />
                    </Row>
                    <Row label="SSL" tip="启用加密连接，云端数据库建议开启">
                      <select
                        disabled={!isAdmin}
                        value={dbConfig.ssl ? '1' : '0'}
                        onChange={(e) => setDbConfig({ ...dbConfig, ssl: e.target.value === '1' })}
                      >
                        <option value="0">关闭</option>
                        <option value="1">启用</option>
                      </select>
                    </Row>
                  </>
                )}

                {/* 连接测试结果卡片 */}
                {dbTestResult && (
                  <div className={`db-test-result ${dbTestResult.ok ? 'ok' : 'error'}`}>
                    <div className="db-test-result-header">
                      {dbTestResult.ok ? '✓' : '✗'}
                      {dbTestResult.ok ? '连接成功' : '连接失败'}
                    </div>
                    {dbTestResult.ok ? (
                      <dl className="db-test-result-details">
                        {dbTestResult.message && <><dt>信息:</dt><dd>{dbTestResult.message}</dd></>}
                        {dbTestResult.version && <><dt>版本:</dt><dd>{dbTestResult.version}</dd></>}
                        {dbTestResult.journal_mode && <><dt>日志模式:</dt><dd>{dbTestResult.journal_mode}</dd></>}
                        {dbTestResult.path && <><dt>路径:</dt><dd className="mono">{dbTestResult.path}</dd></>}
                      </dl>
                    ) : (
                      <div className="db-test-result-details">{dbTestResult.error}</div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn" disabled={dbTesting} onClick={testDbConnection}>
                    {dbTesting && <span className="spinner" style={{ marginRight: 6 }} />}
                    {dbTesting ? '测试中…' : '测试连接'}
                  </button>
                  {isAdmin && (
                    <button className="btn primary" disabled={dbSaving} onClick={saveDbConfig}>
                      {dbSaving && <span className="spinner" style={{ marginRight: 6 }} />}
                      {dbSaving ? '应用中…' : '保存并应用'}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="panel">
            <h2>数据迁移</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
              导出当前 SQLite 全部数据为 JSON 文件，可用于迁移到 PostgreSQL / MySQL 远端数据库。
            </p>
            {isAdmin && (
              <>
                <button className="btn" disabled={dbExporting} onClick={exportDbData}>
                  {dbExporting && <span className="spinner" style={{ marginRight: 6 }} />}
                  {dbExporting ? '导出中…' : '导出 SQLite 数据'}
                </button>
                {dbExporting && (
                  <div className="export-progress">
                    <div className="export-progress-bar">
                      <div className="export-progress-fill" style={{ width: '60%', animation: 'skeleton-shimmer 1.5s ease-in-out infinite' }} />
                    </div>
                    <div className="export-progress-text">正在导出数据，请稍候…</div>
                  </div>
                )}
              </>
            )}
            <div className="hint" style={{ marginTop: 12 }}>
              迁移步骤：1) 导出当前数据 → 2) 在远端库建表（参考 schema） → 3) 导入 JSON → 4) 切换数据库配置
            </div>
          </div>
        </div>
      )}

      {tab === 'network' && (
        <div className="layout-2">
          <div className="panel">
            <h2>网络信息（只读）</h2>
            {!network ? (
              <div style={{ padding: '8px 0' }}>
                <div className="skeleton skeleton-line" style={{ width: '70%' }} />
                <div className="skeleton skeleton-line" style={{ width: '55%' }} />
                <div className="skeleton skeleton-line" style={{ width: '65%' }} />
                <div className="skeleton skeleton-line" style={{ width: '50%' }} />
              </div>
            ) : (
              <table className="table">
                <tbody>
                  <tr><td>监听地址</td><td className="mono">{network.host}:{network.port}</td></tr>
                  <tr><td>API 基址</td><td className="mono">{network.api_base}</td></tr>
                  <tr><td>WS 遥测</td><td className="mono">{network.ws_telemetry}?token=…</td></tr>
                  <tr><td>CORS 来源</td><td className="mono">{network.cors_origins.join(', ') || '--'}</td></tr>
                  <tr><td>接口文档</td><td className="mono">{network.docs}</td></tr>
                </tbody>
              </table>
            )}
          </div>
          <div className="panel">
            <h2>MQTT 开放数据通道</h2>
            {settings.mqtt_available === false && (
              <div className="badge warn badge-block">后端未安装 paho-mqtt，MQTT 发布不可用（pip install paho-mqtt）</div>
            )}
            <Row label="启用 MQTT">
              <select disabled={ro || settings.mqtt_available === false} value={mqttEnabled ? '1' : '0'} onChange={(e) => setMqttEnabled(e.target.value === '1')}>
                <option value="0">停用</option>
                <option value="1">启用</option>
              </select>
            </Row>
            <Row label="Broker 地址">
              <input disabled={ro} value={mqttHost} onChange={(e) => setMqttHost(e.target.value)} />
            </Row>
            <Row label="端口">
              <input type="number" min={1} max={65535} disabled={ro} value={mqttPort} onChange={(e) => setMqttPort(Number(e.target.value))} />
            </Row>
            <Row label="Topic 前缀">
              <input disabled={ro} value={mqttPrefix} onChange={(e) => setMqttPrefix(e.target.value)} />
            </Row>
            {canEdit && (
              <button className="btn primary" disabled={saving} onClick={() => save({ mqtt_enabled: mqttEnabled, mqtt_host: mqttHost, mqtt_port: mqttPort, mqtt_topic_prefix: mqttPrefix })}>
                保存 MQTT 设置
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'ai' && (
        <div className="panel panel-narrow">
          <h2>AI 巡检与健康基线</h2>
          <Row label="AI 巡检">
            <select disabled={ro} value={aiEnabled ? '1' : '0'} onChange={(e) => setAiEnabled(e.target.value === '1')}>
              <option value="1">启用</option>
              <option value="0">停用</option>
            </select>
          </Row>
          <Row label="巡检间隔 (s)">
            <input type="number" min={2} max={3600} disabled={ro} value={aiInterval} onChange={(e) => setAiInterval(Number(e.target.value))} />
          </Row>
          <Row label="健康基线学习">
            <select disabled={ro} value={healthLearning ? '1' : '0'} onChange={(e) => setHealthLearning(e.target.value === '1')}>
              <option value="1">启用</option>
              <option value="0">停用</option>
            </select>
          </Row>
          <Row label="健康评估周期 (s)">
            <input type="number" min={1} max={60} disabled={ro} value={healthInterval} onChange={(e) => setHealthInterval(Number(e.target.value))} />
          </Row>
          <Row label="基线最小样本数">
            <input type="number" min={5} max={10000} disabled={ro} value={healthMinSamples} onChange={(e) => setHealthMinSamples(Number(e.target.value))} />
          </Row>
          {canEdit && (
            <button
              className="btn primary"
              disabled={saving}
              onClick={() =>
                save({
                  ai_inspect_enabled: aiEnabled,
                  ai_inspect_interval_sec: aiInterval,
                  health_learning_enabled: healthLearning,
                  health_eval_interval_sec: healthInterval,
                  health_min_samples: healthMinSamples,
                })
              }
            >
              保存 AI 与健康设置
            </button>
          )}
        </div>
      )}

      {tab === 'system' && (
        <div className="layout-2">
          <div className="panel">
            <div className="panel-head">
              <h2>系统信息</h2>
              <button className="btn" onClick={() => api.systemInfo().then(setSysInfo).catch(() => {})}>刷新</button>
            </div>
            {!sysInfo ? (
              <div style={{ padding: '8px 0' }}>
                <div className="skeleton skeleton-line" style={{ width: '75%' }} />
                <div className="skeleton skeleton-line" style={{ width: '60%' }} />
                <div className="skeleton skeleton-line" style={{ width: '50%' }} />
                <div className="skeleton skeleton-line" style={{ width: '65%' }} />
              </div>
            ) : (
              <table className="table">
                <tbody>
                  <tr><td>名称 / 版本</td><td>{sysInfo.app_name} · v{sysInfo.version}（应用 {sysInfo.app_version}）</td></tr>
                  <tr><td>启动时间</td><td className="mono">{sysInfo.started_at?.replace('T', ' ') ?? '--'}</td></tr>
                  <tr><td>运行时长</td><td>{fmtUptime(sysInfo.uptime_seconds)}</td></tr>
                  <tr><td>Python</td><td className="mono">{sysInfo.python_version}</td></tr>
                  <tr><td>仿真 / 真机</td><td>{sysInfo.simulation_count} / {sysInfo.real_count}</td></tr>
                  <tr><td>强制仿真</td><td>{sysInfo.force_simulation ? '开启' : '关闭'}</td></tr>
                </tbody>
              </table>
            )}
            <div className="danger-zone">
              <div className="danger-zone-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                系统模式切换
              </div>
              <div className="danger-zone-desc">
                切换将重建全部适配器连接，可能影响正在运行的实验。真机接入还需 backend/config/subsystems.yaml 配置 endpoint 与 mode=real。
              </div>
              <div className="actions actions-flush">
                <span className={`badge ${bool(settings.force_simulation, true) ? 'warn' : 'ok'}`}>
                  当前：{bool(settings.force_simulation, true) ? '强制仿真' : '允许真机'}
                </span>
                {canEdit && (
                  <button className="btn danger" onClick={toggleForceSimulation}>
                    切换为{bool(settings.force_simulation, true) ? '允许真机' : '强制仿真'}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="panel">
            <h2>修改密码</h2>
            <Row label="旧密码">
              <input
                type="password"
                className={oldPwd.length > 0 && oldPwd.length < 6 ? 'input-error' : ''}
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                autoComplete="current-password"
              />
            </Row>
            <Row label="新密码">
              <input
                type="password"
                className={newPwd.length > 0 && newPwd.length < 6 ? 'input-error' : ''}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                autoComplete="new-password"
                placeholder="至少 6 位"
              />
              {newPwd.length > 0 && newPwd.length < 6 && (
                <div className="field-error">新密码至少 6 位</div>
              )}
            </Row>
            <button
              className="btn primary"
              disabled={!oldPwd || newPwd.length < 6}
              onClick={changePassword}
            >
              修改密码
            </button>
          </div>
        </div>
      )}

      {tab === 'users' && isAdmin && <UsersRolesPanel toast={toast} />}
      {tab === 'feedback' && isAdmin && <FeedbackPanel toast={toast} />}

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.action
          setConfirm(null)
          if (action) void action()
        }}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel}
        requireText={confirm?.requireText}
        danger
      />
    </div>
  )
}
