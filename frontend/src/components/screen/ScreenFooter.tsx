import type { MatrixStatus } from '../../api'

interface Props {
  connected: boolean
  /** 实验阶段（overview.experiment_phase），空闲时不显示 */
  phase: string
  /** 运行中/暂停的矩阵执行状态；无则不显示 */
  matrix: MatrixStatus | null
  /** 最近一帧遥测的服务器时间 */
  dataTime: string
}

/** 大屏底部细条：链路状态 + 运行中实验/矩阵进度 + 数据刷新时间 */
export function ScreenFooter({ connected, phase, matrix, dataTime }: Props) {
  const phaseRunning = Boolean(phase) && phase !== '空闲'
  const pct =
    matrix && matrix.total_rows ? Math.min(100, Math.round(((matrix.done_rows ?? 0) / matrix.total_rows) * 100)) : null
  return (
    <footer className="screen-footer">
      <span className="screen-footer-item">
        <i className={`status-dot${connected ? '' : ' down'}`} />
        {connected ? '遥测链路 实时' : '遥测链路 中断重连中'}
      </span>
      {phaseRunning && <span className="screen-footer-item">实验阶段 {phase}</span>}
      {matrix && (
        <span className="screen-footer-item">
          矩阵 {matrix.matrix_name ?? matrix.matrix_id} {matrix.progress}
          {pct != null && (
            <span className="scr-progress">
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
        </span>
      )}
      <span className="screen-footer-right">数据时间 {dataTime}</span>
    </footer>
  )
}
