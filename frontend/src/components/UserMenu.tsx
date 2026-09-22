import { useEffect, useRef, useState } from 'react'
import { api, type UserInfo } from '../api'
import { CONTROL_STYLES } from '../constants'
import { useTheme } from '../theme'
import { Modal } from './Modal'
import { IconFullscreen, IconFullscreenExit, IconUser } from './icons'

/** 全屏切换（等同 F11）：进入/退出浏览器全屏，图标随状态变化 */
export function FullscreenButton() {
  const [full, setFull] = useState(!!document.fullscreenElement)

  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      /* 浏览器拒绝（如非用户手势触发）时静默 */
    }
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      title={full ? '退出全屏（Esc）' : '全屏显示（等同 F11）'}
      aria-label={full ? '退出全屏' : '全屏显示'}
    >
      {full ? <IconFullscreenExit size={16} /> : <IconFullscreen size={16} />}
    </button>
  )
}

/**
 * 用户菜单：头像按钮合并原「用户名徽标 + 退出按钮」，
 * 下拉提供 个人信息 / 更改密码 / 注销。
 */
export function UserMenu({
  user,
  onLogout,
  toast,
}: {
  user: UserInfo
  onLogout: () => void
  toast: (msg: string, ok?: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const { theme, setTheme, ctlStyle, setCtlStyle } = useTheme()
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击菜单外 / Esc 关闭下拉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className={`user-menu-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="账户菜单"
      >
        <IconUser size={16} />
        <span className="user-menu-name">{user.display_name}</span>
      </button>

      {open && (
        <div className="user-menu-pop" role="menu">
          <div className="user-menu-head">
            <span className="user-menu-display">{user.display_name}</span>
            <span className="badge info">{user.role}</span>
          </div>

          <div className="user-menu-sec">
            <div className="label-cap">界面主题</div>
            <div className="theme-toggle user-menu-themes">
              <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>深色</button>
              <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>浅色</button>
            </div>
          </div>
          <div className="user-menu-sec">
            <div className="label-cap">控件风格</div>
            <div className="user-menu-styles">
              {CONTROL_STYLES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`user-menu-style${ctlStyle === s.key ? ' active' : ''}`}
                  title={s.hint}
                  onClick={() => setCtlStyle(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="user-menu-divider" />
          <button type="button" role="menuitem" className="user-menu-item" onClick={() => { setOpen(false); setProfileOpen(true) }}>
            个人信息
          </button>
          <button type="button" role="menuitem" className="user-menu-item" onClick={() => { setOpen(false); setPwdOpen(true) }}>
            更改密码
          </button>
          <button type="button" role="menuitem" className="user-menu-item user-menu-item--danger" onClick={onLogout}>
            注销
          </button>
        </div>
      )}

      <Modal open={profileOpen} onClose={() => setProfileOpen(false)} title="个人信息" size="sm">
        <div className="profile-grid">
          <span className="label-cap">用户名</span>
          <span className="mono">{user.username}</span>
          <span className="label-cap">显示名</span>
          <span>{user.display_name}</span>
          <span className="label-cap">角色</span>
          <span className="badge info">{user.role}</span>
        </div>
      </Modal>

      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} toast={toast} />
    </div>
  )
}

function ChangePasswordModal({
  open,
  onClose,
  toast,
}: {
  open: boolean
  onClose: () => void
  toast: (msg: string, ok?: boolean) => void
}) {
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [newPwd2, setNewPwd2] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开清空表单
  useEffect(() => {
    if (open) {
      setOldPwd('')
      setNewPwd('')
      setNewPwd2('')
    }
  }, [open])

  const mismatch = newPwd2 !== '' && newPwd !== newPwd2
  const canSubmit = !!oldPwd && newPwd.length >= 6 && newPwd === newPwd2 && !busy

  async function submit() {
    setBusy(true)
    try {
      await api.changePassword(oldPwd, newPwd)
      toast('密码已修改，下次登录请使用新密码')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : '密码修改失败', false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="更改密码"
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? '提交中…' : '确认修改'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>原密码</label>
        <input type="password" autoFocus value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoComplete="current-password" />
      </div>
      <div className="form-row">
        <label>新密码（至少 6 位）</label>
        <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="form-row">
        <label>确认新密码</label>
        <input type="password" value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)} autoComplete="new-password" />
      </div>
      {mismatch && <div className="hint" style={{ color: 'var(--danger)' }}>两次输入的新密码不一致</div>}
    </Modal>
  )
}
