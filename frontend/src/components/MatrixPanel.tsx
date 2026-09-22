import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  api,
  hasMinRole,
  type Experiment,
  type MatrixCondition,
  type MatrixStatus,
  type TestMatrix,
} from '../api'
import { Modal, ConfirmModal } from './Modal'
import { IconPlay, IconPause, IconAbort, IconPlus, IconEdit, IconTrash, IconRefresh, IconEye } from './icons'

const SCENARIOS = ['气动实验', '声学实验', 'WLTP滑行', '参观演示']

const COND_FIELDS: { key: keyof MatrixCondition; label: string; unit: string; placeholder: string }[] = [
  { key: 'wind_speed', label: '风速', unit: 'm/s', placeholder: '0-250' },
  { key: 'temperature', label: '温度', unit: '℃', placeholder: '-40~85' },
  { key: 'yaw_angle', label: '偏航', unit: '°', placeholder: '-180~180' },
  { key: 'belt_speed', label: '路面速度', unit: 'm/s', placeholder: '留空=不启用' },
  { key: 'traverse_x', label: '移测X', unit: 'mm', placeholder: '如 100' },
  { key: 'traverse_y', label: '移测Y', unit: 'mm', placeholder: '如 50' },
  { key: 'traverse_z', label: '移测Z', unit: 'mm', placeholder: '如 20' },
  { key: 'duration_sec', label: '采集时长', unit: 's', placeholder: '0.5-3600' },
  { key: 'repeat', label: '重复', unit: '次', placeholder: '1-50' },
  { key: 'reference_area', label: '参考面积', unit: 'm²', placeholder: '>0' },
]

function emptyCondition(): MatrixCondition {
  return {
    wind_speed: 40,
    temperature: 25,
    yaw_angle: 0,
    belt_speed: null,
    traverse_x: 100,
    traverse_y: 50,
    traverse_z: 20,
    duration_sec: 5,
    repeat: 1,
    reference_area: 2,
  }
}

const ROW_STATUS_CN: Record<string, string> = {
  pending: '待执行',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  skipped: '已跳过',
}

const MATRIX_STATUS_CN: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  aborted: '已中止',
  failed: '失败',
}

function fmtEta(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '--'
  const s = Math.max(0, Math.round(sec))
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`
}

/** 试验矩阵管理：列表 + 执行面板 + 新建/编辑弹窗（试验中心 · 矩阵 tab） */
export function MatrixPanel({
  toast,
  onOpenRun,
}: {
  toast: (msg: string, ok?: boolean) => void
  onOpenRun: (runId: string) => void
}) {
  const canEdit = hasMinRole('操作员')
  const [list, setList] = useState<TestMatrix[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<MatrixStatus | null>(null)

  // 编辑表单（Modal 内）
  const [formOpen, setFormOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [scenario, setScenario] = useState('气动实验')
  const [onError, setOnError] = useState<'abort' | 'skip'>('abort')
  const [rows, setRows] = useState<MatrixCondition[]>([emptyCondition()])
  const [runExpId, setRunExpId] = useState('')

  // 确认弹窗
  const [confirmAbort, setConfirmAbort] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<TestMatrix | null>(null)

  const selected = useMemo(() => list.find((m) => m.id === selectedId) ?? null, [list, selectedId])
  const [searchParams, setSearchParams] = useSearchParams()

  // 命令面板等入口的 ?new=1 深链：直接打开新建弹窗，消费一次后移除
  useEffect(() => {
    if (searchParams.get('new') === '1' && canEdit) {
      startCreate()
      searchParams.delete('new')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = useCallback(async () => {
    const [ms, exps] = await Promise.all([api.matrices(), api.experiments()])
    setList(ms)
    setExperiments(exps)
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
  }, [])

  // 选中矩阵状态轮询：执行中 2s 一次，否则选中时取一次
  useEffect(() => {
    if (!selectedId) {
      setStatus(null)
      return
    }
    let stop = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const s = await api.matrixStatus(selectedId)
        if (stop) return
        setStatus(s)
        if (s.status === 'running' || s.status === 'paused') {
          timer = window.setTimeout(poll, 2000)
        }
      } catch {
        /* 状态拉取失败保持现状 */
      }
    }
    poll()
    return () => {
      stop = true
      if (timer) window.clearTimeout(timer)
    }
  }, [selectedId, selected?.updated_at])

  function resetForm() {
    setEditId(null)
    setName('')
    setScenario('气动实验')
    setOnError('abort')
    setRows([emptyCondition()])
  }

  function startCreate() {
    resetForm()
    setFormOpen(true)
  }

  function loadForEdit(m: TestMatrix) {
    setEditId(m.id)
    setName(m.name)
    setScenario(m.scenario)
    setOnError(m.on_error)
    setRows(m.conditions.map((c) => ({ ...emptyCondition(), ...c })))
    setFormOpen(true)
  }

  function setRow(i: number, key: keyof MatrixCondition, raw: string) {
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r
        if (key === 'belt_speed') return { ...r, belt_speed: raw === '' ? null : Number(raw) }
        return { ...r, [key]: Number(raw) }
      }),
    )
  }

  function validate(): string | null {
    if (!name.trim()) return '请填写矩阵名称'
    if (!rows.length) return '至少需要一行工况'
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      for (const f of COND_FIELDS) {
        if (f.key === 'belt_speed') continue
        const v = r[f.key]
        if (typeof v !== 'number' || Number.isNaN(v)) return `第 ${i + 1} 行「${f.label}」不是有效数值`
      }
      if (r.belt_speed !== null && Number.isNaN(r.belt_speed)) return `第 ${i + 1} 行「路面速度」不是有效数值`
      if (r.wind_speed < 0 || r.wind_speed > 250) return `第 ${i + 1} 行风速需在 0-250 m/s`
      if (r.temperature < -40 || r.temperature > 85) return `第 ${i + 1} 行温度需在 -40~85 ℃`
      if (r.duration_sec < 0.5 || r.duration_sec > 3600) return `第 ${i + 1} 行采集时长需在 0.5-3600 s`
      if (r.repeat < 1 || r.repeat > 50 || !Number.isInteger(r.repeat)) return `第 ${i + 1} 行重复次数需为 1-50 整数`
      if (r.reference_area <= 0) return `第 ${i + 1} 行参考面积需大于 0`
    }
    return null
  }

  async function save() {
    const err = validate()
    if (err) {
      toast(err, false)
      return
    }
    const body = { name: name.trim(), scenario, conditions: rows, on_error: onError }
    try {
      if (editId) {
        await api.updateMatrix(editId, body)
        toast('矩阵已保存（版本 +1，旧版已留档）')
      } else {
        const m = await api.createMatrix(body)
        toast('矩阵已创建')
        setSelectedId(m.id)
      }
      setFormOpen(false)
      resetForm()
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败'
      toast(msg.includes('409') || msg.includes('执行') ? '已有任务在执行，无法修改' : msg, false)
    }
  }

  async function remove(m: TestMatrix) {
    try {
      await api.deleteMatrix(m.id)
      toast('矩阵已删除')
      if (selectedId === m.id) setSelectedId(null)
      if (editId === m.id) resetForm()
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : '删除失败'
      toast(msg.includes('执行') ? '已有任务在执行，无法删除' : msg, false)
    }
  }

  async function control(action: 'run' | 'pause' | 'resume' | 'abort') {
    if (!selectedId) return
    try {
      if (action === 'run') {
        const s = await api.runMatrix(selectedId, runExpId || null)
        setStatus(s)
        toast('矩阵已启动')
      } else {
        const s = await api.matrixControl(selectedId, action)
        setStatus(s)
        toast({ pause: '已暂停', resume: '已恢复', abort: '已中止' }[action])
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '操作失败'
      toast(msg.includes('执行') || msg.includes('409') ? '已有任务在执行' : msg, false)
    }
  }

  const progressPct =
    status && status.total_rows ? Math.round(((status.done_rows ?? 0) / status.total_rows) * 100) : 0
  const st = status?.status ?? 'idle'

  return (
    <div className="layout-2">
      <div className="panel">
        <div className="panel-head">
          <h2>矩阵列表</h2>
          <div className="actions actions-flush">
            {canEdit && (
              <button type="button" className="icon-btn" onClick={startCreate} title="新建试验矩阵">
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
              <th>场景</th>
              <th>行数</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id} className={selectedId === m.id ? 'row-active' : undefined}>
                <td>
                  <a className="link-btn" onClick={() => setSelectedId(m.id)}>{m.name}</a>
                </td>
                <td>{m.scenario}</td>
                <td className="mono">{m.conditions.length}</td>
                <td className="mono">v{m.version}</td>
                <td>
                  <div className="actions actions-flush">
                    <button
                      type="button"
                      className={`icon-btn ${selectedId === m.id ? 'active' : ''}`}
                      onClick={() => setSelectedId(m.id)}
                      title="打开执行面板"
                    >
                      <IconPlay size={16} />
                    </button>
                    {canEdit && (
                      <button type="button" className="icon-btn" onClick={() => loadForEdit(m)} title="编辑矩阵">
                        <IconEdit size={16} />
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className="icon-btn danger" onClick={() => setConfirmDelete(m)} title="删除矩阵">
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">暂无试验矩阵{canEdit ? '，点击右上角「+」新建' : ''}</div>}
      </div>

      <div className="panel">
        <h2>执行面板 {selected ? `· ${selected.name}` : ''}</h2>
        {!selected ? (
          <div className="empty">在左侧列表选择矩阵后在此执行</div>
        ) : (
          <>
            {canEdit && st !== 'running' && st !== 'paused' && (
              <div className="form-row">
                <label>关联实验</label>
                <select value={runExpId} onChange={(e) => setRunExpId(e.target.value)}>
                  <option value="">不关联（独立运行）</option>
                  {experiments.map((x) => (
                    <option key={x.id} value={x.id}>{x.title}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="ctl-row actions-mb">
              {canEdit && (st === 'idle' || ['completed', 'aborted', 'failed'].includes(st)) && (
                <button type="button" className="ctl-btn primary" onClick={() => control('run')} title="启动矩阵执行">
                  <IconPlay size={24} />
                  <span className="label-cap">启动</span>
                </button>
              )}
              {canEdit && st === 'running' && (
                <button type="button" className="ctl-btn" onClick={() => control('pause')} title="暂停在当前工况">
                  <IconPause size={24} />
                  <span className="label-cap">暂停</span>
                </button>
              )}
              {canEdit && st === 'paused' && (
                <button type="button" className="ctl-btn primary" onClick={() => control('resume')} title="从暂停处继续执行">
                  <IconPlay size={24} />
                  <span className="label-cap">恢复</span>
                </button>
              )}
              {canEdit && (st === 'running' || st === 'paused') && (
                <button type="button" className="ctl-btn danger" onClick={() => setConfirmAbort(true)} title="中止执行，当前工况作废">
                  <IconAbort size={24} />
                  <span className="label-cap">中止</span>
                </button>
              )}
              <span className={`badge ${st === 'running' ? 'ok' : st === 'failed' || st === 'aborted' ? 'danger' : st === 'paused' ? 'warn' : 'info'}`}>
                {MATRIX_STATUS_CN[st] ?? st}
              </span>
              <span className="badge mono">进度 {status?.progress ?? '0/0'}</span>
              <span className="badge">ETA {fmtEta(status?.eta_seconds)}</span>
            </div>

            <div className="health-bar health-bar--spaced">
              <i style={{ width: `${progressPct}%` }} />
            </div>

            {status?.current && (
              <div className="badge info badge-block">
                当前工况 #{status.current.row_index + 1}（第 {status.current.repeat_no} 次）：
                风速 {status.current.condition.wind_speed} m/s · 偏航 {status.current.condition.yaw_angle}° ·
                时长 {status.current.condition.duration_sec}s
              </div>
            )}

            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>重复</th>
                  <th>状态</th>
                  <th>run</th>
                </tr>
              </thead>
              <tbody>
                {(status?.rows ?? []).map((r) => (
                  <tr key={`${r.index}-${r.repeat_no}`}>
                    <td className="mono">{r.index + 1}</td>
                    <td className="mono">{r.repeat_no}</td>
                    <td>
                      <span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'running' ? 'info' : r.status === 'failed' ? 'danger' : ''}`}>
                        {ROW_STATUS_CN[r.status] ?? r.status}
                      </span>
                      {r.error && <div className="cell-error">{r.error}</div>}
                    </td>
                    <td>
                      {r.run_id ? (
                        <button type="button" className="icon-btn" onClick={() => onOpenRun(r.run_id!)} title="查看该工况采集数据">
                          <IconEye size={16} />
                        </button>
                      ) : (
                        <span className="text-dim">--</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!status?.rows?.length && <div className="empty">尚未执行，启动后在此查看每行进度</div>}
          </>
        )}
      </div>

      {/* 新建 / 编辑矩阵弹窗 */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        size="lg"
        title={editId ? `编辑矩阵（v${list.find((m) => m.id === editId)?.version ?? '?'}）` : '新建试验矩阵'}
        footer={
          <>
            <button className="btn" onClick={() => setFormOpen(false)}>取消</button>
            <button className="btn primary" onClick={save}>{editId ? '保存修改' : '创建矩阵'}</button>
          </>
        }
      >
        <div className="form-row">
          <label>名称</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="如：标模气动扫掠矩阵" />
        </div>
        <div className="form-row">
          <label>场景</label>
          <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {SCENARIOS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>行内出错策略</label>
          <select value={onError} onChange={(e) => setOnError(e.target.value as 'abort' | 'skip')}>
            <option value="abort">中止整个矩阵（abort）</option>
            <option value="skip">跳过该行继续（skip）</option>
          </select>
        </div>

        <h2 className="section-sub">工况行（{rows.length}）</h2>
        <div className="table-scroll">
          <table className="table matrix-edit-table">
            <thead>
              <tr>
                <th>#</th>
                {COND_FIELDS.map((f) => (
                  <th key={f.key}>
                    {f.label}
                    <span className="th-unit"> {f.unit}</span>
                  </th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  {COND_FIELDS.map((f) => (
                    <td key={f.key}>
                      <input
                        className="cell-input"
                        type="number"
                        step="any"
                        value={r[f.key] === null ? '' : String(r[f.key])}
                        placeholder={f.placeholder}
                        onChange={(e) => setRow(i, f.key, e.target.value)}
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="icon-btn danger"
                      disabled={rows.length <= 1}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      title="删除该行"
                    >
                      <IconTrash size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, emptyCondition()])}>+ 增行</button>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmAbort}
        onClose={() => setConfirmAbort(false)}
        onConfirm={() => {
          setConfirmAbort(false)
          control('abort')
        }}
        title="中止矩阵执行"
        danger
        confirmLabel="确认中止"
        message={`确认中止矩阵「${selected?.name ?? ''}」的当前执行？未完成的工况行将不会执行。`}
      />
      <ConfirmModal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
          setConfirmDelete(null)
        }}
        title="删除试验矩阵"
        danger
        confirmLabel="确认删除"
        message={`确认删除矩阵「${confirmDelete?.name ?? ''}」？该操作不可恢复，历史版本与执行记录将一并删除。`}
      />
    </div>
  )
}
