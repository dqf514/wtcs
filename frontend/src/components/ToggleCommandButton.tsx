import { useState } from 'react'
import { ConfirmModal } from './Modal'
import { IconPlay, IconStop } from './icons'

interface ToggleCommandButtonProps {
  /** 当前运行状态：true 运行中 / false 停止 / null 未知（按停止态展示） */
  running: boolean | null
  /** 停止态按钮文案，如「启动风机」 */
  startLabel: string
  /** 运行态按钮文案，如「停止风机」 */
  stopLabel: string
  /** 弹窗中补充说明（停止时的影响等） */
  stopHint?: string
  disabled?: boolean
  onStart: () => void
  onStop: () => void
}

/**
 * 启停合一命令按钮：非运行态点击=启动、运行态点击=停止。
 * 启动/停止都必须经过显著弹窗确认（停止为 danger 强调），不用行内二次点击。
 */
export function ToggleCommandButton({
  running,
  startLabel,
  stopLabel,
  stopHint,
  disabled,
  onStart,
  onStop,
}: ToggleCommandButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const isRunning = running === true
  const label = isRunning ? stopLabel : startLabel

  return (
    <>
      <button
        type="button"
        className={`ctl-btn ctl-btn--toggle ${isRunning ? 'danger' : 'primary'}`}
        disabled={disabled}
        title={isRunning ? `${stopLabel}（当前：运行中）` : `${startLabel}（当前：${running === null ? '状态未知' : '停止'}）`}
        onClick={() => setConfirming(true)}
      >
        {isRunning ? <IconStop size={22} /> : <IconPlay size={22} />}
        <span className="label-cap">{label}</span>
      </button>
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          if (isRunning) onStop()
          else onStart()
        }}
        title={label}
        danger={isRunning}
        confirmLabel={label}
        message={
          isRunning
            ? `确认${stopLabel}？${stopHint ?? '设备将停止运行。'}`
            : `确认${startLabel}？`
        }
      />
    </>
  )
}
