import { fmtClock, MODE_LABEL, useNow, type ScreenMode, type Tone } from './config'
import { useBranding } from '../../hooks/useBranding'

interface Props {
  mode: ScreenMode
  rotating: boolean
  safety: string
  tone: Tone
  /** 未确认告警总数；0 时不显示徽标 */
  alertTotal: number
}

/** 大屏顶栏：品牌 Logo + 系统名 + 模式 + 安全状态徽标 + 未确认告警徽标 + 大字时钟（纯展示） */
export function ScreenHeader({ mode, rotating, safety, tone, alertTotal }: Props) {
  const now = useNow()
  const { time, date } = fmtClock(now)
  const branding = useBranding()
  return (
    <header className="screen-header">
      <div className="screen-title">
        <img className="screen-logo" src={branding.mark_url} alt="" />
        合肥汽车风洞 · WTCS
        <span className="screen-title-sub">
          测控运行大屏 · {MODE_LABEL[mode]}
          {rotating ? ' · 自动轮换' : ''}
        </span>
      </div>
      <div className="screen-header-side">
        {alertTotal > 0 && <span className="screen-badge screen-badge--danger">未确认告警 {alertTotal}</span>}
        <span className={`screen-badge screen-badge--${tone}`}>安全态 · {safety}</span>
        <div className="screen-clock">
          <div className="screen-clock-time mono">{time}</div>
          <div className="screen-clock-date">{date}</div>
        </div>
      </div>
    </header>
  )
}
