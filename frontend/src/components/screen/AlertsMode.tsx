import { useMemo } from 'react'
import type { AiAlert, AlertSummary } from '../../api'
import { Chart } from '../Chart'
import { buildDailyAlertsOption } from './charts'
import { fmtDuration, useNow } from './config'

interface Props {
  /** 活动且未确认告警 */
  alerts: AiAlert[]
  summary: AlertSummary | null
  /** 近 7 天告警分布（statsOverview.alerts.by_day） */
  daily: { day: string; count: number }[]
  scale: number
}

const SEV_DEFS = [
  { key: 'critical', label: '严重', cls: 'danger' },
  { key: 'alarm', label: '报警', cls: 'danger' },
  { key: 'warning', label: '预警', cls: 'warn' },
  { key: 'info', label: '提示', cls: 'info' },
] as const

const SEV_RANK: Record<string, number> = { critical: 0, alarm: 1, warning: 2, info: 3 }

/** alerts 告警态势：分级大数字 + 近 7 天分布柱图 + 活动告警大表格（超出省略，不出现滚动条） */
export function AlertsMode({ alerts, summary, daily, scale }: Props) {
  const now = useNow()
  const sorted = useMemo(
    () =>
      [...alerts].sort((a, b) => {
        const r = (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
        return r !== 0 ? r : b.ts.localeCompare(a.ts)
      }),
    [alerts],
  )
  const barOption = useMemo(() => buildDailyAlertsOption(daily, scale), [daily, scale])

  return (
    <div className="al-root">
      <div className="al-left">
        <div className="al-counts">
          {SEV_DEFS.map((s) => (
            <div className={`al-count al-count--${s.cls}`} key={s.key}>
              <div className="al-count-num mono">{summary?.[s.key] ?? 0}</div>
              <div className="al-count-label">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="scr-panel">
          <div className="scr-panel-head">
            <span className="scr-panel-title">近 7 天告警分布</span>
          </div>
          <div className="scr-panel-body">
            <Chart option={barOption} className="scr-chart" />
          </div>
        </div>
      </div>

      <div className="scr-panel">
        <div className="scr-panel-head">
          <span className="scr-panel-title">当前活动告警（未确认）</span>
          <span className="scr-panel-side mono">共 {alerts.length} 条</span>
        </div>
        <div className="al-table-wrap">
          {sorted.length === 0 ? (
            <div className="al-empty">当前无活动告警 · 系统运行正常</div>
          ) : (
            <table className="al-table">
              <thead>
                <tr>
                  <th>级别</th>
                  <th>子系统</th>
                  <th>内容</th>
                  <th>持续</th>
                  <th>次数</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 12).map((a) => {
                  const sev = SEV_DEFS.find((s) => s.key === a.severity) ?? SEV_DEFS[3]
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className={`al-sev al-sev--${sev.cls}`}>{sev.label}</span>
                      </td>
                      <td className="al-sub">{a.subsystem_name}</td>
                      <td className="al-msg">{a.message}</td>
                      <td className="mono">{fmtDuration(a.ts, now)}</td>
                      <td className="mono">{a.count}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {sorted.length > 12 && <div className="al-more">其余 {sorted.length - 12} 条从略</div>}
        </div>
      </div>
    </div>
  )
}
