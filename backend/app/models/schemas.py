from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


def local_now() -> datetime:
    """业务时间一律使用本地时间，禁止 utcnow。"""
    return datetime.now()


class Role(str, Enum):
    operator = "操作员"
    maintainer = "维护员"
    admin = "管理员"
    customer = "客户"


class ConnMode(str, Enum):
    simulation = "simulation"
    real = "real"


class ConnState(str, Enum):
    disconnected = "未连接"
    connecting = "连接中"
    connected = "已连接"
    degraded = "降级"
    fault = "故障"
    local_override = "本地接管"


class SafetyLevel(str, Enum):
    normal = "正常"
    warning = "预警"
    alarm = "报警"
    e_stop = "急停"
    safe_stop = "安全停机"


class ExperimentPhase(str, Enum):
    idle = "空闲"
    planning = "点位规划"
    setpoint = "工况设置"
    readiness = "就绪校验"
    moving = "点位移动"
    acquiring = "数据采集"
    finishing = "实验结束"
    aborted = "已中止"


class SubsystemId(str, Enum):
    main_fan = "main_fan"
    cooling_water = "cooling_water"
    rrs = "rrs"
    traverse = "traverse"
    boundary_layer = "boundary_layer"
    purge_air = "purge_air"
    exhaust = "exhaust"
    compressed_air = "compressed_air"
    safety = "safety"
    acoustic = "acoustic"
    pressure = "pressure"
    flow_field = "flow_field"


class TelemetryPoint(BaseModel):
    key: str
    label: str
    value: Any
    unit: str = ""
    quality: str = "good"  # good | bad | uncertain
    ts: datetime = Field(default_factory=local_now)


class SubsystemStatus(BaseModel):
    id: SubsystemId
    name: str
    mode: ConnMode
    state: ConnState
    local_debug: bool = False
    ready: bool = False
    running: bool = False
    fault: bool = False
    fault_message: str = ""
    points: list[TelemetryPoint] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=local_now)


class CommandRequest(BaseModel):
    subsystem_id: SubsystemId
    command: str
    params: dict[str, Any] = Field(default_factory=dict)
    confirm_token: str | None = None
    reason: str = ""


class CommandResult(BaseModel):
    ok: bool
    message: str
    accepted_at: datetime = Field(default_factory=local_now)
    audit_id: str | None = None


class ConnectivityCheckItem(BaseModel):
    name: str
    ok: bool
    detail: str
    latency_ms: float | None = None


class ConnectivityReport(BaseModel):
    subsystem_id: SubsystemId
    mode: ConnMode
    passed: bool
    checked_at: datetime = Field(default_factory=local_now)
    items: list[ConnectivityCheckItem]


class ExperimentScenario(str, Enum):
    aero = "气动实验"
    acoustic = "声学实验"
    wltp = "WLTP滑行"
    demo = "参观演示"


class ExperimentCreate(BaseModel):
    title: str
    scenario: ExperimentScenario
    wind_speed: float = 40.0
    temperature: float = 25.0
    yaw_angle: float = 0.0
    belt_speed: float | None = None
    traverse_x: float = 100.0
    traverse_y: float = 50.0
    traverse_z: float = 20.0
    duration_sec: float = Field(default=3.0, ge=0.5, le=3600)
    reference_area: float = Field(default=2.0, gt=0)
    notes: str = ""
    order_id: str | None = None  # 可选：关联订单


class Experiment(BaseModel):
    id: str
    title: str
    scenario: ExperimentScenario
    phase: ExperimentPhase
    wind_speed: float
    temperature: float
    yaw_angle: float
    belt_speed: float | None = None
    traverse_x: float = 100.0
    traverse_y: float = 50.0
    traverse_z: float = 20.0
    duration_sec: float = Field(default=3.0, ge=0.5, le=3600)
    reference_area: float = Field(default=2.0, gt=0)
    notes: str = ""
    order_id: str | None = None  # 可选：关联订单
    created_at: datetime = Field(default_factory=local_now)
    updated_at: datetime = Field(default_factory=local_now)
    created_by: str = "操作员"


# ---------- 试验矩阵 ----------

# 矩阵执行状态机: idle → running ⇄ paused → completed | aborted | failed
MATRIX_STATUSES = ("idle", "running", "paused", "completed", "aborted", "failed")


class MatrixCondition(BaseModel):
    """单行工况：过程参数全集，run 配置快照据此生成（保证可复现）。"""

    wind_speed: float = Field(default=40.0, ge=0, le=250)
    temperature: float = Field(default=25.0, ge=-40, le=85)
    yaw_angle: float = Field(default=0.0, ge=-180, le=180)
    belt_speed: float | None = Field(default=None, ge=0, le=250)
    traverse_x: float = 100.0
    traverse_y: float = 50.0
    traverse_z: float = 20.0
    duration_sec: float = Field(default=5.0, ge=0.5, le=3600)
    repeat: int = Field(default=1, ge=1, le=50)
    reference_area: float = Field(default=2.0, gt=0)


class MatrixCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    scenario: ExperimentScenario = ExperimentScenario.aero
    conditions: list[MatrixCondition] = Field(min_length=1)
    on_error: Literal["abort", "skip"] = "abort"


class MatrixUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    scenario: ExperimentScenario | None = None
    conditions: list[MatrixCondition] | None = Field(default=None, min_length=1)
    on_error: Literal["abort", "skip"] | None = None


class MatrixRunRequest(BaseModel):
    experiment_id: str | None = None


# ---------- 风速程控（阶梯剖面） ----------

class ProfileStep(BaseModel):
    """单步阶梯：目标风速 + 保持秒数。"""

    speed: float = Field(ge=0, le=250)
    hold_sec: float = Field(ge=1, le=36000)


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    steps: list[ProfileStep] = Field(min_length=1, max_length=64)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    steps: list[ProfileStep] | None = Field(default=None, min_length=1, max_length=64)


class AuditEntry(BaseModel):
    id: str
    ts: datetime = Field(default_factory=local_now)
    user: str
    role: str  # 角色名（内置为 Role 枚举值；支持自定义角色，故存字符串）
    action: str
    detail: str
    subsystem_id: str | None = None


class UserInfo(BaseModel):
    username: str
    display_name: str
    role: str  # 角色名以 users/roles 表为准（支持自定义角色）；内置角色值与 Role 枚举一致


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserInfo


# ---------- 用户管理 / 角色权限矩阵 ----------

class UserRow(BaseModel):
    username: str
    display_name: str
    role: str
    enabled: bool = True


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(min_length=1, max_length=64)
    role: str = Field(min_length=1, max_length=32)
    phone: str = Field(default="", max_length=64)
    email: str = Field(default="", max_length=128)
    company: str = Field(default="", max_length=128)
    department: str = Field(default="", max_length=64)
    position: str = Field(default="", max_length=64)
    notes: str = Field(default="", max_length=500)


class UserUpdate(BaseModel):
    role: str | None = Field(default=None, min_length=1, max_length=32)
    display_name: str | None = Field(default=None, min_length=1, max_length=64)
    enabled: bool | None = None
    password: str | None = Field(default=None, min_length=6, max_length=128)
    phone: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=128)
    company: str | None = Field(default=None, max_length=128)
    department: str | None = Field(default=None, max_length=64)
    position: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=500)


class RoleDef(BaseModel):
    name: str
    level: int
    pages: list[str] = Field(default_factory=list)
    builtin: bool = False


class RoleUpsert(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    level: int = Field(ge=0, le=3)
    pages: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    level: int | None = Field(default=None, ge=0, le=3)
    pages: list[str] | None = None


# ---------- 客户管理 ----------

class CustomerIn(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    contact: str = Field(default="", max_length=64)
    phone: str = Field(default="", max_length=64)
    email: str = Field(default="", max_length=128)
    address: str = Field(default="", max_length=256)
    notes: str = Field(default="", max_length=500)
    industry: str = Field(default="", max_length=64)
    contact_title: str = Field(default="", max_length=64)
    username: str | None = Field(default=None, max_length=64)


class CustomerUpdate(BaseModel):
    code: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=128)
    contact: str | None = Field(default=None, max_length=64)
    phone: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=128)
    address: str | None = Field(default=None, max_length=256)
    notes: str | None = Field(default=None, max_length=500)
    industry: str | None = Field(default=None, max_length=64)
    contact_title: str | None = Field(default=None, max_length=64)
    username: str | None = Field(default=None, max_length=64)


# ---------- 项目管理 ----------

class ProjectIn(BaseModel):
    project_no: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    customer_username: str = Field(min_length=1, max_length=64)
    customer_id: str | None = Field(default=None, max_length=64)
    status: str = Field(default="立项", max_length=32)
    note: str = Field(default="", max_length=500)


class ProjectUpdate(BaseModel):
    project_no: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=128)
    customer_username: str | None = Field(default=None, min_length=1, max_length=64)
    customer_id: str | None = Field(default=None, max_length=64)
    status: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=500)


# ---------- 订单管理 ----------

class OrderIn(BaseModel):
    order_no: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=128)
    customer_username: str = Field(min_length=1, max_length=64)
    customer_id: str | None = Field(default=None, max_length=64)
    status: str = Field(default="待启动", max_length=32)
    note: str = Field(default="", max_length=500)
    project_id: str | None = Field(default=None, max_length=64)


class OrderUpdate(BaseModel):
    order_no: str | None = Field(default=None, min_length=1, max_length=64)
    title: str | None = Field(default=None, min_length=1, max_length=128)
    customer_username: str | None = Field(default=None, min_length=1, max_length=64)
    customer_id: str | None = Field(default=None, max_length=64)
    status: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=500)
    project_id: str | None = Field(default=None, max_length=64)


class OrderOut(BaseModel):
    id: str
    order_no: str
    title: str
    customer_username: str
    status: str
    note: str = ""
    project_id: str | None = None
    created_at: str


# ---------- 排程计划 ----------

class ScheduleIn(BaseModel):
    title: str = Field(min_length=1, max_length=128)
    project_id: str | None = Field(default=None, max_length=64)
    order_id: str | None = Field(default=None, max_length=64)
    experiment_id: str | None = Field(default=None, max_length=64)
    resource: str = Field(default="风洞洞体", max_length=64)
    start_at: str = Field(min_length=1, max_length=32)
    end_at: str = Field(min_length=1, max_length=32)
    status: str = Field(default="计划中", max_length=32)
    note: str = Field(default="", max_length=500)


class ScheduleUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=128)
    project_id: str | None = Field(default=None, max_length=64)
    order_id: str | None = Field(default=None, max_length=64)
    experiment_id: str | None = Field(default=None, max_length=64)
    resource: str | None = Field(default=None, max_length=64)
    start_at: str | None = Field(default=None, min_length=1, max_length=32)
    end_at: str | None = Field(default=None, min_length=1, max_length=32)
    status: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=500)


class SystemOverview(BaseModel):
    app_name: str
    version: str
    safety: SafetyLevel
    wind_speed: float
    temperature: float
    experiment_phase: ExperimentPhase
    active_experiment_id: str | None
    simulation_count: int
    real_count: int
    connected_count: int
    fault_count: int
    # 风速程控执行状态（running 时为详情字典，空闲为 None）
    profile: dict[str, Any] | None = None
    server_time: datetime = Field(default_factory=local_now)
