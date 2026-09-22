import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type Experiment,
  type ExperimentRun,
  type RunSample,
  type RunSummary,
} from '../api'
import { Modal } from './Modal'
import { RunChart } from './RunChart'
import { GROUPS, PALETTE, RUN_STATUS_CN } from './runMeta'
import { IconEye } from './icons'

function errMsg(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

/**
 * 客户门户「实验数据」弹窗（只读）：
 * run 列表 → 选中 run 的配置快照 / 气动系数 / 统计摘要 / 采样曲线；
 * 采集中 run 每 5 秒自动刷新；关联报告可再开一层 iframe 预览。
 * 客户调用的接口后端已做归属校验，403 时仅 toast 提示。
 */
export function ExperimentDataModal({
  exp,
  toast,
  onClose,
}: {
  exp: Experiment | null
  toast: (msg: string, ok?: boolean) => void
  onClose: () => void
}) {
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [activeRun, setActiveRun] = useState<ExperimentRun | null>(null)
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [samples, setSamples] = useState<RunSample[]>([])
  const [groups, setGroups] = useState<string[]>(['balance', 'env'])
  const [downsample, setDownsample] = useState(1)
  const [reports, setReports] = useState<{ id: string; title: string; created_at: string }[]>([])
  const [preview, setPreview] = useState<{ id: string; title: string; html: string } | null>(null)

  // 打开实验时加载 run 列表与关联报告（报告列表后端已按客户过滤，再按 experiment_id 匹配本实验）
  useEffect(() => {
    if (!exp) return
    setRuns([])
    setActiveRun(null)
    setSummary(null)
    setSamples([])
    setReports([])
    api.experimentRuns(exp.id).then(setRuns).catch((e) => toast(errMsg(e, '加载 run 列表失败'), false))
    api
      .reports()
      .then((list) => setReports(list.filter((r) => r.experiment_id === exp.id)))
      .catch((e) => toast(errMsg(e, '加载报告列表失败'), false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exp?.id])

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
      } catch (e) {
        toast(errMsg(e, '加载 run 失败'), false)
      }
    },
    [groups, downsample, toast],
  )

  // 通道组 / 降采样变化时重新拉采样
  useEffect(() => {
    if (!activeRun) return
    api
      .runSamples(activeRun.id, groups, downsample)
      .then((r) => setSamples(r.samples))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, downsample])

  // 采集中 run：每 5 秒自动刷新状态 / 统计 / 曲线（切换 run 或弹窗卸载时清理定时器）
  useEffect(() => {
    if (activeRun?.status !== 'running') return
    const runId = activeRun.id
    const timer = window.setInterval(() => {
      Promise.all([api.run(runId), api.runSummary(runId), api.runSamples(runId, groups, downsample)])
        .then(([run, sum, samp]) => {
          setActiveRun(run)
          setSummary(sum)
          setSamples(samp.samples)
        })
        .catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, groups, downsample])

  async function openReport(id: string) {
    try {
      const r = await api.report(id)
      setPreview({ id: r.id, title: r.title, html: r.html })
    } catch (e) {
      toast(errMsg(e, '加载报告失败'), false)
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

  return (
    <>
      {/* 报告预览打开时屏蔽外层 Esc/遮罩关闭，避免两层一起被关掉 */}
      <Modal open={!!exp} onClose={() => { if (!preview) onClose() }} size="lg" title={`实验数据 · ${exp?.title ?? ''}`}>
        {exp && (
          <>
            <div className="badge-row">
              <span className="badge info">{exp.phase}</span>
              <span className="badge mono">创建于 {exp.created_at.replace('T', ' ').slice(0, 19)}</span>
            </div>

            <h2 className="section-sub">采集 run 列表</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>开始时间</th>
                  <th>状态</th>
                  <th>操作者</th>
                  <th>来源</th>
                  <th>查看</th>
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
            {!runs.length && <div className="empty">实验尚未执行，过程数据将在试验开始后可见</div>}

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
                {activeRun.status === 'running' && (
                  <div className="badge info badge-block">采集中 · 每 5 秒自动刷新</div>
                )}
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

            <h2 className="section-sub">关联报告</h2>
            <table className="table">
              <thead>
                <tr><th>标题</th><th>创建时间</th><th>查看</th></tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td className="mono">{r.created_at.replace('T', ' ').slice(0, 19)}</td>
                    <td>
                      <button type="button" className="icon-btn" onClick={() => openReport(r.id)} title="预览该报告">
                        <IconEye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!reports.length && <div className="empty">暂无关联报告</div>}
          </>
        )}
      </Modal>

      {/* 报告预览（iframe srcDoc，与数据中心一致） */}
      <Modal open={!!preview} onClose={() => setPreview(null)} size="lg" title={preview?.title ?? '报告预览'}>
        {preview && (
          <iframe className="report-frame report-frame--modal" title="report" srcDoc={preview.html} sandbox="allow-same-origin allow-modals" />
        )}
      </Modal>
    </>
  )
}
