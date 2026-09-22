"""测点语义层：由 ICD 契约派生全量测点元数据 + 手工别名表。

用途：
- NL 查询（ask_nl）的测点解析：问题文本 → 测点条目；
- 开放数据接口 GET /api/open/points：外部系统发现测点用；
- 后期接 LLM 时，本表即 function-calling / RAG 的语义底座。

条目结构：{subsystem, subsystem_name, point, name, aliases, unit, dtype, writable, critical}
"""

from __future__ import annotations

from typing import Any

from app.contracts.icd import CONTRACTS

# 手工别名表：(subsystem_id, point_key) → 常用叫法（label 与 key 自动包含，无需重复）
EXTRA_ALIASES: dict[tuple[str, str], tuple[str, ...]] = {
    ("main_fan", "wind_speed"): ("风速", "主风机风速", "风洞风速", "wind"),
    ("main_fan", "target_speed"): ("目标风速", "设定风速"),
    ("main_fan", "frequency"): ("频率", "风机频率", "变频频率"),
    ("main_fan", "power"): ("功率", "风机功率", "功耗"),
    ("cooling_water", "supply_temp"): ("水温", "冷却水温", "冷却水温度", "供水温"),
    ("cooling_water", "return_temp"): ("回水温",),
    ("cooling_water", "flow"): ("水流量", "冷却水流量"),
    ("cooling_water", "pressure"): ("水压", "冷却水压力"),
    ("rrs", "belt_speed"): ("带速", "皮带速度", "路面速"),
    ("rrs", "yaw"): ("偏航", "偏航角度"),
    ("rrs", "fx"): ("阻力", "天平阻力", "x向力"),
    ("rrs", "fy"): ("侧向力", "y向力"),
    ("rrs", "fz"): ("升力", "z向力"),
    ("rrs", "mx"): ("滚转力矩",),
    ("rrs", "my"): ("俯仰力矩",),
    ("rrs", "mz"): ("偏航力矩",),
    ("traverse", "x"): ("移测架x", "x坐标", "x位置"),
    ("traverse", "y"): ("移测架y", "y坐标", "y位置"),
    ("traverse", "z"): ("移测架z", "z坐标", "z位置"),
    ("boundary_layer", "suction_flow"): ("抽吸流量", "抽气量"),
    ("boundary_layer", "inverter_hz"): ("抽吸频率", "抽吸变频频率"),
    ("purge_air", "temp"): ("吹扫温度", "送风温"),
    ("purge_air", "humidity"): ("送风湿度",),
    ("exhaust", "damper_open_count"): ("开启风阀数", "风阀开启数"),
    ("compressed_air", "pressure"): ("气源压力", "空压", "压缩空气压"),
    ("safety", "e_stop"): ("急停状态",),
    ("safety", "interlock_ok"): ("连锁状态",),
    ("safety", "door_ok"): ("门禁状态",),
    ("acoustic", "spl"): ("噪声", "噪音", "分贝"),
    ("pressure", "channels_ok"): ("压力通道正常数",),
}

# 子系统别名（状态类问题的归属解析用；契约中文名自动包含）
SUBSYSTEM_ALIASES: dict[str, tuple[str, ...]] = {
    "main_fan": ("主风机", "风机", "风扇"),
    "cooling_water": ("冷却水", "冷水", "水路"),
    "rrs": ("天平", "滚动路面", "转台", "路面"),
    "traverse": ("移测架", "移动架"),
    "boundary_layer": ("边界层", "抽吸"),
    "purge_air": ("吹扫风", "吹扫"),
    "exhaust": ("尾气", "抽排"),
    "compressed_air": ("压缩空气", "气源"),
    "safety": ("安全连锁", "安全"),
    "acoustic": ("声学", "麦克风"),
    "pressure": ("压力测量", "压力扫描"),
    "flow_field": ("流场",),
}


def _build_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for c in CONTRACTS.values():
        for p in c.points:
            aliases: list[str] = []
            for a in (p.label, p.key, *EXTRA_ALIASES.get((c.id.value, p.key), ())):
                if a and a not in aliases:
                    aliases.append(a)
            entries.append(
                {
                    "subsystem": c.id.value,
                    "subsystem_name": c.name,
                    "point": p.key,
                    "name": p.label,
                    "aliases": aliases,
                    "unit": p.unit,
                    "dtype": p.dtype,
                    "writable": p.writable,
                    "critical": p.critical,
                }
            )
    return entries


SEMANTIC_ENTRIES: list[dict[str, Any]] = _build_entries()


def all_point_meta() -> list[dict[str, Any]]:
    """全量测点语义元数据（开放接口用，返回副本）。"""
    return [dict(e) for e in SEMANTIC_ENTRIES]


def match_points(question: str) -> list[dict[str, Any]]:
    """按别名包含匹配测点，命中最长别名者优先。"""
    scored: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}
    for e in SEMANTIC_ENTRIES:
        best = 0
        for a in e["aliases"]:
            if a and a in question and len(a) > best:
                best = len(a)
        if best:
            key = (e["subsystem"], e["point"])
            if key not in scored or scored[key][0] < best:
                scored[key] = (best, e)
    return [e for _, e in sorted(scored.values(), key=lambda x: -x[0])]


def match_subsystems(question: str) -> list[str]:
    """按契约名 + 别名匹配子系统，返回 subsystem_id 列表。"""
    out: list[str] = []
    for c in CONTRACTS.values():
        sid = c.id.value
        names = (c.name, *SUBSYSTEM_ALIASES.get(sid, ()))
        if any(a and a in question for a in names):
            out.append(sid)
    return out
