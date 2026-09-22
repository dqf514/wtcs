import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import { Modal } from './Modal'
import { IconClose, IconFeedback, IconPlus } from './icons'

/** 截图大小上限（与后端一致）：5MB */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * 全站反馈入口：右下角悬浮「?」按钮 + 反馈弹窗。
 * 截图支持：点击选择文件 / 直接 Ctrl+V 粘贴（弹窗打开期间全局监听）。
 * 提交间隔由服务端强制 5 分钟，429 时把服务端提示原样 toast 出来。
 * 挂载方负责在登录页 / kiosk 大屏不渲染本组件。
 */
export function FeedbackWidget({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [email, setEmail] = useState('')
  // 截图与其 blob 预览 URL 成对存放，替换/清除时同步 revoke
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null)
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const pickImage = useCallback(
    (file: File) => {
      if (file.size > MAX_IMAGE_BYTES) {
        toast('截图不能超过 5MB', false)
        return
      }
      setShot((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { file, url: URL.createObjectURL(file) }
      })
    },
    [toast],
  )

  function clearShot() {
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }

  // 弹窗打开期间监听全局粘贴，直接贴截图
  useEffect(() => {
    if (!open) return
    const onPaste = (e: globalThis.ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      pickImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open, pickImage])

  function reset() {
    setContent('')
    setEmail('')
    clearShot()
    setSending(false)
  }

  function close() {
    if (sending) return
    setOpen(false)
    reset()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (sending) return
    setSending(true)
    try {
      await api.submitFeedback({
        content,
        email,
        page_url: location.pathname + location.search,
        screenshot: shot?.file ?? null,
      })
      toast('反馈已提交，感谢你的建议')
      setOpen(false)
      reset()
    } catch (err) {
      // 429 等场景直接展示服务端提示（含剩余冷却时间）
      toast(err instanceof ApiError ? err.message : '提交失败，请稍后再试', false)
      setSending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="feedback-fab"
        onClick={() => setOpen(true)}
        title="问题反馈"
        aria-label="问题反馈"
      >
        <IconFeedback size={20} />
      </button>

      <Modal
        open={open}
        onClose={close}
        size="md"
        title={
          <>
            有什么想反馈的
            <div className="hint" style={{ marginTop: 4 }}>
              告诉我们你遇到的问题或建议，这些信息将用于改进 WTCS。提交间隔为 5 分钟。
            </div>
          </>
        }
        footer={
          <>
            <button className="btn" onClick={close} disabled={sending}>取消</button>
            <button className="btn primary" form="wtcs-feedback" type="submit" disabled={sending}>
              {sending ? '发送中…' : '发送反馈'}
            </button>
          </>
        }
      >
        <form id="wtcs-feedback" onSubmit={submit}>
          <div className="form-row form-row--top">
            <label>问题或建议（必填）</label>
            <textarea
              rows={5}
              autoFocus
              required
              maxLength={2000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="描述你看到了什么、期望发生什么，以及可以稳定复现的操作步骤"
            />
          </div>

          <div className="form-row form-row--top">
            <label>屏幕截图</label>
            <div className="feedback-shots">
              {shot && (
                <span className="feedback-shot">
                  <img src={shot.url} alt="截图预览" />
                  <button
                    type="button"
                    className="feedback-shot-remove"
                    onClick={clearShot}
                    title="移除截图"
                    aria-label="移除截图"
                  >
                    <IconClose size={12} />
                  </button>
                </span>
              )}
              {!shot && (
                <button
                  type="button"
                  className="feedback-shot-add"
                  onClick={() => fileRef.current?.click()}
                >
                  <IconPlus size={20} />
                  <span>添加或粘贴截图</span>
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) pickImage(f)
                  e.target.value = ''
                }}
              />
            </div>
          </div>

          <div className="form-row">
            <label>联系邮箱（可选）</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="便于我们联系你进一步了解问题"
            />
          </div>
        </form>
      </Modal>
    </>
  )
}
