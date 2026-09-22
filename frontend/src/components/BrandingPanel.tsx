import { useEffect, useRef, useState } from 'react'
import { api, type BrandingInfo, type BrandingKind } from '../api'

const KINDS: { kind: BrandingKind; title: string; usage: string }[] = [
  { kind: 'logo', title: '完整 Logo', usage: '登录页及对外展示场景使用，竖版/横版带文字均可' },
  { kind: 'mark', title: '图标 Logo', usage: '侧栏左上角、大屏顶栏、浏览器页签图标使用，建议方形图案' },
]

/**
 * 品牌标识管理（仅管理员）：上传后全站所有展示位立即生效；
 * 自定义文件存后端 data/branding/，恢复默认即删除自定义文件回退内置图。
 */
export function BrandingPanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [info, setInfo] = useState<BrandingInfo | null>(null)
  const [busy, setBusy] = useState<BrandingKind | null>(null)
  const fileRefs = useRef<Record<BrandingKind, HTMLInputElement | null>>({ logo: null, mark: null })

  useEffect(() => {
    api.branding().then(setInfo).catch(() => {})
  }, [])

  async function upload(kind: BrandingKind, file: File) {
    setBusy(kind)
    try {
      setInfo(await api.uploadBranding(kind, file))
      toast('Logo 已更新，全站展示位即时生效')
    } catch (err) {
      toast(err instanceof Error ? err.message : '上传失败', false)
    } finally {
      setBusy(null)
      const input = fileRefs.current[kind]
      if (input) input.value = ''
    }
  }

  async function reset(kind: BrandingKind) {
    setBusy(kind)
    try {
      setInfo(await api.resetBranding(kind))
      toast('已恢复默认 Logo')
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel panel-narrow">
      <h2>品牌标识</h2>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        建议使用透明背景 PNG，单张不超过 5MB；上传后登录页、侧栏、大屏、页签图标等所有展示位自动更新。
      </p>
      <div className="branding-cards">
        {KINDS.map(({ kind, title, usage }) => {
          const url = info ? (kind === 'logo' ? info.logo_url : info.mark_url) : ''
          const isCustom = info?.custom[kind]
          return (
            <div key={kind} className="branding-card">
              <div className="branding-preview">
                {url && <img src={url} alt={title} />}
              </div>
              <div className="branding-meta">
                <strong>{title}</strong>
                <span className="muted">{usage}</span>
                <span className={`badge ${isCustom ? 'ok' : ''}`}>{isCustom ? '自定义' : '默认'}</span>
              </div>
              <div className="branding-actions">
                <input
                  ref={(el) => {
                    fileRefs.current[kind] = el
                  }}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void upload(kind, f)
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy !== null}
                  onClick={() => fileRefs.current[kind]?.click()}
                >
                  {busy === kind ? '处理中…' : '上传替换'}
                </button>
                {isCustom && (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => reset(kind)}>
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
