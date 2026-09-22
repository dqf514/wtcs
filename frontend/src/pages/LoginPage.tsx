import { useEffect, useState, type FormEvent } from 'react'
import { api, setToken, type UserInfo } from '../api'
import { useBranding } from '../hooks/useBranding'
import { useTheme } from '../theme'

// 测试期账号（与后端默认账号一致），上线前移除本区块
const TEST_ACCOUNTS = [
  { username: 'operator', password: 'wtcs123', label: '操作员' },
  { username: 'maintainer', password: 'wtcs123', label: '维护员' },
  { username: 'admin', password: 'wtcs123', label: '管理员' },
  { username: 'customer', password: 'wtcs123', label: '客户' },
]

export function LoginPage({ onLogin }: { onLogin: (user: UserInfo) => void }) {
  const { theme, setTheme } = useTheme()
  const branding = useBranding()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // 登录前无 token：只能用公开的 /api/health 派生系统状态行
  const [health, setHealth] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { status?: string; message?: string }) => setHealth(d.message || '服务在线'))
      .catch(() => setHealth(''))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.login(username, password)
      setToken(res.access_token)
      onLogin(res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-wrap">
        <form className="login-card" onSubmit={submit}>
          <img src={branding.logo_url} className="login-logo" alt="HMVIC" />
          <div className="panel-head">
            <h1 className="login-title">WTCS · 合肥汽车风洞</h1>
            <div className="theme-toggle">
              <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>深色</button>
              <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>浅色</button>
            </div>
          </div>
          <p className="login-sub">风洞测控系统 · 操作员登录</p>
          <div className="login-quickfill">
            <span className="label-cap">测试账号</span>
            <div className="login-quickfill-row">
              {TEST_ACCOUNTS.map((a) => (
                <button
                  key={a.username}
                  type="button"
                  className={`btn login-quickfill-btn ${username === a.username ? 'active' : ''}`}
                  title={`${a.username} / ${a.password}`}
                  onClick={() => {
                    setUsername(a.username)
                    setPassword(a.password)
                    setError('')
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>账号</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="form-row">
            <label>密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <div className="badge danger badge-block">{error}</div>}
          <button className="btn primary btn-block" type="submit" disabled={loading}>
            {loading ? '登录中…' : '进入系统'}
          </button>
        </form>
        <div className="login-status">
          <i className={`status-dot ${health ? '' : 'down'}`} />
          {health === null ? '正在检测服务…' : health === '' ? '服务不可达 · 请检查后端进程' : `${health} · 建设期全仿真`}
        </div>
      </div>
    </div>
  )
}
