/** run 采样通道组（试验中心 / 客户门户共用） */
export const GROUPS = [
  { id: 'balance', label: '天平六分量' },
  { id: 'pressure', label: '压力扫描' },
  { id: 'acoustic', label: '声学' },
  { id: 'env', label: '环境(风速/温度)' },
]

/** 曲线配色（按通道组 × 通道顺序取色） */
export const PALETTE = ['#2dd4bf', '#38bdf8', '#fbbf24', '#f87171', '#a78bfa', '#34d399', '#fb923c', '#e879f9']

/** 通道单位（tooltip/坐标轴用），未知通道留空 */
export const CHANNEL_UNIT: Record<string, string> = {
  fx: 'N', fy: 'N', fz: 'N', mx: 'N·m', my: 'N·m', mz: 'N·m',
  wind_speed: 'm/s', temperature: '℃', spl: 'dB',
}

/** run 状态中文映射 */
export const RUN_STATUS_CN: Record<string, string> = {
  running: '采集中',
  completed: '完成',
  aborted: '已中止',
  failed: '失败',
}
