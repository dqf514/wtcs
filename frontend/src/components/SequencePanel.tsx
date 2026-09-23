import { useEffect, useState } from 'react'
import { api, type SequenceDef } from '../api'
import type { TelemetryFrame } from '../hooks/useTelemetry'
import { CommandButton } from './CommandButton'
import { Modal, ConfirmModal } from './Modal'
import { IconPlay, IconStop } from './icons'

const STEP_ICON: Record<string, { text: string; cls: string }> = {
  pending: { text: '○', cls: 'dim' },
  running: { text: '◌', cls: 'info' },
  ok: { text: '✓', cls: 'ok' },
  failed: { text: '✗', cls: 'danger' },
  skipped: { text: '—', cls: 'dim' },
}

const EXEC_STATE_LABEL: Record<string, { label: string; tone: string }> = {
  running: { label: '执行中', tone: 'info' },
  succeeded: { label: '执行成功', tone: 'ok' },
  failed: { label: '执行失败', tone: 'danger' },
  aborted: { label: '已中止', tone: 'warn' },
}

/**
 * 一键启停（系统序列）：开车/停车按依赖顺序自动执行全部子系统。
 * 执行进度通过遥测快照（sequence_exec）实时驱动，任何终端都能看到同一份进度。
 */
export function SequencePanel({ frame, toast }: { frame: TelemetryFrame | null; toast: (msg: string, ok?: boolean) => void }) {
  const [seqs, setSeqs] = useState<SequenceDef[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [abortConfirm, setAbortConfirm] = useState(false)

  const sysState = frame?.system_state
  const exec = frame?.sequence_exec ?? null
  const busy = exec?.state === 'running'

  useEffect(() => {
    api.listSequences().then(setSeqs).catch(() => {})
  }, [])

  const startup = seqs.find((s) => s.kind === 'startup')
  const shutdown = seqs.find((s) => s.kind === 'shutdown')

  async function run(id: string) {
    try {
      await api.executeSequence(id)
      setModalOpen(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : '序列启动失败', false)
    }
  }

  async function abort() {
    try {
      await api.abortSequence()
      toast('已请求中止序列')
    } catch (err) {
      toast(err instanceof Error ? err.message : '中止失败', false)
    }
  }

  // 执行保护：急停/安全异常/序列占用时禁用；开车仅在未运行时可发，停车仅在非待机时可发
  const startupDisabled =
    busy || !sysState || ['running', 'stopping', 'e_stop', 'safety_fault'].includes(sysState.state)
  const shutdownDisabled =
    busy || !sysState || ['standby', 'e_stop', 'safety_fault'].includes(sysState.state)

  const execMeta = exec ? EXEC_STATE_LABEL[exec.state] : null

  return (
    <>
      <div className="cmd-block">
        <div className="label-cap cmd-block-head">系统序列 · 一键启停</div>
        <div className="ctl-row">
          <CommandButton
            variant="primary"
            icon={<IconPlay size={22} />}
            disabled={startupDisabled || !startup}
            title={startup ? `${startup.name}：${startup.steps.map((s) => s.label).join(' → ')}` : '无开车序列'}
            confirmTitle="一键开车"
            confirmMessage={`确认执行「${startup?.name ?? '一键开车'}」？系统将按依赖顺序自动启动：${startup?.steps.map((s) => s.label).join(' → ')}。任一步失败将自动中止。`}
            onClick={() => startup && run(startup.id)}
          >
            一键开车
          </CommandButton>
          <CommandButton
            variant="danger"
            icon={<IconStop size={22} />}
            disabled={shutdownDisabled || !shutdown}
            title={shutdown ? `${shutdown.name}：${shutdown.steps.map((s) => s.label).join(' → ')}` : '无停车序列'}
            confirmTitle="一键停车"
            confirmDanger
            confirmMessage={`确认执行「${shutdown?.name ?? '一键停车'}」？系统将按逆序安全停止：${shutdown?.steps.map((s) => s.label).join(' → ')}。进行中的试验测量会中断。`}
            onClick={() => shutdown && run(shutdown.id)}
          >
            一键停车
          </CommandButton>
          {busy && !modalOpen && (
            <button type="button" className="btn" onClick={() => setModalOpen(true)}>
              查看执行进度
            </button>
          )}
        </div>
        {sysState && sysState.unready_aux.length > 0 && (
          <div className="hint">距就绪还差：{sysState.unready_aux.join('、')}</div>
        )}
      </div>

      {/* 执行进度弹窗：步骤实时状态由遥测推送驱动 */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        size="md"
        title={
          <>
            {exec?.name ?? '序列执行'}
            {execMeta && <span className={`badge ${execMeta.tone}`} style={{ marginLeft: 8 }}>{execMeta.label}</span>}
          </>
        }
        footer={
          exec?.state === 'running' ? (
            <button type="button" className="btn danger" onClick={() => setAbortConfirm(true)}>
              中止序列
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={() => setModalOpen(false)}>
              关闭
            </button>
          )
        }
      >
        {exec ? (
          <>
            <div className="badge-row">
              <span className="badge">操作员 {exec.operator}</span>
              <span className="badge mono">开始 {exec.started_at.replace('T', ' ')}</span>
              {exec.finished_at && <span className="badge mono">结束 {exec.finished_at.replace('T', ' ')}</span>}
            </div>
            <div className="seq-steps">
              {exec.steps.map((s, i) => {
                const meta = STEP_ICON[s.status] ?? STEP_ICON.pending
                return (
                  <div
                    key={i}
                    className={`seq-step ${({ running: 'active', ok: 'done', failed: 'failed', skipped: 'skipped' } as Record<string, string>)[s.status] ?? ''}`}
                  >
                    <span className={`seq-step-icon ${meta.cls}`}>{meta.text}</span>
                    <span className="seq-step-label">{s.label}</span>
                    <span className="seq-step-msg muted">{s.message}</span>
                  </div>
                )
              })}
            </div>
            {exec.error && <div className="badge danger" style={{ marginTop: 8 }}>{exec.error}</div>}
          </>
        ) : (
          <div className="empty">等待执行状态…</div>
        )}
      </Modal>

      <ConfirmModal
        open={abortConfirm}
        onClose={() => setAbortConfirm(false)}
        onConfirm={() => {
          setAbortConfirm(false)
          abort()
        }}
        title="中止序列"
        message="确认中止当前序列？已启动的子系统将保持当前状态，需要手动或再次执行停车序列恢复。"
        confirmLabel="中止"
        danger
      />
    </>
  )
}
