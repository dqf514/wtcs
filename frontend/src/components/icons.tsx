/** 工业风线框图标：各模块专属语义，避免通用 emoji */

import type { ReactElement, ReactNode } from 'react'

type IconProps = { size?: number; className?: string }

export type IconComponent = (p: IconProps) => ReactElement

function Svg({ size = 20, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** 总览墙：多屏矩阵 */
export function IconWall(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
    </Svg>
  )
}

/** 场景总控：仪表盘 + 指针 */
export function IconDashboard(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="M12 16l4-5" />
      <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
      <path d="M3 20h18" />
    </Svg>
  )
}

/** 子系统：分层模块 */
export function IconSubsystems(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="3" width="16" height="5" rx="1.2" />
      <rect x="4" y="10" width="16" height="5" rx="1.2" />
      <rect x="4" y="17" width="16" height="4" rx="1.2" />
      <path d="M8 5.5h.01M8 12.5h.01M8 19h.01" />
    </Svg>
  )
}

/** 实验调度：流程节点 */
export function IconExperiments(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <path d="M8.2 7.2l7 3.6M15.8 13.8l-7 3.2" />
      <path d="M20 6v2M21 7h-2" />
    </Svg>
  )
}

/** 数字孪生：立体线框 */
export function IconTwin(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </Svg>
  )
}

/** AI 助手：雷达扫描 */
export function IconAi(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" />
      <path d="M12 5a7 7 0 0 1 7 7" />
      <path d="M12 2a10 10 0 0 1 10 10" />
      <path d="M5.5 7.5A7 7 0 0 0 12 19" />
      <path d="M12 12l5-5" />
    </Svg>
  )
}

/** 报告：文档折角 */
export function IconReports(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Svg>
  )
}

/** 大屏：宽屏监视器 */
export function IconScreen(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="4" width="20" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
      <path d="M6 9h4M6 12h7" />
    </Svg>
  )
}

/** 连通性：网络节点 */
export function IconConnectivity(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M7.2 11.2l9-4.2M7.2 12.8l9 4.2" />
    </Svg>
  )
}

/** 审计：日志卷轴 */
export function IconAudit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8" />
      <path d="M8 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2" />
      <path d="M11 9h6M11 13h6M11 17h3" />
    </Svg>
  )
}

/** 设置：齿轮 */
export function IconSettings(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.9 6.5l1.6 1.6M17.5 15.9l1.6 1.6M3 12h2.2M18.8 12H21M4.9 17.5l1.6-1.6M17.5 8.1l1.6-1.6" />
    </Svg>
  )
}

/** 权限管理：盾牌钥匙 */
export function IconAdmin(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <circle cx="12" cy="11" r="2" />
      <path d="M12 13v3" />
    </Svg>
  )
}

/** 项目管理：文件夹 */
export function IconProject(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 10.5h18" />
    </Svg>
  )
}

/** 客户门户：建筑入口 */
export function IconPortal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 20h18" />
      <path d="M5 20V9l7-5 7 5v11" />
      <path d="M10 20v-5h4v5" />
      <path d="M9 12h.01M15 12h.01" />
    </Svg>
  )
}

/** 折叠 / 展开 */
export function IconCollapse(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 6l-6 6 6 6" />
    </Svg>
  )
}

export function IconExpand(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  )
}

/** 分组折叠箭头（向下=展开，旋转 -90°=收起） */
export function IconChevron(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

export function IconMenu(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  )
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

/** 子系统专用小图标 */
export function IconFan(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" />
      <path d="M12 4c2 2 2 4 0 6 2-2 4-2 6 0-2 2-4 2-6 0 2 2 2 4 0 6-2-2-4-2-6 0 2-2 2-4 0-6-2 2-4 2-6 0 2-2 4-2 6 0-2-2-2-4 0-6z" />
    </Svg>
  )
}

export function IconCooling(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v18M5 7l14 10M19 7L5 17" />
      <circle cx="12" cy="12" r="2" />
    </Svg>
  )
}

export function IconRrs(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="14" width="18" height="4" rx="1" />
      <circle cx="7" cy="16" r="2.5" />
      <circle cx="17" cy="16" r="2.5" />
      <path d="M8 10h8l1 4H7l1-4z" />
    </Svg>
  )
}

export function IconTraverse(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20V8h4v12M10 20V4h4v16M16 20v-6h4v6" />
    </Svg>
  )
}

export function IconSafety(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </Svg>
  )
}

/** 试验矩阵：网格表 */
export function IconMatrix(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M3 14.5h18M9.5 9v11M15.5 9v11" />
    </Svg>
  )
}

/* ---------- 通用操作图标（同一 24 视框线框风格） ---------- */

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 5l12 7-12 7V5z" />
    </Svg>
  )
}

export function IconPause(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 5v14M16 5v14" />
    </Svg>
  )
}

export function IconStop(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </Svg>
  )
}

/** 中止：八边形停止手势 */
export function IconAbort(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7L8.5 3z" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Svg>
  )
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12.5l5 5L20 6.5" />
    </Svg>
  )
}

export function IconCancel(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Svg>
  )
}

/** 导出：出盒向上 */
export function IconExport(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v11M8 7l4-4 4 4" />
      <path d="M5 13v6a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6" />
    </Svg>
  )
}

export function IconDownload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M5 19h14" />
    </Svg>
  )
}

export function IconPrint(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 8V3h10v5" />
      <rect x="4" y="8" width="16" height="8" rx="1.5" />
      <path d="M7 13h10v8H7v-8z" />
    </Svg>
  )
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v4h-4" />
    </Svg>
  )
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  )
}

/** 查看：眼睛 */
export function IconEye(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconFilter(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />
    </Svg>
  )
}

export function IconCalendar(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="16" rx="1.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Svg>
  )
}

/** 数据库 */
export function IconDatabase(p: IconProps) {
  return (
    <Svg {...p}>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
      <path d="M4 5.5v13c0 1.6 3.6 2.9 8 2.9s8-1.3 8-2.9v-13" />
      <path d="M4 12c0 1.6 3.6 2.9 8 2.9s8-1.3 8-2.9" />
    </Svg>
  )
}

/** 备份恢复：回转箭头 */
export function IconRestore(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 1 1 2.3 5.6" />
      <path d="M4 21v-4h4" />
    </Svg>
  )
}

/** 清理：扫帚 */
export function IconCleanup(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 3l7 7" />
      <path d="M12 5l7 7-5 5-7-7 5-5z" />
      <path d="M9 14l-5 5M5 15l4 4" />
    </Svg>
  )
}

/** 网络 */
export function IconNetwork(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M12 7.2v4.3M12 11.5L6 16.9M12 11.5l6 5.4" />
    </Svg>
  )
}

/** 图表统计 */
export function IconChart(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4v16h16" />
      <path d="M8 15v-4M12 15V8M16 15v-6" />
    </Svg>
  )
}

/** 告警铃 */
export function IconBell(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 16z" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </Svg>
  )
}

/** 健康心电 */
export function IconHealth(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </Svg>
  )
}

export function IconCamera(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="7" width="13" height="11" rx="1.5" />
      <path d="M16 11l5-3v9l-5-3" />
    </Svg>
  )
}

/** 图层 */
export function IconLayers(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Svg>
  )
}

export function IconFullscreen(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  )
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconEdit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20h4l11-11-4-4L4 16v4z" />
      <path d="M13 7l4 4" />
    </Svg>
  )
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconInfo(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.5h.01" />
    </Svg>
  )
}

/** 用户：头像轮廓 */
export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c0-3.9 3.4-6.3 7.5-6.3s7.5 2.4 7.5 6.3" />
    </Svg>
  )
}

/** 退出全屏：四角内收 */
export function IconFullscreenExit(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    </Svg>
  )
}

export function IconWarning(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5L22 20H2L12 3.5z" />
      <path d="M12 10v4.5M12 17.2h.01" />
    </Svg>
  )
}

/** 反馈入口：问号气泡 */
export function IconFeedback(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.7-.3-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" />
      <path d="M9.6 9.2a2.5 2.5 0 0 1 4.9.7c0 1.6-2.4 2-2.4 3.2" />
      <path d="M12 15.8h.01" />
    </Svg>
  )
}

export const NAV_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  wall: IconWall,
  dashboard: IconDashboard,
  subsystems: IconSubsystems,
  experiments: IconExperiments,
  matrices: IconMatrix,
  twin: IconTwin,
  ai: IconAi,
  reports: IconReports,
  screen: IconScreen,
  connectivity: IconConnectivity,
  audit: IconAudit,
  settings: IconSettings,
  admin: IconAdmin,
  portal: IconPortal,
  orders: IconReports,
  projects: IconProject,
  schedule: IconCalendar,
  data: IconDatabase,
  insight: IconHealth,
}

export const SUBSYSTEM_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  main_fan: IconFan,
  cooling_water: IconCooling,
  rrs: IconRrs,
  traverse: IconTraverse,
  boundary_layer: IconCooling,
  purge_air: IconFan,
  exhaust: IconFan,
  compressed_air: IconCooling,
  safety: IconSafety,
  acoustic: IconAi,
  pressure: IconDashboard,
  flow_field: IconTwin,
}
