import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconClose } from './icons'

export type ModalSize = 'sm' | 'md' | 'lg'

/**
 * 统一弹窗：遮罩 + 居中实色面板（--r 3px、1px 边框、浮层阴影）。
 * Esc 关闭、可选点遮罩关闭、焦点圈定、打开时锁 body 滚动。
 * 外层按 open 挂载/卸载，保证每次打开焦点与滚动态都是全新的。
 */
export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  children,
  footer,
  closeOnOverlay = true,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  size?: ModalSize
  children: ReactNode
  footer?: ReactNode
  closeOnOverlay?: boolean
}) {
  if (!open) return null
  return (
    <ModalInner
      onClose={onClose}
      title={title}
      size={size}
      footer={footer}
      closeOnOverlay={closeOnOverlay}
    >
      {children}
    </ModalInner>
  )
}

function ModalInner({
  onClose,
  title,
  size,
  children,
  footer,
  closeOnOverlay,
}: {
  onClose: () => void
  title: ReactNode
  size: ModalSize
  children: ReactNode
  footer?: ReactNode
  closeOnOverlay: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // 锁 body 滚动 + Esc 关闭 + 焦点圈定
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // 面板内已有 autofocus 目标（如确认输入框）时不抢焦点
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && activeEl === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="modal-overlay"
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="label-cap modal-title">{title}</span>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * 统一确认弹窗（替代 window.confirm/prompt）：
 * danger 操作红色强调 + 明确后果文案；requireText 用于高危操作（输入指定文字才能确认）。
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = '确认',
  danger = false,
  requireText,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: ReactNode
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  requireText?: string
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" closeOnOverlay={false}>
      {open && (
        <ConfirmBody
          message={message}
          confirmLabel={confirmLabel}
          danger={danger}
          requireText={requireText}
          onCancel={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  )
}

function ConfirmBody({
  message,
  confirmLabel,
  danger,
  requireText,
  onCancel,
  onConfirm,
}: {
  message: ReactNode
  confirmLabel: string
  danger: boolean
  requireText?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const blocked = requireText ? typed !== requireText : false

  return (
    <div>
      <div className={`confirm-msg${danger ? ' confirm-msg--danger' : ''}`}>{message}</div>
      {requireText && (
        <div className="form-row">
          <label>
            输入「{requireText}」以继续
          </label>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={requireText} />
        </div>
      )}
      <div className="actions actions-end">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={blocked}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
