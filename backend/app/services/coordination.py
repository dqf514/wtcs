"""跨子系统参数联动（设定值协调）。

- PARAM_LIMITS：可设定参数的硬限值（与前端 paramMeta.ts 同源，服务端为准）
- preview_linkage：给定目标风速，计算关联子系统的建议设定（路面速比/抽吸比/尾气跟随），
  附带冲突告警（路面未跟随、辅机未运行、超常规区间等）
- apply_linkage：操作员确认后批量下发，逐项限值校验 + 联锁许可检查 + 审计
- validate_params：指令级限值前置校验（execute_command 调用，超限拒绝）
"""
from __future__ import annotations

import logging
from typing import Any

from app.adapters.registry import registry
from app.models.schemas import SubsystemId

logger = logging.getLogger(__name__)

# 可设定参数硬限值（param_key → (min, max)）
PARAM_LIMITS: dict[str, tuple[float, float]] = {
    "target_speed": (0, 120),
    "belt_speed": (0, 120),
    "yaw": (-30, 30),
    "suction_ratio": (0, 100),
    "supply_temp": (5, 40),
    "temp": (10, 40),
    "humidity": (20, 80),
    "x": (0, 3000),
    "y": (-1500, 1500),
    "z": (0, 2500),
}

# 常规试验风速区间（超出仅警告，不拒绝）
NORMAL_WIND_MAX = 85.0


def validate_params(params: dict[str, Any]) -> str | None:
    """指令参数限值校验：返回 None 通过，否则返回拒绝原因。"""
    for key, raw in params.items():
        if key not in PARAM_LIMITS or raw is None:
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return f"参数 {key} 不是数值：{raw!r}"
        lo, hi = PARAM_LIMITS[key]
        if not (lo <= v <= hi):
            return f"参数 {key}={v} 超出安全限值 [{lo}, {hi}]"
    return None


def _point(statuses: dict[str, dict[str, Any]], sid: str, key: str) -> Any:
    return statuses.get(sid, {}).get(key)


def preview_linkage(
    wind_speed: float,
    statuses: dict[str, dict[str, Any]],
    live_settings: dict[str, Any],
) -> dict[str, Any]:
    """给定目标风速，产出联动建议与冲突告警。

    statuses: {subsystem_id: {point_key/状态量: value}}（与联锁求值同一形态）。
    """
    lo, hi = PARAM_LIMITS["target_speed"]
    if not (lo <= wind_speed <= hi):
        return {"ok": False, "reject": f"目标风速 {wind_speed} 超出安全限值 [{lo:.0f}, {hi:.0f}] m/s", "warnings": [], "items": []}

    belt_ratio = float(live_settings.get("link_belt_ratio", 1.0))
    suction_ratio = float(live_settings.get("link_suction_ratio", 40))
    threshold = float(live_settings.get("link_wind_threshold", 5))

    belt_running = bool(_point(statuses, "rrs", "running")) or float(_point(statuses, "rrs", "belt_speed") or 0) > 0.01
    bl_running = bool(_point(statuses, "boundary_layer", "running"))
    exhaust_running = bool(_point(statuses, "exhaust", "running"))
    aux_all = all(bool(_point(statuses, s, "running")) for s in ("cooling_water", "compressed_air", "purge_air", "exhaust"))

    warnings: list[str] = []
    if wind_speed > NORMAL_WIND_MAX:
        warnings.append(f"目标风速超出常规试验区间（>{NORMAL_WIND_MAX:.0f} m/s），请确认结构/模型载荷裕度")
    if wind_speed >= 30 and not belt_running:
        warnings.append("路面未运行：有风工况 ≥30 m/s 时轮胎/模型底部流场不真实，建议启动滚动路面")
    if wind_speed > threshold and not aux_all:
        warnings.append("辅机未全部运行：长时间有风工况前请确认冷却水/压缩空气/吹扫风/尾气抽排已投入")

    items: list[dict[str, Any]] = []
    if wind_speed >= threshold:
        belt_target = round(wind_speed * belt_ratio, 1)
        items.append({
            "id": "belt_follow",
            "label": f"路面速度跟随（速比 {belt_ratio:g}）",
            "subsystem": "rrs",
            "command": "set_belt_speed",
            "params": {"belt_speed": belt_target},
            "param_key": "belt_speed",
            "unit": "m/s",
            "current": float(_point(statuses, "rrs", "belt_speed") or 0),
            "suggested": belt_target,
            "default_checked": belt_running or wind_speed >= 30,
            "warn": "" if belt_running else "路面未运行，设定值将在启动后生效",
        })
    if wind_speed >= 20:
        items.append({
            "id": "suction_ratio",
            "label": "边界层抽吸比",
            "subsystem": "boundary_layer",
            "command": "set_ratio",
            "params": {"suction_ratio": suction_ratio},
            "param_key": "suction_ratio",
            "unit": "%",
            "current": float(_point(statuses, "boundary_layer", "suction_ratio") or 0),
            "suggested": suction_ratio,
            "default_checked": bl_running,
            "warn": "" if bl_running else "抽吸未运行，设定值将在启动后生效",
        })
    if wind_speed >= 10:
        items.append({
            "id": "exhaust_follow",
            "label": "尾气抽排跟随风机",
            "subsystem": "exhaust",
            "command": "sync_with_fan",
            "params": {"fan_accel": True},
            "param_key": "fan_accel",
            "unit": "",
            "current": None,
            "suggested": None,
            "default_checked": exhaust_running,
            "warn": "" if exhaust_running else "尾气抽排未运行，跟随将在启动后生效",
        })
    return {"ok": True, "reject": "", "warnings": warnings, "items": items}


async def apply_linkage(
    items: list[dict[str, Any]],
    *,
    user: str,
    role: Any,
    audit: Any,
    check_command: Any,
) -> list[dict[str, Any]]:
    """批量下发联动设定：逐项限值校验 + 联锁许可检查，单失败不中断其余项。"""
    results: list[dict[str, Any]] = []
    for item in items:
        sid = str(item.get("subsystem") or "")
        command = str(item.get("command") or "")
        params = item.get("params") or {}
        label = str(item.get("label") or f"{sid}.{command}")
        entry: dict[str, Any] = {"id": item.get("id", ""), "label": label, "ok": False, "message": ""}
        try:
            SubsystemId(sid)
        except ValueError:
            entry["message"] = f"未知子系统：{sid}"
            results.append(entry)
            continue
        err = validate_params(params)
        if err:
            entry["message"] = err
        else:
            blocked = check_command(sid, command)
            if blocked:
                entry["message"] = blocked
            else:
                try:
                    msg = await registry.get(SubsystemId(sid)).write_command(command, params)
                    entry["ok"] = True
                    entry["message"] = msg
                    await audit.add(user, role, "联动设定", f"{label}：{sid}.{command} {params} → {msg}", sid)
                except Exception as exc:  # noqa: BLE001
                    entry["message"] = str(exc)
                    logger.warning("联动设定失败: %s.%s %s → %s", sid, command, params, exc)
        if not entry["ok"]:
            await audit.add(user, role, "联动设定被拒", f"{label}：{entry['message']}", sid)
        results.append(entry)
    return results
