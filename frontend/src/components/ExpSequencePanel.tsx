import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  hasMinRole,
  type ExpSequenceDef,
  type ExpSequenceExec,
  type ExpSequenceStep,
  type SequenceDef,
} from '../api'
import { Modal, ConfirmModal } from './Modal'
import { SUBSYSTEM_DEFS } from '../subsystems'
import { IconPlay, IconPause, IconAbort, IconPlus, IconEdit, IconTrash, IconRefresh, IconSkip } from './icons'

const STEP_TYPES: { key: ExpSequenceStep['type']; label: string }[] = [
  { key: 'setpoint', label: '设定指令' },
  { key: 'hold', label: '保持等待' },
  { key: 'acquire', label: '采集启停' },
  { key: 'sequence_step', label: '启停序列' },
  { key: 'notify', label: '提示' },
]

const STEP_TYPE_CN: Record<string, string> = {
  setpoint: '设定',
  hold: '保持',
  acquire: '采集',
  sequence_step: '序列',
  notify: '提示',
}

const STEP_STATUS_CN: Record<string, string> = {
  pending: '待执行',
  running: '运行中',
  ok: '完成',
  failed: '失败',
  skipped: '已跳过',
}

const EXEC_STATE_CN: Record<string, string> = {
  running: '运行中',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  aborted: '已中止',
  none: '空闲',
}

function emptyStep(): ExpSequenceStep {
  return { type: 'setpoint', subsystem: 'main_fan', command: 'set_speed', params: {} }
}

/** 步骤摘要（列表/执行进度共用） */
function stepSummary(s: ExpSequenceStep): string {
  switch (s.type) {
    case 'setpoint':
      return `${s.subsystem ?? ''}.${s.command ?? ''} ${JSON.stringify(s.params ?? {})}`
    case 'hold':
      return `保持 ${s.seconds ?? 0}s`
    case 'acquire':
      return `${s.subsystem ?? ''} 采集${s.action === 'start' ? '开始' : '停止'}`
    case 'sequence_step':
      return `执行序列 ${s.sequence_id ?? ''}`
    case 'notify':
      return `提示：${s.message ?? ''}${s.alert ? '（告警）' : ''}`
    default:
      return ''
  }
}

/** 试验序列编排：列表 + 步骤编辑器 + 执行进度（试验中心 · 序列编排 tab） */
export function ExpSequencePanel({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canEdit = hasMinRole('维护员')
  const canOperate = hasMinRole('操作员')
  const [list, setList] = useState<ExpSequenceDef[]>([])
  const [sequences, setSequences] = useState<SequenceDef[]>([])
  const [exec, setExec] = useState<ExpSequenceExec | null>(null)

  // 编辑表单（Modal 内）
  const [formOpen, setFormOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<ExpSequenceStep[]>([emptyStep()])
  const [paramsDraft, setParamsDraft] = useState<Record<number, string>>({})

  // 确认弹窗
  const [confirmAbort, setConfirmAbort] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ExpSequenceDef | null>(null)
  const [confirmStart, setConfirmStart] = useState<ExpSequenceDef | null>(null)

  const running = exec !== null && (exec.state === 'running' || exec.state === 'paused')

  const refresh = useCallback(async () => {
    const [seqs, subseqs] = await Promise.all([api.listExpSequences(), api.listSequences()])
    setList(seqs)
    setSequences(subseqs)
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 执行状态轮询：执行中 1.5s 一次，空闲 5s 一次（启动后及时出现进度卡）
  useEffect(() => {
    let stop = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const e = await api.expSequenceExecution()
        if (stop) return
        setExec('seq_id' in e ? e : null)
        timer = window.setTimeout(poll, 'seq_id' in e && (e.state === 'running' || e.state === 'paused') ? 1500 : 5000)
      } catch {
        if (!stop) timer = window.setTimeout(poll, 5000)
      }
    }
    poll()
    return () => {
      stop = true
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  function resetForm() {
    setEditId(null)
    setName('')
    setDescription('')
    setSteps([emptyStep()])
    setParamsDraft({})
  }

  function startCreate() {
    resetForm()
    setFormOpen(true)
  }

  function loadForEdit(s: ExpSequenceDef) {
    setEditId(s.id)
    setName(s.name)
    setDescription(s.description)
    setSteps(s.steps.map((st) => ({ ...st })))
    setParamsDraft({})
    setFormOpen(true)
  }

  function setStep(i: number, patch: Partial<ExpSequenceStep>) {
    setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  function changeType(i: number, type: ExpSequenceStep['type']) {
    const base: ExpSequenceStep = { type }
    if (type === 'setpoint') Object.assign(base, { subsystem: 'main_fan', command: 'set_speed', params: {} })
    if (type === 'hold') Object.assign(base, { seconds: 5 })
    if (type === 'acquire') Object.assign(base, { subsystem: 'acoustic', action: 'start' })
    if (type === 'sequence_step') Object.assign(base, { sequence_id: sequences[0]?.id ?? '' })
    if (type === 'notify') Object.assign(base, { message: '', alert: false })
    setSteps((ss) => ss.map((s, j) => (j === i ? base : s)))
  }

  function moveStep(i: number, dir: -1 | 1) {
    setSteps((ss) => {
      const j = i + dir
      if (j < 0 || j >= ss.length) return ss
      const next = [...ss]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function validate(): { err: string | null; steps: ExpSequenceStep[] } {
    if (!name.trim()) return { err: '请填写序列名称', steps }
    if (!steps.length) return { err: '至少需要一步', steps }
    const out: ExpSequenceStep[] = []
    for (let i = 0; i < steps.length; i++) {
      const s = { ...steps[i] }
      if (s.type === 'setpoint') {
        if (!s.subsystem || !s.command?.trim()) return { err: `第 ${i + 1} 步需填写子系统与指令名`, steps }
        const raw = paramsDraft[i] ?? JSON.stringify(s.params ?? {})
        try {
          s.params = raw.trim() ? JSON.parse(raw) : {}
        } catch {
          return { err: `第 ${i + 1} 步参数不是合法 JSON`, steps }
        }
      }
      if (s.type === 'hold' && (!(s.seconds! > 0) || s.seconds! > 3600))
        return { err: `第 ${i + 1} 步保持时长需在 (0, 3600] 秒`, steps }
      if (s.type === 'acquire' && !s.subsystem) return { err: `第 ${i + 1} 步需选择子系统`, steps }
      if (s.type === 'sequence_step' && !s.sequence_id) return { err: `第 ${i + 1} 步需选择启停序列`, steps }
      if (s.type === 'notify' && !s.message?.trim()) return { err: `第 ${i + 1} 步需填写提示内容`, steps }
      out.push(s)
    }
    return { err: null, steps: out }
  }

  async function save() {
    const { err, steps: normalized } = validate()
    if (err) {
      toast(err, false)
      return
    }
    const body = { name: name.trim(), description: description.trim(), steps: normalized }
    try {
      if (editId) {
        await api.updateExpSequence(editId, body)
        toast('序列已保存（版本 +1）')
      } else {
        await api.createExpSequence(body)
        toast('序列已创建')
      }
      setFormOpen(false)
      resetForm()
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', false)
    }
  }

  async function remove(s: ExpSequenceDef) {
    try {
      await api.deleteExpSequence(s.id)
      toast('序列已删除')
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '删除失败'
      toast(msg.includes('执行') ? '序列正在执行中，无法删除' : msg, false)
    }
  }

  async function start(s: ExpSequenceDef) {
    try {
      const e = await api.startExpSequence(s.id)
      setExec(e)
      toast(`序列已启动${e.experiment_id ? '（已关联实验记录）' : ''}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '启动失败'
      toast(msg.includes('执行') || msg.includes('409') ? '已有任务在执行，稍后再试' : msg, false)
    }
  }

  async function control(action: 'pause' | 'resume' | 'skip' | 'abort') {
    try {
      const e = await api.controlExpSequence(action)
      setExec(e)
      toast({ pause: '已暂停', resume: '已继续', skip: '已跳过当前步', abort: '已中止' }[action])
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', false)
    }
  }

  const seqOptions = useMemo(() => sequences.map((s) => ({ id: s.id, name: s.name })), [sequences])

  return (
    <div className="layout-2">
      <div className="panel">
        <div className="panel-head">
          <h2>序列列表</h2>
          <div className="actions actions-flush">
            {canEdit && (
              <button type="button" className="icon-btn" onClick={startCreate} title="新建试验序列">
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
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>
                  <div>{s.name}</div>
                  {s.description && <div className="text-dim">{s.description}</div>}
                </td>
                <td className="mono">{s.steps.length}</td>
                <td className="mono">v{s.version}</td>
                <td>
                  <div className="actions actions-flush">
                    {canOperate && (
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={running}
                        onClick={() => setConfirmStart(s)}
                        title={running ? '已有序列在执行' : '启动该序列'}
                      >
                        <IconPlay size={16} />
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className="icon-btn" onClick={() => loadForEdit(s)} title="编辑序列">
                        <IconEdit size={16} />
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className="icon-btn danger" onClick={() => setConfirmDelete(s)} title="删除序列">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无试验序列{canEdit ? '，点击右上角「+」新建' : ''}</div>}
      </div>

      <div className="panel">
        <h2>执行进度 {exec ? `· ${exec.name}` : ''}</h2>
        {!exec ? (
          <div className="empty">尚未执行过试验序列，在左侧列表点击 ▶ 启动</div>
        ) : (
          <>
            <div className="ctl-row actions-mb">
              {canOperate && exec.state === 'running' && (
                <button type="button" className="ctl-btn" onClick={() => control('pause')} title="暂停在当前步">
                  <IconPause size={24} />
                  <span className="label-cap">暂停</span>
                </button>
              )}
              {canOperate && exec.state === 'paused' && (
                <button type="button" className="ctl-btn primary" onClick={() => control('resume')} title="从暂停处继续执行">
                  <IconPlay size={24} />
                  <span className="label-cap">继续</span>
                </button>
              )}
              {canOperate && running && (
                <button type="button" className="ctl-btn" onClick={() => control('skip')} title="跳过当前步">
                  <IconSkip size={24} />
                  <span className="label-cap">跳过</span>
                </button>
              )}
              {canOperate && running && (
                <button type="button" className="ctl-btn danger" onClick={() => setConfirmAbort(true)} title="中止执行">
                  <IconAbort size={24} />
                  <span className="label-cap">中止</span>
                </button>
              )}
              <span
                className={`badge ${exec.state === 'running' ? 'ok' : exec.state === 'paused' ? 'warn' : exec.state === 'failed' || exec.state === 'aborted' ? 'danger' : 'info'}`}
              >
                {EXEC_STATE_CN[exec.state] ?? exec.state}
              </span>
              <span className="badge mono">
                步骤 {Math.min(exec.current_step + 1, exec.total_steps)}/{exec.total_steps}
              </span>
              <span className="badge">操作员 {exec.operator}</span>
            </div>

            <div className="health-bar health-bar--spaced">
              <i
                style={{
                  width: `${exec.total_steps ? Math.round((exec.steps.filter((s) => s.status === 'ok' || s.status === 'skipped').length / exec.total_steps) * 100) : 0}%`,
                }}
              />
            </div>

            {exec.error && <div className="badge danger badge-block">{exec.error}</div>}
            {exec.experiment_id && <div className="badge info badge-block">关联实验记录 {exec.experiment_id}</div>}

            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>步骤</th>
                  <th>类型</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {exec.steps.map((s, i) => (
                  <tr key={i} className={i === exec.current_step && running ? 'row-active' : undefined}>
                    <td className="mono">{i + 1}</td>
                    <td>{s.label}</td>
                    <td>{STEP_TYPE_CN[s.type] ?? s.type}</td>
                    <td>
                      <span
                        className={`badge ${s.status === 'ok' ? 'ok' : s.status === 'running' ? 'info' : s.status === 'failed' ? 'danger' : s.status === 'skipped' ? 'warn' : ''}`}
                      >
                        {STEP_STATUS_CN[s.status] ?? s.status}
                      </span>
                      {s.message && <div className={s.status === 'failed' ? 'cell-error' : 'text-dim'}>{s.message}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* 新建 / 编辑序列弹窗 */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        size="lg"
        title={editId ? `编辑序列（v${list.find((s) => s.id === editId)?.version ?? '?'}）` : '新建试验序列'}
        footer={
          <>
            <button className="btn" onClick={() => setFormOpen(false)}>取消</button>
            <button className="btn primary" onClick={save}>{editId ? '保存修改' : '创建序列'}</button>
          </>
        }
      >
        <div className="form-row">
          <label>名称</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：气动阶梯风速序列" />
        </div>
        <div className="form-row">
          <label>描述</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" />
        </div>

        <h2 className="section-sub">步骤（{steps.length}）</h2>
        {steps.map((s, i) => (
          <div key={i} className="exp-step-editor">
            <div className="form-row">
              <label>第 {i + 1} 步</label>
              <select value={s.type} onChange={(e) => changeType(i, e.target.value as ExpSequenceStep['type'])}>
                {STEP_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              <div className="actions actions-flush">
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => moveStep(i, -1)} title="上移">↑</button>
                <button type="button" className="icon-btn" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} title="下移">↓</button>
                <button
                  type="button"
                  className="icon-btn danger"
                  disabled={steps.length <= 1}
                  onClick={() => setSteps((ss) => ss.filter((_, j) => j !== i))}
                  title="删除该步"
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
            <div className="form-row">
              <label>标签</label>
              <input value={s.label ?? ''} onChange={(e) => setStep(i, { label: e.target.value })} placeholder={stepSummary(s) || '可选，留空自动生成'} />
            </div>
            {s.type === 'setpoint' && (
              <>
                <div className="form-row">
                  <label>子系统</label>
                  <select value={s.subsystem} onChange={(e) => setStep(i, { subsystem: e.target.value })}>
                    {SUBSYSTEM_DEFS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>指令名</label>
                  <input value={s.command ?? ''} onChange={(e) => setStep(i, { command: e.target.value })} placeholder="如 set_speed" />
                </div>
                <div className="form-row">
                  <label>参数 JSON</label>
                  <input
                    className="mono"
                    value={paramsDraft[i] ?? JSON.stringify(s.params ?? {})}
                    onChange={(e) => setParamsDraft((d) => ({ ...d, [i]: e.target.value }))}
                    placeholder='{"target_speed": 40}'
                  />
                </div>
              </>
            )}
            {s.type === 'hold' && (
              <div className="form-row">
                <label>保持秒数</label>
                <input
                  type="number"
                  step="any"
                  value={s.seconds ?? ''}
                  onChange={(e) => setStep(i, { seconds: Number(e.target.value) })}
                />
              </div>
            )}
            {s.type === 'acquire' && (
              <>
                <div className="form-row">
                  <label>子系统</label>
                  <select value={s.subsystem} onChange={(e) => setStep(i, { subsystem: e.target.value })}>
                    {SUBSYSTEM_DEFS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>动作</label>
                  <select value={s.action} onChange={(e) => setStep(i, { action: e.target.value as 'start' | 'stop' })}>
                    <option value="start">开始采集</option>
                    <option value="stop">停止采集</option>
                  </select>
                </div>
              </>
            )}
            {s.type === 'sequence_step' && (
              <div className="form-row">
                <label>启停序列</label>
                <select value={s.sequence_id} onChange={(e) => setStep(i, { sequence_id: e.target.value })}>
                  <option value="">请选择</option>
                  {seqOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
            )}
            {s.type === 'notify' && (
              <>
                <div className="form-row">
                  <label>提示内容</label>
                  <input value={s.message ?? ''} onChange={(e) => setStep(i, { message: e.target.value })} placeholder="如：请确认模型已安装" />
                </div>
                <div className="form-row">
                  <label>产生告警</label>
                  <input type="checkbox" checked={!!s.alert} onChange={(e) => setStep(i, { alert: e.target.checked })} />
                </div>
              </>
            )}
          </div>
        ))}
        <div className="actions">
          <button type="button" className="btn" onClick={() => setSteps((ss) => [...ss, emptyStep()])}>+ 加步骤</button>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmAbort}
        onClose={() => setConfirmAbort(false)}
        onConfirm={() => {
          setConfirmAbort(false)
          control('abort')
        }}
        title="中止试验序列"
        danger
        confirmLabel="确认中止"
        message={`确认中止序列「${exec?.name ?? ''}」的当前执行？未完成的步骤将不会执行。`}
      />
      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
          setConfirmDelete(null)
        }}
        title="删除试验序列"
        danger
        confirmLabel="确认删除"
        message={`确认删除序列「${confirmDelete?.name ?? ''}」？该操作不可恢复。`}
      />
      <ConfirmModal
        open={!!confirmStart}
        onClose={() => setConfirmStart(null)}
        onConfirm={() => {
          if (confirmStart) void start(confirmStart)
          setConfirmStart(null)
        }}
        title="启动试验序列"
        confirmLabel="确认启动"
        message={`确认启动序列「${confirmStart?.name ?? ''}」（${confirmStart?.steps.length ?? 0} 步）？将绑定当前活动实验，无活动实验时自动新建实验记录。`}
      />
    </div>
  )
}
