/**
 * 命令参数与关键点位的展示元数据（后端 ICD 未携带中文参数名/量程，前端按 icd.py 手工维护）。
 * PARAM_META: 命令参数的中文 label、单位、校验范围；type=boolean 渲染为开关。
 * POINT_META: 关键模拟量点位的显示量程与正常区间（ISA-101 条形指示用）；无元数据的点位按纯数字显示。
 */

export interface ParamMeta {
  label: string
  unit?: string
  min?: number
  max?: number
  step?: number
  type?: 'number' | 'boolean'
  hint?: string
}

export const PARAM_META: Record<string, ParamMeta> = {
  target_speed: { label: '目标风速', unit: 'm/s', min: 0, max: 120, step: 1, hint: '与 ICD target_speed 写入点对应' },
  supply_temp: { label: '供水温度', unit: '℃', min: 5, max: 40, step: 0.5 },
  yaw: { label: '偏航角', unit: '°', min: -30, max: 30, step: 0.5 },
  belt_speed: { label: '路面速度', unit: 'm/s', min: 0, max: 120, step: 1 },
  x: { label: 'X 坐标', unit: 'mm', min: 0, max: 3000, step: 1 },
  y: { label: 'Y 坐标', unit: 'mm', min: -1500, max: 1500, step: 1 },
  z: { label: 'Z 坐标', unit: 'mm', min: 0, max: 2500, step: 1 },
  suction_ratio: { label: '抽吸比', unit: '%', min: 0, max: 100, step: 1 },
  temp: { label: '送风温度', unit: '℃', min: 10, max: 40, step: 0.5 },
  humidity: { label: '湿度', unit: '%RH', min: 20, max: 80, step: 1 },
  fan_accel: { label: '跟随风机加减速', type: 'boolean' },
}

export function paramMeta(key: string): ParamMeta {
  return PARAM_META[key] ?? { label: key, type: 'number' }
}

export interface PointMeta {
  /** 显示量程 */
  min: number
  max: number
  /** 正常区间（区间内中性色，越限变色） */
  normal: [number, number]
}

export const POINT_META: Record<string, PointMeta> = {
  wind_speed: { min: 0, max: 120, normal: [0, 85] },
  target_speed: { min: 0, max: 120, normal: [0, 85] },
  frequency: { min: 0, max: 60, normal: [0, 50] },
  power: { min: 0, max: 2000, normal: [0, 1500] },
  supply_temp: { min: 0, max: 50, normal: [5, 30] },
  return_temp: { min: 0, max: 60, normal: [10, 40] },
  flow: { min: 0, max: 300, normal: [30, 280] },
  pressure: { min: 0, max: 12, normal: [2, 8] },
  belt_speed: { min: 0, max: 120, normal: [0, 85] },
  yaw: { min: -30, max: 30, normal: [-20, 20] },
  fx: { min: -1000, max: 3000, normal: [0, 2500] },
  fy: { min: -1500, max: 1500, normal: [-1000, 1000] },
  fz: { min: -2000, max: 2000, normal: [-1500, 1000] },
  suction_flow: { min: 0, max: 20, normal: [0, 15] },
  suction_ratio: { min: 0, max: 100, normal: [0, 90] },
  inverter_hz: { min: 0, max: 60, normal: [0, 50] },
  static_pressure: { min: -500, max: 500, normal: [-300, 300] },
  temp: { min: 0, max: 50, normal: [15, 35] },
  humidity: { min: 0, max: 100, normal: [20, 80] },
  spl: { min: 40, max: 140, normal: [50, 110] },
  x: { min: 0, max: 3000, normal: [0, 3000] },
  y: { min: -1500, max: 1500, normal: [-1500, 1500] },
  z: { min: 0, max: 2500, normal: [0, 2500] },
}
