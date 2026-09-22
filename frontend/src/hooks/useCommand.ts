import { useCallback, useEffect, useRef } from 'react'
import { api } from '../api'

/**
 * 命令下发。确认交互由调用方的弹窗完成（ToggleCommandButton / CommandButton confirmMessage）；
 * 后端的 confirm_token 协议在本层透明完成：仅当 opts.confirmed=true（用户已在弹窗确认）时自动携带令牌重发，
 * 否则拒绝执行并提示——防止未弹窗的代码路径绕过确认。
 */
export function useCommand(toast: (msg: string, ok?: boolean) => void) {
  const toastRef = useRef(toast)

  useEffect(() => {
    toastRef.current = toast
  }, [toast])

  const send = useCallback(
    async (
      subsystem_id: string,
      command: string,
      params: Record<string, unknown> = {},
      opts?: { confirmed?: boolean },
    ) => {
      try {
        let res = await api.command({ subsystem_id, command, params })
        if (!res.ok && res.message.includes('confirm_token')) {
          if (!opts?.confirmed) {
            toastRef.current('该指令需经弹窗确认后执行', false)
            return false
          }
          const token = res.message.split('重发: ').pop()?.trim()
          if (!token) {
            toastRef.current(res.message, false)
            return false
          }
          res = await api.command({ subsystem_id, command, params, confirm_token: token })
        }
        toastRef.current(res.message, res.ok)
        return res.ok
      } catch (err) {
        toastRef.current(err instanceof Error ? err.message : '指令失败', false)
        return false
      }
    },
    [],
  )

  return { send }
}
