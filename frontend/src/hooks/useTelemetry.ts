import { useEffect, useRef, useState } from 'react'
import { getToken, setToken, setCurrentUser, type AiAlert, type Overview, type SequenceExecution, type SubsystemStatus, type SystemStateInfo } from '../api'

export interface TelemetryFrame {
  overview: Overview
  subsystems: SubsystemStatus[]
  ai_alerts?: AiAlert[]
  /** 系统级状态机（待机/准备中/就绪/运行中/停车中/急停/安全异常） */
  system_state?: SystemStateInfo
  /** 进行中或最近一次的启停序列执行 */
  sequence_exec?: SequenceExecution | null
  server_time: string
}

export function useTelemetry() {
  const [frame, setFrame] = useState<TelemetryFrame | null>(null)
  const [connected, setConnected] = useState(false)
  const retryRef = useRef(0)

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let timer: number | undefined

    const connect = () => {
      const token = getToken()
      if (!token) return // 未登录不连接；登录后组件会重新挂载
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/ws/telemetry?token=${encodeURIComponent(token)}`)
      ws.onopen = () => {
        setConnected(true)
        retryRef.current = 0
      }
      ws.onmessage = (ev) => {
        try {
          setFrame(JSON.parse(ev.data))
        } catch {
          /* ignore */
        }
      }
      ws.onclose = (ev) => {
        setConnected(false)
        if (ev.code === 4401) {
          // token 失效：清登录态，回到登录页
          setToken(null)
          setCurrentUser(null)
          window.dispatchEvent(new Event('wtcs:unauthorized'))
          return
        }
        if (!closed) {
          const delay = Math.min(5000, 500 * 2 ** retryRef.current)
          retryRef.current += 1
          timer = window.setTimeout(connect, delay)
        }
      }
    }
    connect()
    return () => {
      closed = true
      if (timer) window.clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { frame, connected }
}
