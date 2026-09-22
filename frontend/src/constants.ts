/** 全局常量（独立模块，避免 App.tsx ↔ 页面之间的循环 import） */

/** 报警声音开关的 localStorage key（本浏览器生效） */
export const ALARM_SOUND_KEY = 'wtcs_alarm_sound'

export function alarmSoundEnabled() {
  return localStorage.getItem(ALARM_SOUND_KEY) === '1'
}

/** 实验场景（与后端 settings.default_scenario 可选值一致） */
export const SCENARIOS = ['气动实验', '声学实验', 'WLTP滑行', '参观演示'] as const
export type Scenario = (typeof SCENARIOS)[number]

/** 控件（按钮/链接等）视觉风格选项；当前值由 theme.tsx 存 data-ctl 属性，样式包在 index.css 末尾 */
export const CONTROL_STYLES = [
  { key: 'classic', label: '经典工业', hint: '克制描边，ISA-101 风格（默认）' },
  { key: 'raised', label: '立体浮雕', hint: '渐变高光 + 按压感，控制面板质感' },
  { key: 'solid', label: '扁平彩色', hint: '大圆角实心填充，Material 风格' },
  { key: 'outline', label: '高对比描边', hint: '直角粗描边，技术蓝图风格' },
] as const
export type ControlStyle = (typeof CONTROL_STYLES)[number]['key']
