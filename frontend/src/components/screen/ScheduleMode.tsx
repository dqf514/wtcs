import { useEffect, useMemo, useState } from 'react'
import { api, type ScheduleDisplay, type ScheduleDisplayItem } from '../../api'
import { fmtClock, useNow } from './config'

interface Props {
  /** 1 = 客户等候区（服务端已去标识化，仅排队号/时间窗/状态/资源）；0 = 控制室（含项目/订单名） */
  privacy: 0 | 1
}

/** 轮询周期：排队公示 20s 足够（排程是分钟级数据） */
const POLL_MS = 20000
/** 今日列表最多上屏行数，超出从略（大屏不出滚动条） */
const MAX_TODAY_ROWS = 8
const MAX_LATER_ROWS = 6

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function hm(iso: string): string {
  return iso.slice(11, 16)
}

const STATUS_CLS: Record<string, string> = {
  等待中: 'wait',
  准备中: 'prep',
  试验中: 'run',
  已完成: 'done',
}

function statusCls(status: string): string {
  return STATUS_CLS[status] ?? 'wait'
}

/**
 * schedule 排程展示大屏（对标候诊叫号屏）：
 * 今日排队列表为主体，排队号超大字；试验中行高亮放大（「正在就诊」语义）；
 * 下半区小字列「后续安排」（明天起）。privacy=1 整屏无客户/项目名（服务端已裁剪）。
 */
export function ScheduleMode({ privacy }: Props) {
  const now = useNow()
  const [data, setData] = useState<ScheduleDisplay | null>(null)

  useEffect(() => {
    let stop = false
    const poll = () =>
      api
        .schedulesDisplay({ days: 3, privacy })
        .then((d) => {
          if (!stop) setData(d)
        })
        .catch(() => {
          /* 轮询失败保持现状 */
        })
    poll()
    const t = window.setInterval(poll, POLL_MS)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [privacy])

  const todayKey = dayKey(new Date(now))
  const { todayItems, laterGroups } = useMemo(() => {
    const items = data?.items ?? []
    const todayItems = items.filter((s) => s.date === todayKey)
    const byDay = new Map<string, ScheduleDisplayItem[]>()
    for (const s of items) {
      if (s.date === todayKey) continue
      const arr = byDay.get(s.date) ?? []
      arr.push(s)
      byDay.set(s.date, arr)
    }
    const laterGroups = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    return { todayItems, laterGroups }
  }, [data, todayKey])

  const { time } = fmtClock(now)
  const runningCount = todayItems.filter((s) => s.status === '试验中').length
  const laterFlat = laterGroups.flatMap(([date, items]) => items.map((s) => ({ date, s })))

  return (
    <div className="sd-root">
      <div className="sd-head">
        <div className="sd-title">
          {privacy ? '试验排程公示' : '试验排程调度'}
          <span className="sd-title-sub">{privacy ? '请按排队号留意试验进度' : '控制室排程总览'}</span>
        </div>
        <div className="sd-head-side">
          {runningCount > 0 && <span className="sd-live-badge">试验中 {runningCount}</span>}
          <span className="sd-head-clock mono">{time}</span>
        </div>
      </div>

      <div className={`sd-main${privacy ? '' : ' sd-main--full'}`}>
        {todayItems.length === 0 ? (
          <div className="sd-empty">今日暂无排程</div>
        ) : (
          <>
            {todayItems.slice(0, MAX_TODAY_ROWS).map((s) => (
              <div key={`${s.date}-${s.queue_no}`} className={`sd-row sd-row--${statusCls(s.status)}`}>
                <div className="sd-queue mono">{s.queue_no}</div>
                <div className="sd-cell sd-time mono">
                  {hm(s.start_at)} ~ {hm(s.end_at)}
                </div>
                <div className="sd-cell sd-resource">{s.resource}</div>
                {!privacy && (
                  <div className="sd-cell sd-name">
                    <span className="sd-name-title">{s.title}</span>
                    {(s.project_name || s.order_name) && (
                      <span className="sd-name-sub">{[s.project_name, s.order_name].filter(Boolean).join(' / ')}</span>
                    )}
                  </div>
                )}
                <div className={`sd-status sd-status--${statusCls(s.status)}`}>
                  {s.status === '试验中' && <i className="sd-status-dot" />}
                  {s.status}
                </div>
              </div>
            ))}
            {todayItems.length > MAX_TODAY_ROWS && (
              <div className="sd-more">其余 {todayItems.length - MAX_TODAY_ROWS} 条从略</div>
            )}
          </>
        )}
      </div>

      {laterFlat.length > 0 && (
        <div className="sd-later">
          <div className="sd-later-head">后续安排</div>
          <div className="sd-later-list">
            {laterFlat.slice(0, MAX_LATER_ROWS).map(({ date, s }) => (
              <div key={`${date}-${s.queue_no}`} className="sd-later-item">
                <span className="sd-later-date mono">{date.slice(5).replace('-', '/')}</span>
                <span className="sd-queue mono">{s.queue_no}</span>
                <span className="mono">
                  {hm(s.start_at)} ~ {hm(s.end_at)}
                </span>
                <span className="sd-later-res">{s.resource}</span>
                {!privacy && <span className="sd-later-name">{s.title}</span>}
                <span className={`sd-status sd-status--sm sd-status--${statusCls(s.status)}`}>{s.status}</span>
              </div>
            ))}
            {laterFlat.length > MAX_LATER_ROWS && (
              <div className="sd-later-item sd-more">其余 {laterFlat.length - MAX_LATER_ROWS} 条从略</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
