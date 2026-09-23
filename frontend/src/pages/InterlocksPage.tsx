import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, hasMinRole, type InterlockRule, type InterlockStatus } from '../api'
import { useTelemetry } from '../hooks/useTelemetry'
import { Modal, ConfirmModal } from '../components/Modal'
import { IconEdit, IconPlus, IconSafety, IconTrash } from '../components/icons'

const KIND_META: Record<string, { label: string; tone: string; hint: string }> = {
  alarm: { label: '报警', tone: 'warn', hint: '条件成立 = 违规，产生分级告警' },
  block: { label: '指令拦截', tone: 'info', hint: '条件是许可：不成立时拒绝目标指令' },
  auto_stop: { label: '自动停车', tone: 'danger', hint: '条件成立 = 违规，告警并自动停目标子系统' },
}

const VAR_HINTS = [
  'main_fan.wind_speed', 'main_fan.target_speed', 'rrs.belt_speed', 'rrs.fx',
  'cooling_water.supply_temp', 'compressed_air.pressure', '<子系统>.running / .ready / .fault',
]

type Draft = {
  name: string
  kind: 'alarm' | 'block' | 'auto_stop'
  condition: string
  severity: InterlockRule['severity']
  target_subsystem: string
  target_command: string
  message: string
  enabled: boolean
}

/** 真值表行：遥测实时态 + 库内静态信息（版本/内置标记）合并 */
type Row = InterlockStatus & { version?: number; builtin?: boolean }

const EMPTY_DRAFT: Draft = {
  name: '', kind: 'alarm', condition: '', severity: 'warning',
  target_subsystem: '', target_command: '', message: '', enabled: true,
}

/** 联锁矩阵：可配置安全联锁——实时真值表（遥测驱动）+ 规则 CRUD（维护员+，全程审计）。 */
export function InterlocksPage({ toast }: { toast: (msg: string, ok?: boolean) => void }) {
  const canEdit = hasMinRole('维护员')
  const { frame } = useTelemetry()
  const live = frame?.interlocks ?? []
  const [rules, setRules] = useState<InterlockRule[]>([])
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null)

  const refresh = useCallback(async () => {
    setRules(await api.listInterlocks())
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 挂载时拉取规则清单（与全站页面同一模式）
    refresh().catch((e) => toast(e instanceof Error ? e.message : String(e), false))
  }, [refresh, toast])

  // 真值表以遥测为准；规则静态信息（版本/触发统计）来自库，按 id 合并
  const rows: Row[] =
    live.length > 0
      ? live.map((st) => {
          const r = rules.find((x) => x.id === st.id)
          return { ...st, version: r?.version, builtin: r?.builtin }
        })
      : rules.map((r) => ({
          ...r,
          violated: false,
          pass: true,
          error: '',
        }))

  const violatedCount = rows.filter((r) => r.enabled && !r.pass && r.kind !== 'block').length

  function openCreate() {
    setEditId(null)
    setDraft(EMPTY_DRAFT)
    setEditOpen(true)
  }

  function openEdit(r: Row) {
    setEditId(r.id)
    setDraft({
      name: r.name, kind: r.kind, condition: r.condition, severity: r.severity as Draft['severity'],
      target_subsystem: r.target_subsystem, target_command: r.target_command,
      message: r.message, enabled: r.enabled,
    })
    setEditOpen(true)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      if (editId) {
        await api.updateInterlock(editId, { ...draft })
        toast(`联锁规则「${draft.name}」已更新`)
      } else {
        await api.createInterlock({ ...draft })
        toast(`联锁规则「${draft.name}」已创建`)
      }
      setEditOpen(false)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', false)
    }
  }

  async function toggle(r: Row) {
    try {
      await api.updateInterlock(r.id, { enabled: !r.enabled })
      toast(`「${r.name}」已${r.enabled ? '停用' : '启用'}`)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', false)
    }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try {
      await api.deleteInterlock(deleteTarget.id)
      toast(`「${deleteTarget.name}」已删除`)
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', false)
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>
          联锁矩阵
          {violatedCount > 0 && <span className="badge danger" style={{ marginLeft: 8 }}>{violatedCount} 项触发</span>}
        </h1>
        <div className="page-head-side">
          {canEdit && (
            <button type="button" className="btn primary" onClick={openCreate}>
              <IconPlus size={14} /> 新建规则
            </button>
          )}
        </div>
      </header>

      <div className="panel">
        <div className="ilk-list">
        {rows.map((r) => {
          const km = KIND_META[r.kind] ?? KIND_META.alarm
          // 状态灯：停用=灰，error=黄；报警/自动停车违规=红；许可不成立（block）=黄（待机时是常态，不算触发）
          const lamp = !r.enabled
            ? 'dim'
            : r.error
              ? 'warn'
              : r.pass
                ? 'ok'
                : r.kind === 'block'
                  ? 'warn'
                  : 'danger'
          return (
            <div key={r.id} className={`ilk-row ${r.enabled && !r.pass && r.kind !== 'block' ? 'ilk-row--tripped' : ''} ${!r.enabled ? 'ilk-row--off' : ''}`}>
              <span className={`ilk-lamp ${lamp}`} title={r.error ? `求值错误：${r.error}` : r.pass ? '正常 / 许可成立' : '触发 / 许可不成立'} />
              <div className="ilk-main">
                <div className="ilk-title">
                  <span className="ilk-name">{r.name}</span>
                  <span className={`badge ${km.tone}`}>{km.label}</span>
                  {!r.enabled && <span className="badge dim">已停用</span>}
                  {r.builtin && <span className="badge dim">内置</span>}
                  {r.version != null && <span className="badge dim mono">v{r.version}</span>}
                </div>
                <div className="ilk-cond mono">{r.condition}</div>
                {r.message && <div className="ilk-msg muted">{r.message}</div>}
              </div>
              <div className="ilk-side">
                {(r.kind === 'block' || r.kind === 'auto_stop') && (
                  <span className="badge mono" title={r.kind === 'block' ? '许可不成立时拦截该指令' : '违规时自动下发该指令'}>
                    {r.target_subsystem}.{r.target_command}
                  </span>
                )}
                <span className="muted ilk-trig">
                  触发 {r.trigger_count} 次{r.last_triggered ? ` · 最近 ${r.last_triggered.replace('T', ' ')}` : ''}
                </span>
              </div>
              {canEdit && (
                <div className="ilk-actions">
                  <button type="button" className={`btn ${r.enabled ? '' : 'primary'}`} onClick={() => toggle(r)}>
                    {r.enabled ? '停用' : '启用'}
                  </button>
                  <button type="button" className="btn" onClick={() => openEdit(r)}>
                    <IconEdit size={13} /> 编辑
                  </button>
                  <button type="button" className="btn danger" onClick={() => setDeleteTarget(r)} title="删除规则">
                    <IconTrash size={13} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <div className="empty">暂无联锁规则</div>}
      </div>

      <div className="hint" style={{ marginTop: 10 }}>
        <IconSafety size={13} /> 表达式变量形如 <span className="mono">子系统.测点</span>（如 {VAR_HINTS.slice(0, 2).join('、')}），另支持 running/ready/fault 状态量；支持 and/or/not、比较、四则运算、abs/min/max。修改即时生效并写审计。
      </div>

      {/* 新建 / 编辑弹窗 */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editId ? '编辑联锁规则' : '新建联锁规则'}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditOpen(false)}>取消</button>
            <button type="submit" form="ilk-form" className="btn primary">{editId ? '保存' : '创建'}</button>
          </>
        }
      >
        <form id="ilk-form" onSubmit={submit}>
          <div className="form-row">
            <label>规则名称</label>
            <input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={40} placeholder="如：主风机启动许可" />
          </div>
          <div className="form-row">
            <label>类型</label>
            <select className="field" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}>
              {Object.entries(KIND_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </div>
          <div className="hint" style={{ margin: '-4px 0 8px' }}>{KIND_META[draft.kind].hint}</div>
          <div className="form-row">
            <label>{draft.kind === 'block' ? '许可条件' : '触发条件'}</label>
            <input
              className="field mono"
              value={draft.condition}
              onChange={(e) => setDraft({ ...draft, condition: e.target.value })}
              required
              placeholder={draft.kind === 'block' ? 'cooling_water.running and compressed_air.running' : 'main_fan.wind_speed > 30 and rrs.belt_speed < main_fan.wind_speed * 0.8'}
            />
          </div>
          <div className="hint" style={{ margin: '-4px 0 8px' }}>可用变量：{VAR_HINTS.join('　')}</div>
          {draft.kind !== 'alarm' ? (
            <div className="form-row">
              <label>目标子系统.指令</label>
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                <input className="field" value={draft.target_subsystem} onChange={(e) => setDraft({ ...draft, target_subsystem: e.target.value })} placeholder="main_fan" required />
                <input className="field" value={draft.target_command} onChange={(e) => setDraft({ ...draft, target_command: e.target.value })} placeholder={draft.kind === 'block' ? 'start（* 表示全部）' : 'stop'} required={draft.kind === 'block'} />
              </div>
            </div>
          ) : (
            <div className="form-row">
              <label>告警级别</label>
              <select className="field" value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Draft['severity'] })}>
                <option value="info">提示</option>
                <option value="warning">预警</option>
                <option value="alarm">报警</option>
                <option value="critical">严重</option>
              </select>
            </div>
          )}
          {draft.kind === 'auto_stop' && (
            <div className="form-row">
              <label>告警级别</label>
              <select className="field" value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Draft['severity'] })}>
                <option value="alarm">报警</option>
                <option value="critical">严重</option>
              </select>
            </div>
          )}
          <div className="form-row">
            <label>提示语</label>
            <input className="field" value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} maxLength={120} placeholder="触发/拦截时向操作员显示的原因" />
          </div>
          <div className="form-row">
            <label>启用</label>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        title="删除联锁规则"
        message={`确认删除「${deleteTarget?.name}」？删除后其保护立即失效，相关联锁告警自动恢复。`}
        confirmLabel="删除"
        danger
      />
      </div>
    </>
  )
}
