import { useState, type ReactNode } from 'react'
import { ConfirmModal } from './Modal'

interface CommandButtonProps {
  onClick: () => void
  variant?: 'primary' | 'danger' | ''
  disabled?: boolean
  title?: string
  /** 传入图标后渲染为大图标按钮（.ctl-btn：图标在上 + .label-cap 标签在下） */
  icon?: ReactNode
  /** 弹窗确认文案；传入后点击先弹确认框，确认后才执行 onClick */
  confirmMessage?: string
  /** 确认弹窗标题（缺省用 children 文本） */
  confirmTitle?: string
  /** 确认弹窗用 danger 强调（停止、复位等有后果的操作） */
  confirmDanger?: boolean
  children: ReactNode
}

/**
 * 标准化命令按钮：点击直接执行；传入 confirmMessage 时先弹显著确认框。
 * （旧的行内"武装/二次点击"机制已移除，确认交互统一为弹窗。）
 */
export function CommandButton({
  onClick,
  variant = '',
  disabled,
  title,
  icon,
  confirmMessage,
  confirmTitle,
  confirmDanger,
  children,
}: CommandButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const labelText = typeof children === 'string' ? children : undefined

  const handleClick = () => {
    if (confirmMessage) setConfirming(true)
    else onClick()
  }

  const modal = (
    <ConfirmModal
      open={confirming}
      onClose={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false)
        onClick()
      }}
      title={confirmTitle ?? labelText ?? '确认执行'}
      danger={confirmDanger ?? variant === 'danger'}
      confirmLabel={labelText ?? '确认执行'}
      message={confirmMessage ?? ''}
    />
  )

  if (icon) {
    return (
      <>
        <button
          type="button"
          className={`ctl-btn ${variant}`.trim()}
          disabled={disabled}
          title={title}
          onClick={handleClick}
        >
          {icon}
          <span className="label-cap">{children}</span>
        </button>
        {modal}
      </>
    )
  }
  return (
    <>
      <button type="button" className={`btn ${variant}`.trim()} disabled={disabled} title={title} onClick={handleClick}>
        {children}
      </button>
      {modal}
    </>
  )
}
