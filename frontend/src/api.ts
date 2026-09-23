export type Role = '操作员' | '维护员' | '管理员' | '客户'

export interface UserInfo {
  username: string
  display_name: string
  role: Role
  /** 角色页面集合（登录响应不带，App 登录后会用 /auth/me 补全，故为可选） */
  pages?: string[]
}

/** 用户管理行（admin） */
export interface UserRow {
  username: string
  display_name: string
  role: string
  enabled: boolean
  phone: string
  email: string
  company: string
  department: string
  position: string
  notes: string
}

/** 角色权限定义（admin） */
export interface RoleDef {
  name: string
  level: number
  pages: string[]
  builtin: boolean
}

/** 品牌标识 */
export type BrandingKind = 'logo' | 'mark'
export interface BrandingInfo {
  version: number
  logo_url: string
  mark_url: string
  custom: { logo: boolean; mark: boolean }
}

/** 用户反馈 */
export type FeedbackStatus = '未处理' | '处理中' | '已处理'
export interface Feedback {
  id: string
  username: string
  role: string
  content: string
  email: string
  page_url: string
  has_screenshot: 0 | 1
  status: FeedbackStatus
  created_at: string
}

/** 系统级运行状态机 */
export interface SystemStateInfo {
  state: 'standby' | 'preparing' | 'ready' | 'running' | 'stopping' | 'e_stop' | 'safety_fault'
  label: string
  tone: string
  /** 距就绪还差的辅机名称（待机/准备中时有值） */
  unready_aux: string[]
  since: string
}

/** 启停序列 */
export interface SequenceStepDef {
  label: string
  subsystem: string
  command: string
  params?: Record<string, unknown>
  wait?: { kind: string; point?: string; value?: number; timeout_s?: number }
}
export interface SequenceDef {
  id: string
  name: string
  kind: 'startup' | 'shutdown' | 'custom'
  steps: SequenceStepDef[]
  builtin: boolean
  version: number
  updated_by: string
  updated_at: string
}
export interface SequenceStepStatus {
  label: string
  subsystem: string
  command: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
  message: string
}
export interface SequenceExecution {
  id: string
  seq_id: string
  name: string
  kind: string
  state: 'running' | 'succeeded' | 'failed' | 'aborted'
  operator: string
  started_at: string
  finished_at: string
  error: string
  current_step: number
  steps: SequenceStepStatus[]
}

/** 联锁规则（alarm=报警 / block=指令许可拦截 / auto_stop=自动停车） */
export interface InterlockRule {
  id: string
  name: string
  kind: 'alarm' | 'block' | 'auto_stop'
  enabled: boolean
  /** 表达式：变量形如 main_fan.wind_speed；block 类为许可条件（成立才放行） */
  condition: string
  severity: 'info' | 'warning' | 'alarm' | 'critical'
  target_subsystem: string
  target_command: string
  message: string
  builtin: boolean
  trigger_count: number
  last_triggered: string
  version: number
  updated_by: string
  updated_at: string
}

/** 联锁真值表行（遥测帧 interlocks） */
export interface InterlockStatus {
  id: string
  name: string
  kind: 'alarm' | 'block' | 'auto_stop'
  enabled: boolean
  condition: string
  severity: string
  target_subsystem: string
  target_command: string
  message: string
  /** alarm/auto_stop：条件为真=违规；block：条件为许可（violated 表示许可不成立） */
  violated: boolean
  /** 当前是否安全/许可：alarm/auto_stop=未违规，block=许可成立 */
  pass: boolean
  error: string
  last_triggered: string
  trigger_count: number
}

/** 项目 */
export interface Project {
  id: string
  project_no: string
  name: string
  customer_username: string
  customer_id: string | null
  customer_name: string | null
  status: string
  note: string
  created_at: string
}

export type ProjectDetail = Project & { orders: (Order & { experiment_count: number })[] }

/** 订单 */
export interface Order {
  id: string
  order_no: string
  title: string
  customer_username: string
  customer_id: string | null
  customer_name: string | null
  status: string
  note: string
  project_id: string | null
  created_at: string
}

export type OrderDetail = Order & { experiments: Experiment[] }

/** 客户档案 */
export interface Customer {
  id: string
  code: string
  name: string
  contact: string
  phone: string
  email: string
  address: string
  notes: string
  industry: string
  contact_title: string
  username: string | null
  created_at: string
  project_count?: number
  order_count?: number
}

export type CustomerDetail = Customer & { projects: Project[]; orders: Order[] }

/** 排程计划 */
export interface Schedule {
  id: string
  title: string
  project_id: string | null
  order_id: string | null
  experiment_id: string | null
  resource: string
  start_at: string
  end_at: string
  status: string
  note: string
  created_by: string
  created_at: string
}

/** 排程展示大屏条目：privacy=1 只有前 6 个字段（服务端裁剪，无可溯源信息）；privacy=0 附完整字段 */
export interface ScheduleDisplayItem {
  queue_no: string
  date: string
  start_at: string
  end_at: string
  /** 公示状态：等待中 / 准备中 / 试验中 / 已完成 */
  status: string
  resource: string
  id?: string
  title?: string
  project_id?: string | null
  order_id?: string | null
  experiment_id?: string | null
  project_name?: string | null
  order_name?: string | null
  raw_status?: string
  created_by?: string
}

export interface ScheduleDisplay {
  privacy: number
  days: number
  generated_at: string
  items: ScheduleDisplayItem[]
}

export interface Overview {
  app_name: string
  version: string
  safety: string
  wind_speed: number
  temperature: number
  experiment_phase: string
  active_experiment_id: string | null
  simulation_count: number
  real_count: number
  connected_count: number
  fault_count: number
  /** 风速程控执行状态（running 时为详情，空闲为 null） */
  profile?: ProfileStatus | null
  server_time: string
}

// ---------- 风速程控（阶梯剖面） ----------

export interface ProfileStep {
  speed: number
  hold_sec: number
}

export type ProfileExecState = 'idle' | 'running' | 'completed' | 'aborted' | 'failed'

export interface SpeedProfile {
  id: string
  name: string
  steps: ProfileStep[]
  created_by: string
  created_at: string
  /** 列表接口附带的执行状态（无执行记录为 idle） */
  exec_status?: ProfileExecState
}

export interface ProfileStatus {
  id: string
  name: string
  step_index: number
  total_steps: number
  step_remaining_sec: number
  state: 'running' | 'idle'
  status: ProfileExecState
  steps: ProfileStep[]
  started_by: string
  started_at: string
  finished_at: string | null
}

// ---------- 设备台账（一机一档） ----------

export interface EquipmentItem {
  subsystem_id: string
  name: string
  state: string
  mode: string
  ready: boolean
  running: boolean
  fault: boolean
  fault_message: string
  today_minutes: number
  total_minutes: number
  unacked_alerts: number
  last_maintenance_at: string | null
}

export interface MaintenanceLog {
  id: string
  subsystem_id: string
  type: string
  content: string
  operator: string
  created_at: string
}

export interface TelemetryPoint {
  key: string
  label: string
  value: unknown
  unit: string
  quality: string
}

export interface CommandSpec {
  name: string
  label: string
  params: string[]
  require_confirm: boolean
  min_role: string
}

export interface SubsystemStatus {
  id: string
  name: string
  mode: 'simulation' | 'real'
  state: string
  local_debug: boolean
  ready: boolean
  running: boolean
  fault: boolean
  fault_message: string
  points: TelemetryPoint[]
  endpoint?: string
  protocol?: string
  contract?: {
    description: string
    commands: CommandSpec[]
    points: { key: string; label: string; unit: string; writable: boolean; dtype?: string }[]
  }
}

export interface ConnectivityReport {
  subsystem_id: string
  mode: string
  passed: boolean
  checked_at: string
  items: { name: string; ok: boolean; detail: string; latency_ms?: number }[]
}

export interface Experiment {
  id: string
  title: string
  scenario: string
  phase: string
  wind_speed: number
  temperature: number
  yaw_angle: number
  belt_speed: number | null
  traverse_x: number
  traverse_y: number
  traverse_z: number
  duration_sec: number
  reference_area: number
  notes: string
  created_at: string
  /** 可选：关联订单 */
  order_id?: string | null
}

export type AlertSeverity = 'info' | 'warning' | 'alarm' | 'critical'

export interface AiAlert {
  id: string
  level: string
  severity: AlertSeverity
  subsystem_id: string
  subsystem_name: string
  message: string
  ts: string
  active: boolean
  acked: boolean
  acked_by?: string | null
  acked_at?: string | null
  count: number
}

export interface AlertSummary {
  info: number
  warning: number
  alarm: number
  critical: number
  total: number
}

export interface AskSource {
  point: string
  point_name: string
  subsystem: string
  subsystem_name: string
  time_range: string
  sample_count: number
}

// ---------- 试验矩阵 ----------

export interface MatrixCondition {
  wind_speed: number
  temperature: number
  yaw_angle: number
  belt_speed: number | null
  traverse_x: number
  traverse_y: number
  traverse_z: number
  duration_sec: number
  repeat: number
  reference_area: number
}

export interface TestMatrix {
  id: string
  name: string
  scenario: string
  conditions: MatrixCondition[]
  on_error: 'abort' | 'skip'
  version: number
  history: unknown[]
  created_by: string
  created_at: string
  updated_at: string
  /** 列表接口附带的执行状态（idle/running/paused/completed/aborted/failed），无执行记录为 idle */
  exec_status?: MatrixRunState
}

export type MatrixRunState = 'idle' | 'running' | 'paused' | 'completed' | 'aborted' | 'failed'

export interface MatrixRowStatus {
  index: number
  repeat_no: number
  status: string
  run_id: string | null
  error: string
}

export interface MatrixStatus {
  matrix_id: string
  matrix_name?: string
  experiment_id?: string | null
  status: MatrixRunState
  progress: string
  done_rows?: number
  total_rows?: number
  current?: { row_index: number; repeat_no: number; condition: MatrixCondition } | null
  eta_seconds?: number | null
  rows: MatrixRowStatus[]
  started_by?: string
  started_at?: string
  finished_at?: string | null
}

// ---------- 实验数据 run ----------

export interface ExperimentRun {
  id: string
  experiment_id: string | null
  matrix_id: string | null
  row_index: number
  config: Record<string, unknown>
  config_hash: string
  status: string
  operator: string
  started_at: string | null
  ended_at: string | null
  created_at: string
}

export interface RunSample {
  t: number
  channels: Record<string, Record<string, number | null>>
}

export interface ChannelStat {
  mean: number
  max: number
  min: number
  std: number
  count: number
}

export interface RunSummary {
  run_id: string
  status: string
  sample_count: number
  config_hash: string
  stats: Record<string, Record<string, ChannelStat>>
  coefficients: {
    Cd?: number
    Cl?: number
    dynamic_pressure_Pa?: number
    reference_area_m2?: number
    wind_speed_used?: number
    air_density?: number
    formula?: string
  }
}

// ---------- 健康基线 ----------

export type HealthStatus = 'learning' | 'normal' | 'attention' | 'abnormal'

export interface HealthPoint {
  subsystem: string
  subsystem_name: string
  point: string
  name: string
  unit: string
  current: number | null
  baseline_mean: number | null
  baseline_std: number | null
  z_score: number | null
  sample_count: number
  status: HealthStatus
  score: number | null
  violation_cycles: number
}

export interface HealthSubsystem {
  id: string
  name: string
  score: number | null
  status: HealthStatus
  status_cn: string
  monitored_points: number
}

export interface TwinHealthReport {
  ts: string
  learning_enabled: boolean
  min_samples: number
  points: HealthPoint[]
  subsystems: HealthSubsystem[]
}

// ---------- 系统 ----------

export interface SystemInfo {
  app_name: string
  version: string
  app_version: string
  started_at: string | null
  uptime_seconds: number
  python_version: string
  simulation_count: number
  real_count: number
  force_simulation: boolean
}

export interface StorageStats {
  db_path: string
  db_file_bytes: number
  wal_file_bytes: number
  estimated_bytes: number
  tables: Record<string, number>
}

export interface BackupInfo {
  name: string
  size_bytes: number
  created_at: string
}

export interface NetworkInfo {
  host: string
  port: number
  api_base: string
  ws_telemetry: string
  cors_origins: string[]
  docs: string
}

export interface OpenPointMeta {
  subsystem: string
  subsystem_name: string
  point: string
  name: string
  unit?: string
  dtype?: string
  /** true = 该测点有宽表历史（telemetry_wide），可在数据查询中选择 */
  logged?: boolean
  [key: string]: unknown
}

// ---------- 历史数据查询 / 统计汇总（数据中心） ----------

export interface HistorySeries {
  key: string
  name: string
  unit: string
  points: [string, number][]
}

/** 轻量遥测历史（子系统页趋势区）：GET /api/telemetry/history */
export interface TelemetryHistoryPoint {
  t: string
  v: number
}

export interface TelemetryHistoryResult {
  minutes: number
  /** 请求键 → 宽表键（如 fx → rrs.fx） */
  keys: Record<string, string>
  series: Record<string, TelemetryHistoryPoint[]>
}

export interface HistoryQueryResult {
  from: string
  to: string
  /** 实际生效的聚合桶（点数超上限时后端会自动加大） */
  bucket_sec: number
  agg: 'avg' | 'min' | 'max'
  raw_rows: number
  points: HistorySeries[]
}

export interface StatsOverview {
  days: number
  from: string
  to: string
  experiments: {
    total: number
    by_scenario: { name: string; count: number }[]
    by_phase: { name: string; count: number }[]
  }
  runs: { total: number; completed: number; avg_duration_sec: number | null }
  matrices: {
    executions: number
    rows_total: number
    rows_completed: number
    success_rate: number | null
  }
  alerts: {
    total: number
    by_severity: Record<string, number>
    by_subsystem: { name: string; count: number }[]
    by_day: { day: string; count: number }[]
  }
  audit: { total: number; top_actions: { action: string; count: number }[] }
}

const TOKEN_KEY = 'wtcs_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// ---------- 角色权限（与后端 Role 等级一致：customer < operator < maintainer < admin） ----------

export const ROLE_LEVEL: Record<Role, number> = {
  客户: 0,
  操作员: 1,
  维护员: 2,
  管理员: 3,
}

let currentUser: UserInfo | null = null

export function setCurrentUser(user: UserInfo | null) {
  currentUser = user
}

export function getCurrentUser() {
  return currentUser
}

/** 当前登录角色是否达到要求的最低角色；未登录一律视为无权限 */
export function hasMinRole(min: Role): boolean {
  if (!currentUser) return false
  return ROLE_LEVEL[currentUser.role] >= ROLE_LEVEL[min]
}

/** 后端契约命令的 min_role 是中文字符串，做容错判定 */
export function roleAllowed(minRole: string | undefined): boolean {
  if (!minRole) return true
  if (minRole in ROLE_LEVEL) return hasMinRole(minRole as Role)
  return true
}

/** 当前用户是否拥有某页面权限（pages 由角色矩阵下发）；未登录一律无权限 */
export function hasPage(page: string): boolean {
  if (!currentUser) return false
  return (currentUser.pages ?? []).includes(page)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function parseError(text: string, fallback: string): string {
  if (!text) return fallback
  try {
    const data = JSON.parse(text)
    if (typeof data?.detail === 'string') return data.detail
    if (Array.isArray(data?.detail)) {
      return data.detail.map((d: { msg?: string }) => d?.msg ?? '').filter(Boolean).join('；') || fallback
    }
  } catch {
    /* 非 JSON，原样返回 */
  }
  return text
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    setToken(null)
    setCurrentUser(null)
    window.dispatchEvent(new Event('wtcs:unauthorized'))
    throw new ApiError('登录已过期，请重新登录', 401)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(parseError(text, res.statusText), res.status)
  }
  return res.json() as Promise<T>
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; user: UserInfo }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<UserInfo>('/api/auth/me'),
  changePassword: (old_password: string, new_password: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ old_password, new_password }),
    }),
  overview: () => request<Overview>('/api/overview'),
  subsystems: () => request<SubsystemStatus[]>('/api/subsystems'),
  subsystem: (id: string) => request<SubsystemStatus>(`/api/subsystems/${id}`),
  command: (body: {
    subsystem_id: string
    command: string
    params?: Record<string, unknown>
    confirm_token?: string
  }) =>
    request<{ ok: boolean; message: string }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  connectivityOne: (id: string) =>
    request<ConnectivityReport>(`/api/subsystems/${id}/connectivity-test`, { method: 'POST' }),
  connectivityAll: () =>
    request<{ passed: number; total: number; all_ok: boolean; reports: ConnectivityReport[] }>(
      '/api/connectivity-test/all',
      { method: 'POST' },
    ),
  switchMode: (id: string, mode: 'simulation' | 'real') =>
    request(`/api/subsystems/${id}/mode?mode=${mode}`, { method: 'POST' }),
  experiments: () => request<Experiment[]>('/api/experiments'),
  createExperiment: (body: Record<string, unknown>) =>
    request<Experiment>('/api/experiments', { method: 'POST', body: JSON.stringify(body) }),
  runExperiment: (id: string) => request<Experiment>(`/api/experiments/${id}/run`, { method: 'POST' }),
  setExperimentPhase: (id: string, phase: string) =>
    request<Experiment>(`/api/experiments/${id}/phase?phase=${encodeURIComponent(phase)}`, { method: 'POST' }),

  // ---------- 实验数据 run ----------
  experimentRuns: (expId: string) => request<ExperimentRun[]>(`/api/experiments/${expId}/runs`),
  run: (runId: string) => request<ExperimentRun>(`/api/runs/${runId}`),
  runSamples: (runId: string, channels?: string[], downsample = 1) => {
    const qs = new URLSearchParams()
    if (channels?.length) qs.set('channels', channels.join(','))
    if (downsample > 1) qs.set('downsample', String(downsample))
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<{ run_id: string; count: number; samples: RunSample[] }>(`/api/runs/${runId}/samples${suffix}`)
  },
  runSummary: (runId: string) => request<RunSummary>(`/api/runs/${runId}/summary`),

  // ---------- 试验矩阵 ----------
  matrices: () => request<TestMatrix[]>('/api/matrices'),
  createMatrix: (body: { name: string; scenario: string; conditions: MatrixCondition[]; on_error: 'abort' | 'skip' }) =>
    request<TestMatrix>('/api/matrices', { method: 'POST', body: JSON.stringify(body) }),
  matrix: (id: string) => request<TestMatrix>(`/api/matrices/${id}`),
  updateMatrix: (id: string, body: Partial<{ name: string; scenario: string; conditions: MatrixCondition[]; on_error: 'abort' | 'skip' }>) =>
    request<TestMatrix>(`/api/matrices/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteMatrix: (id: string) => request<{ ok: boolean }>(`/api/matrices/${id}`, { method: 'DELETE' }),
  runMatrix: (id: string, experiment_id?: string | null) =>
    request<MatrixStatus>(`/api/matrices/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(experiment_id ? { experiment_id } : {}),
    }),
  matrixControl: (id: string, action: 'pause' | 'resume' | 'abort') =>
    request<MatrixStatus>(`/api/matrices/${id}/${action}`, { method: 'POST' }),
  matrixStatus: (id: string) => request<MatrixStatus>(`/api/matrices/${id}/status`),

  // ---------- 风速程控（阶梯剖面） ----------
  profiles: () => request<SpeedProfile[]>('/api/profiles'),
  createProfile: (body: { name: string; steps: ProfileStep[] }) =>
    request<SpeedProfile>('/api/profiles', { method: 'POST', body: JSON.stringify(body) }),
  updateProfile: (id: string, body: Partial<{ name: string; steps: ProfileStep[] }>) =>
    request<SpeedProfile>(`/api/profiles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProfile: (id: string) => request<{ ok: boolean }>(`/api/profiles/${id}`, { method: 'DELETE' }),
  startProfile: (id: string) => request<ProfileStatus>(`/api/profiles/${id}/start`, { method: 'POST' }),
  stopProfile: () => request<ProfileStatus>('/api/profiles/stop', { method: 'POST' }),

  // ---------- 设备台账（一机一档） ----------
  equipment: () => request<EquipmentItem[]>('/api/equipment'),
  maintenanceLogs: (subId: string, limit = 100) =>
    request<MaintenanceLog[]>(`/api/equipment/${subId}/maintenance?limit=${limit}`),
  addMaintenance: (subId: string, body: { type: string; content: string }) =>
    request<MaintenanceLog>(`/api/equipment/${subId}/maintenance`, { method: 'POST', body: JSON.stringify(body) }),

  audit: (limit = 100) =>
    request<{ id: string; ts: string; user: string; role?: string; action: string; detail: string; subsystem_id?: string | null }[]>(`/api/audit?limit=${limit}`),
  history: (limit = 180) =>
    request<{ ts: string; wind_speed: number; temperature: number; safety: string }[]>(
      `/api/history?limit=${limit}`,
    ),
  /** 按点位查最近 N 分钟遥测历史（子系统页趋势区，宽表键 sub.point 或裸键均可） */
  telemetryHistory: (keys: string[], minutes = 30, limit = 500) => {
    const qs = new URLSearchParams()
    qs.set('keys', keys.join(','))
    qs.set('minutes', String(minutes))
    qs.set('limit', String(limit))
    return request<TelemetryHistoryResult>(`/api/telemetry/history?${qs}`)
  },
  // ---------- 数据中心：历史查询 / 统计汇总 ----------
  historyQuery: (params: {
    points: string[]
    from?: string
    to?: string
    bucket_sec?: number
    agg?: 'avg' | 'min' | 'max'
  }) => {
    const qs = new URLSearchParams()
    qs.set('points', params.points.join(','))
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    if (params.bucket_sec) qs.set('bucket_sec', String(params.bucket_sec))
    if (params.agg) qs.set('agg', params.agg)
    return request<HistoryQueryResult>(`/api/history/query?${qs}`)
  },
  statsOverview: (days = 7) => request<StatsOverview>(`/api/stats/overview?days=${days}`),
  reports: () =>
    request<{ id: string; title: string; created_at: string; experiment_id?: string; created_by: string }[]>(
      '/api/reports',
    ),
  report: (id: string) => request<{ id: string; title: string; html: string; created_at: string }>(`/api/reports/${id}`),
  createReport: (body: { title: string; experiment_id?: string | null }) =>
    request<{ id: string; title: string; created_at: string }>('/api/reports', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ---------- AI ----------
  aiAlerts: (filters: { severity?: AlertSeverity; active?: boolean; acked?: boolean; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (filters.severity) qs.set('severity', filters.severity)
    if (filters.active !== undefined) qs.set('active', String(filters.active))
    if (filters.acked !== undefined) qs.set('acked', String(filters.acked))
    if (filters.limit) qs.set('limit', String(filters.limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<AiAlert[]>(`/api/ai/alerts${suffix}`)
  },
  aiAlertSummary: () => request<AlertSummary>('/api/ai/alerts/summary'),
  aiInspect: () => request<{ count: number; alerts: AiAlert[] }>('/api/ai/inspect', { method: 'POST' }),
  aiAck: (id: string) => request(`/api/ai/alerts/${id}/ack`, { method: 'POST' }),
  aiAckAll: () => request<{ ok: boolean; count: number }>('/api/ai/alerts/ack_all', { method: 'POST' }),
  aiAsk: (question: string) =>
    request<{ question: string; answer: string; ts: string; sources?: AskSource[] }>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),

  // ---------- 数字孪生 / 健康基线 ----------
  twin: () => request<Record<string, unknown>>('/api/twin'),
  twinHealth: () => request<TwinHealthReport>('/api/twin/health'),
  twinHealthReset: (subsystem: string) =>
    request<{ ok: boolean; subsystem: string; removed: number }>(`/api/twin/health/${subsystem}/reset`, {
      method: 'POST',
    }),

  // ---------- 开放数据接口（只读） ----------
  openPoints: () => request<{ ts: string; count: number; points: OpenPointMeta[] }>('/api/open/points'),
  openLatest: () =>
    request<{ ts: string; count: number; points: { subsystem: string; subsystem_name: string; point: string; name: string; value: unknown; unit: string; quality: string }[] }>(
      '/api/open/latest',
    ),

  settings: () => request<Record<string, unknown>>('/api/settings'),
  saveSettings: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),

  // ---------- 系统：信息 / 存储 / 网络 ----------
  systemInfo: () => request<SystemInfo>('/api/system/info'),
  systemStorage: () => request<StorageStats>('/api/system/storage'),
  systemCleanup: () => request<{ ok: boolean; removed: Record<string, number> }>('/api/system/cleanup', { method: 'POST' }),
  systemNetwork: () => request<NetworkInfo>('/api/system/network'),

  // ---------- 系统：备份 / 恢复 ----------
  createBackup: () => request<BackupInfo>('/api/system/backup', { method: 'POST' }),
  listBackups: () => request<BackupInfo[]>('/api/system/backups'),
  restoreBackup: (name: string) =>
    request<{ ok: boolean; restored: string; safety_backup: string }>(
      `/api/system/backups/${encodeURIComponent(name)}/restore`,
      { method: 'POST' },
    ),
  deleteBackup: (name: string) =>
    request<{ ok: boolean }>(`/api/system/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // ---------- 用户管理（admin） ----------
  listUsers: () => request<UserRow[]>('/api/admin/users'),
  createUser: (body: {
    username: string
    password: string
    display_name: string
    role: string
    phone?: string
    email?: string
    company?: string
    department?: string
    position?: string
    notes?: string
  }) => request<UserRow>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (username: string, patch: Partial<{
    role: string
    display_name: string
    enabled: boolean
    password: string
    phone: string
    email: string
    company: string
    department: string
    position: string
    notes: string
  }>) => request<UserRow>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteUser: (username: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),

  // ---------- 角色权限矩阵（admin） ----------
  listRoles: () => request<RoleDef[]>('/api/admin/roles'),
  createRole: (body: { name: string; level: number; pages: string[] }) =>
    request<RoleDef>('/api/admin/roles', { method: 'POST', body: JSON.stringify(body) }),
  updateRole: (name: string, patch: Partial<{ level: number; pages: string[] }>) =>
    request<RoleDef>(`/api/admin/roles/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteRole: (name: string) =>
    request<{ ok: boolean }>(`/api/admin/roles/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // ---------- 项目管理（客户自动只返回本人） ----------
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (body: { project_no: string; name: string; customer_username: string; customer_id?: string | null; status?: string; note?: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: string, patch: Partial<{ project_no: string; name: string; customer_username: string; customer_id: string | null; status: string; note: string }>) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  projectDetail: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),

  // ---------- 订单管理（客户自动只返回本人） ----------
  listOrders: () => request<Order[]>('/api/orders'),
  createOrder: (body: { order_no: string; title: string; customer_username: string; customer_id?: string | null; status?: string; note?: string; project_id?: string | null }) =>
    request<Order>('/api/orders', { method: 'POST', body: JSON.stringify(body) }),
  updateOrder: (id: string, patch: Partial<{ order_no: string; title: string; customer_username: string; customer_id: string | null; status: string; note: string; project_id: string | null }>) =>
    request<Order>(`/api/orders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteOrder: (id: string) =>
    request<{ ok: boolean }>(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  orderDetail: (id: string) => request<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`),

  // ---------- 客户管理（客户角色自动只返回本人档案） ----------
  listCustomers: () => request<Customer[]>('/api/customers'),
  createCustomer: (body: { code: string; name: string; contact?: string; phone?: string; email?: string; address?: string; notes?: string; industry?: string; contact_title?: string; username?: string | null }) =>
    request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(body) }),
  updateCustomer: (id: string, patch: Partial<{ code: string; name: string; contact: string; phone: string; email: string; address: string; notes: string; industry: string; contact_title: string; username: string | null }>) =>
    request<Customer>(`/api/customers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCustomer: (id: string) =>
    request<{ ok: boolean }>(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  customerDetail: (id: string) => request<CustomerDetail>(`/api/customers/${encodeURIComponent(id)}`),

  // ---------- 品牌标识（读取公开；上传/恢复默认仅管理员） ----------
  branding: () => request<BrandingInfo>('/api/branding'),
  uploadBranding: async (kind: BrandingKind, file: File): Promise<BrandingInfo> => {
    const fd = new FormData()
    fd.append('file', file)
    const headers = new Headers()
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(`/api/branding/${kind}`, { method: 'POST', headers, body: fd })
    if (!res.ok) {
      const text = await res.text()
      throw new ApiError(parseError(text, res.statusText), res.status)
    }
    return res.json() as Promise<BrandingInfo>
  },
  resetBranding: (kind: BrandingKind) =>
    request<BrandingInfo>(`/api/branding/${kind}`, { method: 'DELETE' }),

  // ---------- 用户反馈（提交需登录、服务端 5 分钟限流；查看/处理仅管理员） ----------
  submitFeedback: async (input: { content: string; email?: string; page_url?: string; screenshot?: File | null }): Promise<{ ok: boolean; id: string }> => {
    const fd = new FormData()
    fd.append('content', input.content)
    fd.append('email', input.email ?? '')
    fd.append('page_url', input.page_url ?? '')
    if (input.screenshot) fd.append('screenshot', input.screenshot)
    const headers = new Headers()
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch('/api/feedback', { method: 'POST', headers, body: fd })
    if (!res.ok) {
      const text = await res.text()
      throw new ApiError(parseError(text, res.statusText), res.status)
    }
    return res.json() as Promise<{ ok: boolean; id: string }>
  },
  listFeedbacks: (status?: FeedbackStatus) =>
    request<Feedback[]>(`/api/feedback${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  updateFeedback: (id: string, status: FeedbackStatus) =>
    request<{ ok: boolean }>(`/api/feedback/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status }) }),
  deleteFeedback: (id: string) =>
    request<{ ok: boolean }>(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 反馈截图 URL（需 Authorization，用 <img> 直链不行，得 fetch 成 blob；这里仅拼路径） */
  feedbackScreenshotUrl: (id: string) => `/api/feedback/${encodeURIComponent(id)}/screenshot`,

  // ---------- 排程计划（客户自动过滤为关联本人的条目） ----------
  listSchedules: (params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<Schedule[]>(`/api/schedules${suffix}`)
  },
  createSchedule: (body: {
    title: string
    project_id?: string | null
    order_id?: string | null
    experiment_id?: string | null
    resource?: string
    start_at: string
    end_at: string
    status?: string
    note?: string
  }) => request<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: string, patch: Partial<{
    title: string
    project_id: string | null
    order_id: string | null
    experiment_id: string | null
    resource: string
    start_at: string
    end_at: string
    status: string
    note: string
  }>) => request<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) =>
    request<{ ok: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 排程展示大屏：privacy=1 服务端即去标识化（排队号/时间窗/状态/资源），privacy=0 附完整字段 */
  schedulesDisplay: (params: { days?: number; privacy?: 0 | 1 } = {}) =>
    request<ScheduleDisplay>(`/api/schedules/display?days=${params.days ?? 2}&privacy=${params.privacy ?? 1}`),

  // ---------- 系统状态机与启停序列 ----------
  systemState: () => request<SystemStateInfo>('/api/system/state'),
  listSequences: () => request<SequenceDef[]>('/api/sequences'),
  executeSequence: (id: string) =>
    request<SequenceExecution>(`/api/sequences/${encodeURIComponent(id)}/execute`, { method: 'POST' }),
  sequenceExecution: () => request<SequenceExecution>('/api/sequence-execution'),
  abortSequence: () => request<{ ok: boolean }>('/api/sequence-execution/abort', { method: 'POST' }),
  updateSequence: (id: string, patch: { name?: string; steps?: SequenceStepDef[] }) =>
    request<SequenceDef>(`/api/sequences/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),

  // ---------- 联锁矩阵 ----------
  listInterlocks: () => request<InterlockRule[]>('/api/interlocks'),
  interlockStatus: () => request<InterlockStatus[]>('/api/interlocks/status'),
  createInterlock: (rule: Partial<InterlockRule>) =>
    request<InterlockRule>('/api/interlocks', { method: 'POST', body: JSON.stringify(rule) }),
  updateInterlock: (id: string, patch: Partial<InterlockRule>) =>
    request<InterlockRule>(`/api/interlocks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteInterlock: (id: string) =>
    request<{ ok: boolean }>(`/api/interlocks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** 备份下载需要带 Bearer，不能用裸 <a href>：fetch 成 blob 再触发下载 */
export async function downloadBackupFile(name: string) {
  const token = getToken()
  const res = await fetch(`/api/system/backups/${encodeURIComponent(name)}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (res.status === 401) {
    setToken(null)
    setCurrentUser(null)
    window.dispatchEvent(new Event('wtcs:unauthorized'))
    throw new ApiError('登录已过期，请重新登录', 401)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(parseError(text, res.statusText), res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
