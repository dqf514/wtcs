import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  api,
  hasMinRole,
  type Experiment,
  type ExperimentRun,
  type Order,
  type RunSample,
  type RunSummary,
} from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { RunChart } from '../components/RunChart'
import { GROUPS, PALETTE, RUN_STATUS_CN } from '../components/runMeta'
import { Tabs } from '../components/Tabs'
import { Modal, ConfirmModal } from '../components/Modal'
import { MatrixPanel } from '../components/MatrixPanel'
import { ProfilePanel } from '../components/ProfilePanel'
import { ExpSequencePanel } from '../components/ExpSequencePanel'
import { IconPlus, IconRefresh, IconEye, IconAbort, IconPlay, IconReports } from '../components/icons'

const SCENARIOS = ['气动实验', '声学实验', 'WLTP滑行', '参观演示']

/** 实验流水线的真实阶段序列（与后端 run_experiment_pipeline 的推进一致，值为 ExperimentPhase 中文枚举） */
const PHASE_STEPS: { key: string; desc: string }[] = [
  { key: '点位规划', desc: '生成执行上下文与工况配置快照' },
  { key: '工况设置', desc: '下发风速 / 偏航 / 路面 / 边界层 / 温湿度目标' },
  { key: '就绪校验', desc: '子系统无故障且就绪，等待风速稳定（60s 看门狗）' },
  { key: '点位移动', desc: '移测架运动到目标坐标并确认到位' },
  { key: '数据采集', desc: '按采集时长记录 run 采样（天平 / 压力 / 声学 / 环境）' },
  { key: '实验结束', desc: '停机收尾：停风机 / 路面 / 边界层' },
]

/** 实验执行阶段条：已完成 / 进行中（脉冲高亮）/ 未到达 三态；已中止与未启动单独标注 */
function PhaseStepper({ phase, hasRuns }: { phase: string; hasRuns: boolean }) {
  const aborted = phase === '已中止'
  // 空闲且已有 run = 流水线已完整跑完一轮，全部标记完成；否则尚未启动
  const idx = aborted
    ? -1
    : phase === '空闲'
      ? hasRuns
        ? PHASE_STEPS.length
        : -1
      : PHASE_STEPS.findIndex((s) => s.key === phase)
  const current = idx >= 0 && idx < PHASE_STEPS.length ? PHASE_STEPS[idx] : null
  return (
    <div className="phase-stepper">
      <ol className="phase-steps">
        {PHASE_STEPS.map((s, i) => {
          const state = idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? 'current' : 'todo'
          return (
            <li key={s.key} className={`phase-step phase-step--${state}`}>
              {i > 0 && <i className="phase-step-link" />}
              <i className="phase-step-dot" />
              <span>{s.key}</span>
            </li>
          )
        })}
        {aborted && <span className="badge danger">已中止</span>}
        {idx === PHASE_STEPS.length && <span className="badge ok">已完成</span>}
      </ol>
      <div className="phase-step-desc text-dim">
        {current ? `当前阶段：${current.key} —— ${current.desc}` : aborted ? '流水线已被中止，重新执行可从头开始' : hasRuns ? '流水线已完成一轮执行' : '尚未执行，点击列表中的 ▶ 启动实验流水线'}
      </div>
    </div>
  )
}

export function ExperimentsPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canOperate = hasMinRole('操作员')
  const { frame } = useTelemetry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab')
    return t === 'matrices' || t === 'profiles' || t === 'sequences' ? t : 'experiments'
  })
  const [list, setList] = useState<Experiment[]>([])
  // 订单绑定：新建实验可挂到订单下，列表展示订单号
  const [orders, setOrders] = useState<Order[]>([])
  const [orderId, setOrderId] = useState('')

  // 新建实验（Modal 表单）
  const [createOpen, setCreateOpen] = useState(false)
  const [title, setTitle] = useState('气动标模工况-01')
  const [scenario, setScenario] = useState('气动实验')
  const [wind, setWind] = useState(40)
  const [temp, setTemp] = useState(25)
  const [yaw, setYaw] = useState(0)
  const [duration, setDuration] = useState(3)
  const [refArea, setRefArea] = useState(2)
  const [travX, setTravX] = useState(100)
  const [travY, setTravY] = useState(50)
  const [travZ, setTravZ] = useState(20)
  const [running, setRunning] = useState(false)
  const [abortTarget, setAbortTarget] = useState<Experiment | null>(null)

  // 数据查看
  const [detailId, setDetailId] = useState<string | null>(null)
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [activeRun, setActiveRun] = useState<ExperimentRun | null>(null)
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [samples, setSamples] = useState<RunSample[]>([])
  const [groups, setGroups] = useState<string[]>(['balance', 'env'])
  const [downsample, setDownsample] = useState(1)

  const overview = frame?.overview
  const activeExpId = overview?.active_experiment_id ?? null

  const refresh = useCallback(async () => {
    setList(await api.experiments())
  }, [])

  useEffect(() => {
    refresh().catch((e) => toast(String(e), false))
    api.listOrders().then(setOrders).catch(() => {})
  }, [])

  const loadRuns = useCallback(async (expId: string) => {
    setDetailId(expId)
    setRuns(await api.experimentRuns(expId))
  }, [])

  const openRun = useCallback(
    async (runId: string) => {
      try {
        const run = await api.run(runId)
        setActiveRun(run)
        const [sum, samp] = await Promise.all([
          api.runSummary(runId),
          api.runSamples(runId, groups, downsample),
        ])
        setSummary(sum)
        setSamples(samp.samples)
        if (run.experiment_id && run.experiment_id !== detailId) {
          setDetailId(run.experiment_id)
          setRuns(await api.experimentRuns(run.experiment_id))
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : '加载 run 失败', false)
      }
    },
    [detailId, groups, downsample],
  )

  /** 矩阵执行面板"查看数据"入口：切回实验 tab 并打开对应 run */
  const openRunFromMatrix = useCallback(
    (runId: string) => {
      setTab('experiments')
      void openRun(runId)
    },
    [openRun],
  )

  // 矩阵执行面板 / 其他入口的 ?run= 深链
  useEffect(() => {
    const runId = searchParams.get('run')
    if (runId) {
      openRun(runId)
      searchParams.delete('run')
      setSearchParams(searchParams, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 通道组 / 降采样变化时重新拉采样
  useEffect(() => {
    if (!activeRun) return
    api
      .runSamples(activeRun.id, groups, downsample)
      .then((r) => setSamples(r.samples))
      .catch(() => {})
  }, [groups, downsample])

  async function create(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createExperiment({
        title,
        scenario,
        wind_speed: wind,
        temperature: temp,
        yaw_angle: yaw,
        belt_speed: wind,
        traverse_x: travX,
        traverse_y: travY,
        traverse_z: travZ,
        duration_sec: duration,
        reference_area: refArea,
        notes: '建设期仿真实验',
        ...(orderId ? { order_id: orderId } : {}),
      })
      toast('实验已创建')
      setCreateOpen(false)
      setOrderId('')
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建失败', false)
    }
  }

  async function run(id: string) {
    setRunning(true)
    try {
      const exp = await api.runExperiment(id)
      toast(`实验流水线完成：${exp.phase}`)
      await refresh()
      if (detailId === id) await loadRuns(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '执行失败'
      toast(msg.includes('执行') ? '已有任务在执行' : msg, false)
      await refresh()
    } finally {
      setRunning(false)
    }
  }

  async function abort(id: string) {
    try {
      await api.setExperimentPhase(id, '已中止')
      toast('已请求中止')
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '中止失败', false)
    }
  }

  /** 实验数据面板 → 一键生成关联该实验的运行报告（数据中心可预览/打印） */
  async function generateReport(expId: string) {
    const exp = list.find((x) => x.id === expId)
    try {
      await api.createReport({
        title: `${exp?.title ?? expId} 运行报告`,
        experiment_id: expId,
      })
      toast('报告已生成，可在「数据中心 · 分析报告」预览与打印')
    } catch (err) {
      toast(err instanceof Error ? err.message : '生成报告失败', false)
    }
  }

  const charts = useMemo(() => {
    return GROUPS.filter((g) => groups.includes(g.id)).map((g, gi) => {
      const keys = new Set<string>()
      for (const s of samples) {
        const ch = s.channels?.[g.id]
        if (ch) Object.keys(ch).forEach((k) => keys.add(k))
      }
      // 天平组默认聚焦 Fx/Fz，其余通道太多时全部绘制
      let keyList = Array.from(keys)
      if (g.id === 'balance' && keys.has('fx') && keys.has('fz')) keyList = ['fx', 'fz']
      const series = keyList.map((k, ki) => ({
        label: k,
        color: PALETTE[(gi * 3 + ki) % PALETTE.length],
        points: samples
          .map((s): [number, number] | null => {
            const v = s.channels?.[g.id]?.[k]
            return typeof v === 'number' ? [s.t, v] : null
          })
          .filter((p): p is [number, number] => p !== null),
      }))
      return { id: g.id, title: g.label, series }
    })
  }, [samples, groups])

  const detail = list.find((x) => x.id === detailId)
  // 执行中的实验阶段以 WS 概览为准（实时推进），其余用列表里的持久化阶段
  const detailPhase =
    detailId && detailId === activeExpId
      ? (overview?.experiment_phase ?? detail?.phase ?? '空闲')
      : (detail?.phase ?? '空闲')

  return (
    <>
      <header className="page-head">
        <h1>试验中心</h1>
        <div className="page-head-side">
          {canOperate && tab === 'experiments' && (
            <button type="button" className="icon-btn" onClick={() => setCreateOpen(true)} title="新建实验任务">
              <IconPlus size={18} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => refresh().catch(() => {})} title="刷新实验列表">
            <IconRefresh size={18} />
          </button>
        </div>
      </header>

      <Tabs
        tabs={[
          { key: 'experiments', label: '实验' },
          { key: 'matrices', label: '试验矩阵' },
          { key: 'profiles', label: '风速程控' },
          { key: 'sequences', label: '序列编排' },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel="试验中心分段"
      />

      {tab === 'matrices' && <MatrixPanel toast={toast} onOpenRun={openRunFromMatrix} />}

      {tab === 'profiles' && <ProfilePanel toast={toast} />}

      {tab === 'sequences' && <ExpSequencePanel toast={toast} />}

      {tab === 'experiments' && (
        <>
          <div className="panel">
            <div className="panel-head">
              <h2>实验列表</h2>
            </div>
            {activeExpId && overview && overview.experiment_phase !== '空闲' && (
              <div className="badge info badge-block">
                正在执行：{list.find((x) => x.id === activeExpId)?.title ?? activeExpId} · 当前阶段 {overview.experiment_phase}
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>场景</th>
                  <th>订单</th>
                  <th>阶段</th>
                  <th>风速</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id} className={detailId === x.id ? 'row-active' : undefined}>
                    <td>{x.title}</td>
                    <td>{x.scenario}</td>
                    <td className="mono">{x.order_id ? (orders.find((o) => o.id === x.order_id)?.order_no ?? '--') : ''}</td>
                    <td>{x.phase}</td>
                    <td className="mono">{x.wind_speed}</td>
                    <td>
                      <div className="actions actions-flush">
                        {canOperate && (
                          <button
                            type="button"
                            className="icon-btn"
                            disabled={running || (!!activeExpId && activeExpId !== x.id)}
                            onClick={() => run(x.id)}
                            title="一键自动调度：按工况参数顺序执行实验流水线"
                          >
                            <IconPlay size={16} />
                          </button>
                        )}
                        {canOperate && activeExpId === x.id && overview?.experiment_phase !== '空闲' && (
                          <button type="button" className="icon-btn danger" onClick={() => setAbortTarget(x)} title="中止该实验的运行流水线">
                            <IconAbort size={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          className={`icon-btn ${detailId === x.id ? 'active' : ''}`}
                          onClick={() => loadRuns(x.id).catch((e) => toast(String(e), false))}
                          title="查看采集数据（runs）"
                        >
                          <IconEye size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!list.length && (
              <div className="empty">暂无实验{canOperate ? '，点击右上角「+」新建实验任务' : ''}</div>
            )}
          </div>

          {detailId && (
            <div className="panel panel-mt">
              <div className="panel-head">
                <h2>实验数据 · {detail?.title ?? detailId}</h2>
                <div className="actions actions-flush">
                  {canOperate && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => generateReport(detailId)}
                      title="基于该实验的全部 run 生成运行报告（数据中心 · 分析报告查看）"
                    >
                      <IconReports size={16} />
                    </button>
                  )}
                  <button type="button" className="icon-btn" onClick={() => loadRuns(detailId).catch(() => {})} title="刷新 runs">
                    <IconRefresh size={16} />
                  </button>
                </div>
              </div>
              <PhaseStepper phase={detailPhase} hasRuns={runs.length > 0} />
              <table className="table">
                <thead>
                  <tr>
                    <th>开始时间</th>
                    <th>状态</th>
                    <th>config_hash</th>
                    <th>操作者</th>
                    <th>来源</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className={activeRun?.id === r.id ? 'row-active' : undefined}>
                      <td className="mono">{(r.started_at ?? r.created_at ?? '').replace('T', ' ').slice(0, 19)}</td>
                      <td>
                        <span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'running' ? 'info' : 'warn'}`}>
                          {RUN_STATUS_CN[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="mono" title={r.config_hash}>{(r.config_hash || '').slice(0, 12)}</td>
                      <td>{r.operator}</td>
                      <td>{r.matrix_id ? `矩阵第 ${r.row_index + 1} 行` : '实验流水线'}</td>
                      <td>
                        <button
                          type="button"
                          className={`icon-btn ${activeRun?.id === r.id ? 'active' : ''}`}
                          onClick={() => openRun(r.id)}
                          title="查看该 run 的采样曲线与统计"
                        >
                          <IconEye size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!runs.length && <div className="empty">该实验还没有采集 run，执行一次实验或矩阵后在此查看</div>}

              {activeRun && (
                <div className="run-detail">
                  <h2 className="section-sub">run {activeRun.id.slice(0, 8)} · 配置快照</h2>
                  <div className="badge-row">
                    {Object.entries(activeRun.config ?? {}).map(([k, v]) => (
                      <span key={k} className="badge">{k}: {String(v)}</span>
                    ))}
                  </div>

                  {summary && (
                    <>
                      <h2 className="section-sub">统计摘要</h2>
                      {summary.coefficients?.Cd !== undefined && (
                        <div className="badge-row">
                          <span className="badge ok">Cd {summary.coefficients.Cd}</span>
                          <span className="badge ok">Cl {summary.coefficients.Cl}</span>
                          <span className="badge">动压 {summary.coefficients.dynamic_pressure_Pa} Pa</span>
                          <span className="badge">参考面积 {summary.coefficients.reference_area_m2} m²</span>
                        </div>
                      )}
                      <div className="table-scroll">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>通道组</th><th>通道</th><th>均值</th><th>最大</th><th>最小</th><th>标准差</th><th>样本</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(summary.stats ?? {}).flatMap(([g, chans]) =>
                              Object.entries(chans).map(([k, s]) => (
                                <tr key={`${g}.${k}`}>
                                  <td>{g}</td>
                                  <td className="mono">{k}</td>
                                  <td className="mono">{s.mean}</td>
                                  <td className="mono">{s.max}</td>
                                  <td className="mono">{s.min}</td>
                                  <td className="mono">{s.std}</td>
                                  <td className="mono">{s.count}</td>
                                </tr>
                              )),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  <h2 className="section-sub">采样曲线</h2>
                  <div className="actions actions-flush">
                    {GROUPS.map((g) => (
                      <label key={g.id} className="badge badge-check">
                        <input
                          type="checkbox"
                          checked={groups.includes(g.id)}
                          onChange={(e) =>
                            setGroups((gs) => (e.target.checked ? [...gs, g.id] : gs.filter((x) => x !== g.id)))
                          }
                        />
                        {g.label}
                      </label>
                    ))}
                    <label className="cmd-label">降采样 1/</label>
                    <input
                      className="field field-sm"
                      type="number"
                      min={1}
                      value={downsample}
                      onChange={(e) => setDownsample(Math.max(1, Number(e.target.value) || 1))}
                    />
                    <span className="badge mono">{samples.length} 点</span>
                  </div>
                  {charts.map((c) => (
                    <RunChart key={c.id} title={c.title} series={c.series} />
                  ))}
                  {!samples.length && <div className="empty">该 run 暂无采样数据</div>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* 新建实验弹窗 */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="md"
        title="新建实验任务"
        footer={
          <>
            <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            <button className="btn primary" form="wtcs-exp-create" type="submit">创建</button>
          </>
        }
      >
        <form id="wtcs-exp-create" onSubmit={create}>
          <div className="form-row">
            <label>标题</label>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
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
            <label>所属订单</label>
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">无（不绑定订单）</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.order_no} · {o.title}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>风速 m/s</label>
            <input type="number" value={wind} onChange={(e) => setWind(Number(e.target.value))} />
          </div>
          <div className="form-row">
            <label>温度 ℃</label>
            <input type="number" value={temp} onChange={(e) => setTemp(Number(e.target.value))} />
          </div>
          <div className="form-row">
            <label>偏航 °</label>
            <input type="number" value={yaw} onChange={(e) => setYaw(Number(e.target.value))} />
          </div>
          <div className="form-row">
            <label>移测架 X/Y/Z mm</label>
            <div className="flex-row">
              <input type="number" value={travX} onChange={(e) => setTravX(Number(e.target.value))} />
              <input type="number" value={travY} onChange={(e) => setTravY(Number(e.target.value))} />
              <input type="number" value={travZ} onChange={(e) => setTravZ(Number(e.target.value))} />
            </div>
          </div>
          <div className="form-row">
            <label>采集时长 s</label>
            <input type="number" step="0.5" min="0.5" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
          </div>
          <div className="form-row">
            <label>参考面积 m²</label>
            <input type="number" step="0.1" min="0.1" value={refArea} onChange={(e) => setRefArea(Number(e.target.value))} />
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={!!abortTarget}
        onClose={() => setAbortTarget(null)}
        onConfirm={() => {
          if (abortTarget) void abort(abortTarget.id)
          setAbortTarget(null)
        }}
        title="中止实验流水线"
        danger
        confirmLabel="确认中止"
        message={`确认中止实验「${abortTarget?.title ?? ''}」的运行流水线？进行中的采集与设备动作将停止。`}
      />
    </>
  )
}
