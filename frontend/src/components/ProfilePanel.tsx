import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, hasMinRole, type ProfileStep, type SpeedProfile } from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { Chart, type EChartsCoreOption } from './Chart'
import { useChartColors } from './chartColors'
import { ConfirmModal } from './Modal'
import { IconAbort, IconPlay, IconPlus, IconRefresh, IconTrash } from './icons'

const PROFILE_STATUS_CN: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  completed: '已完成',
  aborted: '已中止',
  failed: '失败',
}

/** 剖面总时长（秒） */
function totalSec(steps: ProfileStep[]): number {
  return steps.reduce((s, x) => s + (Number(x.hold_sec) || 0), 0)
}

function fmtSec(sec: number): string {
  if (sec >= 60) return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`
  return `${Math.round(sec)}s`
}

/** 阶梯剖面预览图（ECharts 阶梯线；执行中以竖线标注当前推进位置） */
function ProfileChart({
  steps,
  elapsedSec,
}: {
  steps: ProfileStep[]
  /** 执行中：已推进秒数；undefined 表示未执行 */
  elapsedSec?: number
}) {
  const colors = useChartColors()
  const option = useMemo<EChartsCoreOption>(() => {
    const points: [number, number][] = []
    let t = 0
    for (const s of steps) {
      points.push([t, s.speed])
      t += s.hold_sec
      points.push([t, s.speed])
    }
    const series: { type: string; [k: string]: unknown }[] = [
      {
        name: '目标风速',
        type: 'line' as const,
        step: 'end' as const,
        data: points,
        showSymbol: true,
        symbolSize: 5,
        lineStyle: { width: 2 },
      },
    ]
    if (elapsedSec !== undefined && points.length) {
      series.push({
        name: '当前位置',
        type: 'line' as const,
        data: [],
        markLine: {
          silent: true,
          symbol: 'none',
          label: { color: colors.warn, fontSize: 11, formatter: '当前' },
          lineStyle: { color: colors.warn, width: 2, type: 'solid' as const },
          data: [{ xAxis: elapsedSec }],
        },
      })
    }
    return {
      animation: false,
      color: [colors.accent],
      grid: { left: 52, right: 20, top: 16, bottom: 30 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.card,
        borderColor: colors.line,
        textStyle: { color: colors.text, fontSize: 12 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)} m/s` : '--'),
      },
      xAxis: {
        type: 'value',
        name: 't (s)',
        nameTextStyle: { color: colors.muted, fontSize: 11 },
        max: Math.max(10, t),
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.line } },
        splitLine: { lineStyle: { color: colors.split } },
      },
      yAxis: {
        type: 'value',
        name: 'm/s',
        nameTextStyle: { color: colors.muted, fontSize: 11 },
        axisLabel: { color: colors.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: colors.line } },
        splitLine: { lineStyle: { color: colors.split } },
      },
      series,
    }
  }, [steps, elapsedSec, colors])

  if (!steps.length) return null
  return <Chart option={option} height={200} />
}

/** 风速程控面板：剖面列表 + 执行控制（阶梯预览 + 进度） + 步序编辑器 */
export function ProfilePanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canEdit = hasMinRole('操作员')
  const canDelete = hasMinRole('维护员')
  const { frame } = useTelemetry()
  const live = frame?.overview?.profile ?? null

  const [list, setList] = useState<SpeedProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 编辑器草稿（名称 + 步序行）
  const [draftName, setDraftName] = useState('')
  const [draftSteps, setDraftSteps] = useState<ProfileStep[]>([])
  const [dirty, setDirty] = useState(false)
  const [confirmStart, setConfirmStart] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<SpeedProfile | null>(null)

  const refresh = useCallback(async () => {
    setList(await api.profiles())
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = list.find((p) => p.id === selectedId) ?? null
  // 执行状态以 WS 概览为准；列表里的 exec_status 兜底（刚启动/收尾间隙）
  const running = !!live && live.state === 'running'
  const runningThis = running && (!!selected && live?.id === selected.id)

  const loadProfile = useCallback((p: SpeedProfile) => {
    setSelectedId(p.id)
    setDraftName(p.name)
    setDraftSteps(p.steps.map((s) => ({ ...s })))
    setDirty(false)
  }, [])

  // 默认选中：进入 tab 且未在编辑时，自动打开运行中的剖面（否则第一个），保证执行状态可见
  useEffect(() => {
    if (!list.length || selectedId || dirty) return
    const runningOne = live ? list.find((p) => p.id === live.id) : null
    loadProfile(runningOne ?? list[0])
  }, [list, selectedId, dirty, live, loadProfile])

  function startCreate() {
    setSelectedId(null)
    setDraftName('新风速剖面')
    setDraftSteps([{ speed: 20, hold_sec: 30 }])
    setDirty(true)
  }

  function setStep(i: number, patch: Partial<ProfileStep>) {
    setDraftSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)))
    setDirty(true)
  }

  function moveStep(i: number, dir: -1 | 1) {
    setDraftSteps((ss) => {
      const j = i + dir
      if (j < 0 || j >= ss.length) return ss
      const next = [...ss]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setDirty(true)
  }

  function removeStep(i: number) {
    setDraftSteps((ss) => ss.filter((_, j) => j !== i))
    setDirty(true)
  }

  async function save() {
    if (!draftName.trim()) {
      toast('剖面名称不能为空', false)
      return
    }
    if (!draftSteps.length) {
      toast('至少需要一步阶梯', false)
      return
    }
    try {
      const body = { name: draftName.trim(), steps: draftSteps }
      if (selected) {
        await api.updateProfile(selected.id, body)
        toast('剖面已保存')
      } else {
        const created = await api.createProfile(body)
        setSelectedId(created.id)
        toast('剖面已创建')
      }
      setDirty(false)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', false)
    }
  }

  async function start() {
    if (!selected) return
    try {
      await api.startProfile(selected.id)
      toast(`程控已启动：${selected.name}`)
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '启动失败', false)
    }
  }

  async function stop() {
    try {
      await api.stopProfile()
      toast('已请求中止程控')
    } catch (e) {
      toast(e instanceof Error ? e.message : '中止失败', false)
    }
  }

  async function remove(p: SpeedProfile) {
    try {
      await api.deleteProfile(p.id)
      toast('剖面已删除')
      if (selectedId === p.id) {
        setSelectedId(null)
        setDraftName('')
        setDraftSteps([])
      }
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', false)
    }
  }

  // 执行进度：整体按步推进 + 本步剩余秒
  const progressPct = runningThis
    ? Math.round(((live!.step_index + 1 - live!.step_remaining_sec / Math.max(1, live!.steps[live!.step_index]?.hold_sec ?? 1)) / live!.total_steps) * 100)
    : 0
  const elapsedSec = useMemo(() => {
    if (!runningThis || !live) return undefined
    let t = 0
    for (let i = 0; i < live.step_index; i++) t += live.steps[i]?.hold_sec ?? 0
    const cur = live.steps[live.step_index]
    if (cur) t += cur.hold_sec - live.step_remaining_sec
    return Math.max(0, t)
  }, [runningThis, live])

  const chartSteps = runningThis && live ? live.steps : (selected?.steps ?? (draftSteps.length ? draftSteps : []))

  return (
    <div className="layout-2">
      <div className="panel">
        <div className="panel-head">
          <h2>剖面列表</h2>
          <div className="actions actions-flush">
            {canEdit && (
              <button type="button" className="icon-btn" onClick={startCreate} title="新建风速剖面">
                <IconPlus size={18} />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新">
              <IconRefresh size={18} />
            </button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>步数</th>
              <th>总时长</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className={selectedId === p.id ? 'row-active' : undefined}>
                <td>
                  <a className="link-btn" onClick={() => loadProfile(p)}>{p.name}</a>
                </td>
                <td className="mono">{p.steps.length}</td>
                <td className="mono">{fmtSec(totalSec(p.steps))}</td>
                <td>
                  <span className={`badge ${live?.id === p.id && running ? 'ok' : 'info'}`}>
                    {live?.id === p.id && running ? '运行中' : PROFILE_STATUS_CN[p.exec_status ?? 'idle'] ?? '空闲'}
                  </span>
                </td>
                <td>
                  <div className="actions actions-flush">
                    <button
                      type="button"
                      className={`icon-btn ${selectedId === p.id ? 'active' : ''}`}
                      onClick={() => loadProfile(p)}
                      title="打开执行/编辑面板"
                    >
                      <IconPlay size={16} />
                    </button>
                    {canDelete && (
                      <button type="button" className="icon-btn danger" onClick={() => setConfirmDelete(p)} title="删除剖面">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无风速剖面{canEdit ? '，点击右上角「+」新建' : ''}</div>}
      </div>

      <div className="panel">
        <h2>执行与编辑 {selected ? `· ${selected.name}` : dirty && draftName ? `· ${draftName}（新建）` : ''}</h2>
        {!selected && !dirty && <div className="empty">在左侧列表选择剖面后在此执行；或点击「+」新建剖面</div>}
        {(selected || dirty) && (
          <>
            <div className="ctl-row actions-mb">
              {canEdit && selected && !running && (
                <button type="button" className="ctl-btn primary" onClick={() => setConfirmStart(true)} title="启动阶梯剖面自动执行">
                  <IconPlay size={24} />
                  <span className="label-cap">启动</span>
                </button>
              )}
              {canEdit && running && (
                <button type="button" className="ctl-btn danger" onClick={() => setConfirmStop(true)} title="中止风速程控">
                  <IconAbort size={24} />
                  <span className="label-cap">中止</span>
                </button>
              )}
              <span className={`badge ${running ? 'ok' : 'info'}`}>{running ? '程控运行中' : '程控空闲'}</span>
              {runningThis && live && (
                <>
                  <span className="badge mono">第 {live.step_index + 1}/{live.total_steps} 步</span>
                  <span className="badge mono">本步剩余 {Math.ceil(live.step_remaining_sec)}s</span>
                  <span className="badge">目标 {live.steps[live.step_index]?.speed ?? '--'} m/s</span>
                </>
              )}
              {running && !runningThis && <span className="badge warn">另一剖面「{live?.name}」执行中</span>}
            </div>

            {runningThis && (
              <div className="health-bar health-bar--spaced">
                <i style={{ width: `${progressPct}%` }} />
              </div>
            )}

            <h2 className="section-sub">阶梯剖面预览</h2>
            <ProfileChart steps={chartSteps} elapsedSec={elapsedSec} />

            <h2 className="section-sub">步序编辑</h2>
            <div className="form-row">
              <label>剖面名称</label>
              <input
                value={draftName}
                disabled={runningThis}
                onChange={(e) => {
                  setDraftName(e.target.value)
                  setDirty(true)
                }}
              />
            </div>
            <div className="table-scroll">
              <table className="table matrix-edit-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>风速 m/s</th>
                    <th>保持 s</th>
                    <th>排序</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draftSteps.map((s, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <input
                          className="field field-sm"
                          type="number"
                          min={0}
                          max={250}
                          step={1}
                          value={s.speed}
                          disabled={runningThis}
                          onChange={(e) => setStep(i, { speed: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <input
                          className="field field-sm"
                          type="number"
                          min={1}
                          max={36000}
                          step={1}
                          value={s.hold_sec}
                          disabled={runningThis}
                          onChange={(e) => setStep(i, { hold_sec: Number(e.target.value) })}
                        />
                      </td>
                      <td>
                        <div className="actions actions-flush">
                          <button type="button" className="btn" disabled={i === 0 || runningThis} onClick={() => moveStep(i, -1)}>↑</button>
                          <button type="button" className="btn" disabled={i === draftSteps.length - 1 || runningThis} onClick={() => moveStep(i, 1)}>↓</button>
                        </div>
                      </td>
                      <td>
                        <button type="button" className="icon-btn danger" disabled={runningThis} onClick={() => removeStep(i)} title="删除该步">
                          <IconTrash size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="actions actions-flush">
              <button
                type="button"
                className="btn"
                disabled={runningThis || draftSteps.length >= 64}
                onClick={() => {
                  setDraftSteps((ss) => [...ss, { speed: ss[ss.length - 1]?.speed ?? 20, hold_sec: 30 }])
                  setDirty(true)
                }}
              >
                + 添加一步
              </button>
              {canEdit && (
                <button type="button" className="btn primary" disabled={!dirty || runningThis} onClick={save}>
                  {selected ? '保存修改' : '创建剖面'}
                </button>
              )}
              <span className="mono text-dim cell-note">总时长 {fmtSec(totalSec(draftSteps))}</span>
            </div>
          </>
        )}
      </div>

      <ConfirmModal
        open={confirmStart}
        onClose={() => setConfirmStart(false)}
        onConfirm={() => {
          setConfirmStart(false)
          void start()
        }}
        title="启动风速程控"
        confirmLabel="确认启动"
        message={`确认按剖面「${selected?.name ?? ''}」自动执行 ${selected?.steps.length ?? 0} 步阶梯风速（总时长 ${fmtSec(totalSec(selected?.steps ?? []))}）？风机未运行时将自动启动；结束/中止后保持当前设定风速。`}
      />
      <ConfirmModal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false)
          void stop()
        }}
        title="中止风速程控"
        danger
        confirmLabel="确认中止"
        message={`确认中止执行中的风速程控「${live?.name ?? ''}」？程控停止后保持当前设定风速（不停风机）。`}
      />
      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
          setConfirmDelete(null)
        }}
        title="删除风速剖面"
        danger
        confirmLabel="确认删除"
        message={`确认删除剖面「${confirmDelete?.name ?? ''}」？该操作不可恢复。`}
      />
    </div>
  )
}
