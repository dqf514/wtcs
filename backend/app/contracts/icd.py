"""子系统接口契约（ICD）—— 真机对接只实现这些字段与命令，业务层不变。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models.schemas import SubsystemId


@dataclass(frozen=True)
class PointSpec:
    key: str
    label: str
    unit: str = ""
    dtype: str = "float"  # float | bool | int | str
    writable: bool = False
    min_v: float | None = None
    max_v: float | None = None
    critical: bool = False  # 运行核心数据，需实时上送


@dataclass(frozen=True)
class CommandSpec:
    name: str
    label: str
    params: tuple[str, ...] = ()
    require_confirm: bool = False
    min_role: str = "操作员"


@dataclass
class SubsystemContract:
    id: SubsystemId
    name: str
    description: str
    points: list[PointSpec] = field(default_factory=list)
    commands: list[CommandSpec] = field(default_factory=list)
    readiness_keys: list[str] = field(default_factory=list)


CONTRACTS: dict[SubsystemId, SubsystemContract] = {
    SubsystemId.main_fan: SubsystemContract(
        id=SubsystemId.main_fan,
        name="主风机系统",
        description="风速闭环与变频器控制；动态耦合优先主控，稳态可下放子系统。",
        points=[
            PointSpec("wind_speed", "风速", "m/s", critical=True),
            PointSpec("target_speed", "目标风速", "m/s", writable=True, min_v=0, max_v=250),
            PointSpec("frequency", "运行频率", "Hz", critical=True),
            PointSpec("power", "功率", "kW"),
            PointSpec("running", "运行中", "", "bool", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动", require_confirm=True),
            CommandSpec("stop", "停止", require_confirm=True),
            CommandSpec("set_speed", "设定风速", ("target_speed",), True),
            CommandSpec("reset_fault", "故障复位", min_role="维护员"),
        ],
        readiness_keys=["ready", "fault", "local_debug"],
    ),
    SubsystemId.cooling_water: SubsystemContract(
        id=SubsystemId.cooling_water,
        name="冷却水系统",
        description="冷源供应；向总控反馈运行状态与供水参数。",
        points=[
            PointSpec("supply_temp", "供水温度", "℃", critical=True),
            PointSpec("return_temp", "回水温度", "℃"),
            PointSpec("flow", "流量", "m³/h", critical=True),
            PointSpec("pressure", "供水压力", "bar"),
            PointSpec("chiller1_on", "冷机1", "", "bool"),
            PointSpec("chiller2_on", "冷机2", "", "bool"),
            PointSpec("chiller3_on", "冷机3", "", "bool"),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动", require_confirm=True),
            CommandSpec("stop", "停止", require_confirm=True),
            CommandSpec("set_temp", "设定供水温度", ("supply_temp",), True),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.rrs: SubsystemContract(
        id=SubsystemId.rrs,
        name="滚动路面/天平/转台",
        description="RRS+天平+转台；测量数据本地存储，实验后导入数据库。",
        points=[
            PointSpec("belt_speed", "路面速度", "m/s", critical=True, writable=True),
            PointSpec("yaw", "偏航角", "°", writable=True),
            PointSpec("fx", "Fx", "N"),
            PointSpec("fy", "Fy", "N"),
            PointSpec("fz", "Fz", "N"),
            PointSpec("mx", "Mx", "N·m"),
            PointSpec("my", "My", "N·m"),
            PointSpec("mz", "Mz", "N·m"),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
            PointSpec("acquiring", "采集中", "", "bool"),
        ],
        commands=[
            CommandSpec("start_belt", "启动路面", require_confirm=True),
            CommandSpec("stop_belt", "停止路面", require_confirm=True),
            CommandSpec("set_yaw", "设定偏航", ("yaw",), True),
            CommandSpec("set_belt_speed", "设定路面速度", ("belt_speed",), True),
            CommandSpec("start_acquire", "开始采集"),
            CommandSpec("stop_acquire", "停止采集"),
            CommandSpec("tare", "夹零 Tare", require_confirm=True),
        ],
        readiness_keys=["ready", "fault", "local_debug"],
    ),
    SubsystemId.traverse: SubsystemContract(
        id=SubsystemId.traverse,
        name="移测架系统",
        description="三维移测与安全连锁。",
        points=[
            PointSpec("x", "X", "mm", critical=True),
            PointSpec("y", "Y", "mm", critical=True),
            PointSpec("z", "Z", "mm", critical=True),
            PointSpec("moving", "运动中", "", "bool", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("move_to", "移动到点", ("x", "y", "z"), True),
            CommandSpec("home", "回零", require_confirm=True, min_role="维护员"),
            CommandSpec("stop", "停止运动", require_confirm=True),
        ],
        readiness_keys=["ready", "fault", "moving"],
    ),
    SubsystemId.boundary_layer: SubsystemContract(
        id=SubsystemId.boundary_layer,
        name="边界层抽吸系统",
        description="按风速与管道流量动态调节抽气，匹配流场。",
        points=[
            PointSpec("suction_flow", "抽气流量", "m³/s", critical=True),
            PointSpec("suction_ratio", "抽吸比", "%"),
            PointSpec("inverter_hz", "变频器频率", "Hz", writable=True),
            PointSpec("static_pressure", "静压", "Pa", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("running", "运行中", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动", require_confirm=True),
            CommandSpec("stop", "停止", require_confirm=True),
            CommandSpec("set_ratio", "设定抽吸比", ("suction_ratio",), True),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.purge_air: SubsystemContract(
        id=SubsystemId.purge_air,
        name="吹扫风系统",
        description="辅助系统；实验中由总控下发温湿度目标即可。",
        points=[
            PointSpec("temp", "送风温度", "℃", critical=True),
            PointSpec("humidity", "湿度", "%RH"),
            PointSpec("running", "运行中", "", "bool", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动"),
            CommandSpec("stop", "停止"),
            CommandSpec("set_climate", "设定温湿度", ("temp", "humidity"), True),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.exhaust: SubsystemContract(
        id=SubsystemId.exhaust,
        name="尾气抽排系统",
        description="WLTP 等工况；风阀状态与风机加减速关联。",
        points=[
            PointSpec("damper_open_count", "开启风阀数", "", "int", critical=True),
            PointSpec("damper_total", "风阀总数", "", "int"),
            PointSpec("running", "运行中", "", "bool", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动", require_confirm=True),
            CommandSpec("stop", "停止", require_confirm=True),
            CommandSpec("sync_with_fan", "跟随风机", ("fan_accel",)),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.compressed_air: SubsystemContract(
        id=SubsystemId.compressed_air,
        name="压缩空气系统",
        description="启停、压力监测、报警。",
        points=[
            PointSpec("pressure", "压力", "bar", critical=True),
            PointSpec("running", "运行中", "", "bool", critical=True),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start", "启动"),
            CommandSpec("stop", "停止"),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.safety: SubsystemContract(
        id=SubsystemId.safety,
        name="安全连锁",
        description="硬接线急停双接主控与子系统；按故障等级处置。",
        points=[
            PointSpec("e_stop", "急停", "", "bool", critical=True),
            PointSpec("interlock_ok", "连锁正常", "", "bool", critical=True),
            PointSpec("door_ok", "门禁正常", "", "bool", critical=True),
            PointSpec("fault_level", "故障等级", "", "int", critical=True),
            PointSpec("message", "状态说明", "", "str", critical=True),
        ],
        commands=[
            CommandSpec("e_stop", "急停", require_confirm=False),
            CommandSpec("reset_e_stop", "急停复位", require_confirm=True, min_role="维护员"),
            CommandSpec("ack_alarm", "确认报警"),
        ],
        readiness_keys=["e_stop", "interlock_ok"],
    ),
    SubsystemId.acoustic: SubsystemContract(
        id=SubsystemId.acoustic,
        name="声学测量",
        description="麦克风阵列等；原始数据本地存储后导入。",
        points=[
            PointSpec("spl", "声压级", "dB"),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("acquiring", "采集中", "", "bool"),
            PointSpec("fault", "故障", "", "bool", critical=True),
            PointSpec("local_debug", "本地调试", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start_acquire", "开始采集"),
            CommandSpec("stop_acquire", "停止采集"),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.pressure: SubsystemContract(
        id=SubsystemId.pressure,
        name="压力测量",
        description="Scanivalve / 表面压力等。",
        points=[
            PointSpec("channels_ok", "通道正常数", "", "int", critical=True),
            PointSpec("channels_total", "通道总数", "", "int"),
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("acquiring", "采集中", "", "bool"),
            PointSpec("fault", "故障", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start_acquire", "开始采集"),
            CommandSpec("stop_acquire", "停止采集"),
        ],
        readiness_keys=["ready", "fault"],
    ),
    SubsystemId.flow_field: SubsystemContract(
        id=SubsystemId.flow_field,
        name="流场测量",
        description="皮托、总压耙、PIV 等接口预留。",
        points=[
            PointSpec("ready", "就绪", "", "bool", critical=True),
            PointSpec("acquiring", "采集中", "", "bool"),
            PointSpec("fault", "故障", "", "bool", critical=True),
        ],
        commands=[
            CommandSpec("start_acquire", "开始采集"),
            CommandSpec("stop_acquire", "停止采集"),
        ],
        readiness_keys=["ready", "fault"],
    ),
}


def contract_as_dict(c: SubsystemContract) -> dict[str, Any]:
    return {
        "id": c.id.value,
        "name": c.name,
        "description": c.description,
        "points": [p.__dict__ for p in c.points],
        "commands": [
            {
                "name": cmd.name,
                "label": cmd.label,
                "params": list(cmd.params),
                "require_confirm": cmd.require_confirm,
                "min_role": cmd.min_role,
            }
            for cmd in c.commands
        ],
        "readiness_keys": c.readiness_keys,
    }
