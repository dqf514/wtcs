import { useEffect, useState } from 'react'
import { api, type LinkagePreview } from '../api'
import { Modal } from './Modal'
import { IconWarning } from './icons'

type ItemState = { checked: boolean; value: string }

/**
 * 风速协调弹窗：设定风速时自动带出关联子系统建议设定（路面跟随/抽吸比/尾气跟随），
 * 可逐项勾选与修改；冲突告警显著展示。主操作（设定风速）始终执行，勾选项走联动下发。
 */
export function LinkageModal({
  speed,
  fanRunning,
  onClose,
  onApply,
}: {
  speed: number
  fanRunning: boolean
  onClose: () => void
  /** 应用：主操作 + 勾选的联动项（params 可能被用户修改过） */
  onApply: (items: { id: string; label: string; subsystem: string; command: string; params: Record<string, unknown> }[]) => void
}) {
  const [preview, setPreview] = useState<LinkagePreview | null>(null)
  const [error, setError] = useState('')
  const [itemState, setItemState] = useState<Record<string, ItemState>>({})

  useEffect(() => {
    api
      .linkagePreview(speed)
      .then((p) => {
        if (!p.ok) {
          setError(p.reject || '目标风速不合法')
          return
        }
        setPreview(p)
        const init: Record<string, ItemState> = {}
        for (const it of p.items) {
          init[it.id] = { checked: it.default_checked, value: String(it.suggested ?? '') }
        }
        setItemState(init)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [speed])

  const selected = (preview?.items ?? []).filter((it) => itemState[it.id]?.checked)

  function apply() {
    const items = selected.map((it) => {
      const st = itemState[it.id]
      const params = { ...it.params }
      // 数值参数允许用户在弹窗里改；布尔参数（如 fan_accel）保持建议值
      if (it.param_key !== 'fan_accel' && st && st.value !== '') {
        params[it.param_key] = Number(st.value)
      }
      return { id: it.id, label: it.label, subsystem: it.subsystem, command: it.command, params }
    })
    onApply(items)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`风速协调 · 目标 ${speed} m/s`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn primary" onClick={apply} disabled={!!error || !preview}>
            {fanRunning ? '确认调整' : '确认设定并启动'}{selected.length > 0 ? `（含 ${selected.length} 项联动）` : ''}
          </button>
        </>
      }
    >
      {error ? (
        <div className="badge danger">{error}</div>
      ) : !preview ? (
        <div className="empty">计算联动建议…</div>
      ) : (
        <>
          {preview.warnings.length > 0 && (
            <div className="link-warnings">
              {preview.warnings.map((w, i) => (
                <div key={i} className="link-warning">
                  <IconWarning size={14} /> {w}
                </div>
              ))}
            </div>
          )}

          <div className="link-main">
            <span className="link-main-label">主操作 · 主风机目标风速</span>
            <span className="link-main-value mono">{speed} m/s</span>
            <span className="muted">{fanRunning ? '运行中平滑调整' : '停机时按该风速启动'}</span>
          </div>

          {preview.items.length > 0 && <div className="label-cap" style={{ margin: '12px 0 6px' }}>关联设定建议</div>}
          <div className="link-items">
            {preview.items.map((it) => {
              const st = itemState[it.id] ?? { checked: false, value: '' }
              return (
                <label key={it.id} className={`link-item ${st.checked ? 'checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={st.checked}
                    onChange={(e) => setItemState({ ...itemState, [it.id]: { ...st, checked: e.target.checked } })}
                  />
                  <span className="link-item-label">{it.label}</span>
                  {it.param_key === 'fan_accel' ? (
                    <span className="badge info">开启跟随</span>
                  ) : (
                    <span className="link-item-value">
                      <input
                        className="field field-sm mono"
                        type="number"
                        value={st.value}
                        disabled={!st.checked}
                        onChange={(e) => setItemState({ ...itemState, [it.id]: { ...st, value: e.target.value } })}
                        onClick={(e) => e.preventDefault()}
                      />
                      <span className="cmd-unit">{it.unit}</span>
                    </span>
                  )}
                  {it.current != null && <span className="muted link-item-current">当前 {it.current} {it.unit}</span>}
                  {it.warn && st.checked && <span className="link-item-warn">{it.warn}</span>}
                </label>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
