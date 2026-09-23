"""系统级编排：全局运行状态机 + 一键启停序列引擎。

总控台是风洞的唯一控制台：系统能不能开车由全部子系统状态聚合判定，
开车/停车按固定依赖顺序自动执行，操作员不再逐个手动启停子系统。

状态机（每次遥测快照时重算，派生态不落库）：
    急停 > 安全异常 > 停车中 > 准备中(序列) > 运行中 > 就绪 > 准备中(部分辅机) > 待机

序列执行：步骤顺序下发命令 → 等待条件满足（超时失败）→ 任一步失败即中止。
命令绕过人工确认（系统编排本身已是确认动作），但每步都写审计。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from app.adapters.registry import registry
from app.models.schemas import ConnState, SubsystemId, local_now
from app.services.store import store

logger = logging.getLogger(__name__)

# ---------- 全局状态机 ----------

# 进入"就绪"必须运行的辅机（安全连锁另算）。可在设置 ready_required_subsystems 中覆盖
DEFAULT_REQUIRED_AUX = ["cooling_water", "compressed_air", "purge_air", "exhaust"]

SYSTEM_STATES: dict[str, dict[str, str]] = {
    "e_stop": {"label": "急停", "tone": "danger"},
    "safety_fault": {"label": "安全异常", "tone": "danger"},
    "stopping": {"label": "停车中", "tone": "warn"},
    "preparing": {"label": "准备中", "tone": "info"},
    "running": {"label": "运行中", "tone": "ok"},
    "ready": {"label": "就绪", "tone": "ok"},
    "standby": {"label": "待机", "tone": "dim"},
}


def compute_system_state(
    statuses: list[dict[str, Any]],
    safety: str,
    sequence_kind: str | None,
    required_aux: list[str] | None = None,
) -> dict[str, Any]:
    """由子系统状态聚合系统级状态。

    statuses: snapshot() 里的子系统状态字典列表（id/running/ready/fault）。
    sequence_kind: 正在执行的序列类型（startup/shutdown），无则 None。
    """
    required = required_aux or DEFAULT_REQUIRED_AUX
    by_id = {s["id"]: s for s in statuses}

    if safety == "急停":
        state = "e_stop"
    elif safety in ("安全停车", "报警"):
        state = "safety_fault"
    elif sequence_kind == "shutdown":
        state = "stopping"
    else:
        fan_running = bool(by_id.get("main_fan", {}).get("running"))
        aux_unready = [sid for sid in required if not by_id.get(sid, {}).get("running")]
        if fan_running:
            state = "running"
        elif not aux_unready and sequence_kind is None:
            state = "ready"
        elif sequence_kind == "startup" or (aux_unready and len(aux_unready) < len(required)):
            # 部分辅机已运行或开车序列执行中
            state = "preparing"
        else:
            state = "standby"

    meta = SYSTEM_STATES[state]
    unready_names = [by_id.get(sid, {}).get("name", sid) for sid in required if not by_id.get(sid, {}).get("running")]
    return {
        "state": state,
        "label": meta["label"],
        "tone": meta["tone"],
        # 距就绪还差的辅机（就绪/运行时为空）
        "unready_aux": unready_names if state in ("standby", "preparing") else [],
        "since": local_now().isoformat(timespec="seconds"),
    }


# ---------- 启停序列 ----------

# 步骤结构：{label, subsystem, command, params?, wait?}
# wait: {"kind": "running"|"stopped"|"point_lt"|"point_gt"|"none", "point"?, "value"?, "timeout_s"}
DEFAULT_SEQUENCES: list[dict[str, Any]] = [
    {
        "id": "startup",
        "name": "一键开车",
        "kind": "startup",
        "steps": [
            {"label": "启动冷却水", "subsystem": "cooling_water", "command": "start", "wait": {"kind": "running", "timeout_s": 15}},
            {"label": "启动压缩空气", "subsystem": "compressed_air", "command": "start", "wait": {"kind": "running", "timeout_s": 10}},
            {"label": "启动吹扫风", "subsystem": "purge_air", "command": "start", "wait": {"kind": "running", "timeout_s": 10}},
            {"label": "启动尾气抽排", "subsystem": "exhaust", "command": "start", "wait": {"kind": "running", "timeout_s": 10}},
            {"label": "启动主风机", "subsystem": "main_fan", "command": "start", "wait": {"kind": "running", "timeout_s": 60}},
        ],
    },
    {
        "id": "shutdown",
        "name": "一键停车",
        "kind": "shutdown",
        "steps": [
            {"label": "停止滚动路面", "subsystem": "rrs", "command": "stop_belt", "wait": {"kind": "point_lt", "point": "belt_speed", "value": 0.5, "timeout_s": 60}},
            {"label": "停止主风机", "subsystem": "main_fan", "command": "stop", "wait": {"kind": "point_lt", "point": "wind_speed", "value": 0.5, "timeout_s": 120}},
            {"label": "停止边界层抽吸", "subsystem": "boundary_layer", "command": "stop", "wait": {"kind": "none"}},
            {"label": "停止尾气抽排", "subsystem": "exhaust", "command": "stop", "wait": {"kind": "none"}},
            {"label": "停止吹扫风", "subsystem": "purge_air", "command": "stop", "wait": {"kind": "none"}},
            {"label": "停止压缩空气", "subsystem": "compressed_air", "command": "stop", "wait": {"kind": "none"}},
            {"label": "停止冷却水", "subsystem": "cooling_water", "command": "stop", "wait": {"kind": "none"}},
        ],
    },
]

_STEP_REQUIRED_KEYS = ("label", "subsystem", "command")
_WAIT_KINDS = ("running", "stopped", "point_lt", "point_gt", "none")


def validate_steps(steps: Any) -> list[dict[str, Any]]:
    """校验序列步骤结构，非法抛 ValueError。返回规范化后的步骤列表。"""
    if not isinstance(steps, list) or not steps:
        raise ValueError("步骤列表不能为空")
    out = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict) or any(k not in step for k in _STEP_REQUIRED_KEYS):
            raise ValueError(f"第 {i + 1} 步缺少必填字段（label/subsystem/command）")
        try:
            sid = SubsystemId(step["subsystem"])
        except ValueError as exc:
            raise ValueError(f"第 {i + 1} 步子系统不存在: {step['subsystem']}") from exc
        wait = step.get("wait") or {"kind": "none"}
        if wait.get("kind") not in _WAIT_KINDS:
            raise ValueError(f"第 {i + 1} 步等待条件无效: {wait.get('kind')}")
        if wait.get("kind") in ("point_lt", "point_gt") and (not wait.get("point") or wait.get("value") is None):
            raise ValueError(f"第 {i + 1} 步测点等待需指定 point 与 value")
        out.append(
            {
                "label": str(step["label"]),
                "subsystem": sid.value,
                "command": str(step["command"]),
                "params": dict(step.get("params") or {}),
                "wait": {
                    "kind": wait["kind"],
                    "point": wait.get("point"),
                    "value": wait.get("value"),
                    "timeout_s": float(wait.get("timeout_s", 30)),
                },
            }
        )
    return out


async def seed_sequences() -> None:
    """首次启动播种默认序列；已存在则跳过（不覆盖管理员修改）。"""
    for seq in DEFAULT_SEQUENCES:
        if await store.get_sequence(seq["id"]) is None:
            await store.upsert_sequence(
                seq["id"], seq["name"], seq["kind"], seq["steps"], builtin=True, updated_by="system"
            )
            logger.info("播种默认序列: %s", seq["name"])


class SequenceEngine:
    """序列执行引擎：同一时刻只跑一个序列，急停立即中止。"""

    def __init__(self, audit: Any, get_safety: Any) -> None:
        self._audit = audit
        self._get_safety = get_safety
        self._task: asyncio.Task | None = None
        self._abort = False
        self.current: dict[str, Any] | None = None  # 进行中或最近一次执行

    @property
    def running(self) -> bool:
        return self.current is not None and self.current["state"] == "running"

    @property
    def active_kind(self) -> str | None:
        return self.current["kind"] if self.running else None

    def snapshot(self) -> dict[str, Any] | None:
        return self.current

    def _safety_value(self) -> str:
        """hub.safety 是 SafetyLevel 枚举；兼容字符串取值。"""
        s = self._get_safety()
        return s if isinstance(s, str) else s.value

    async def execute(self, seq: dict[str, Any], user: str, role: str) -> dict[str, Any]:
        if self.running:
            raise RuntimeError("已有序列在执行中")
        if self._safety_value() == "急停":
            raise RuntimeError("系统处于急停状态，请先复位急停")
        steps = validate_steps(seq["steps"])
        self._abort = False
        self.current = {
            "id": uuid.uuid4().hex[:10],
            "seq_id": seq["id"],
            "name": seq["name"],
            "kind": seq["kind"],
            "state": "running",
            "operator": user,
            "started_at": local_now().isoformat(timespec="seconds"),
            "finished_at": "",
            "error": "",
            "current_step": 0,
            "steps": [
                {"label": s["label"], "subsystem": s["subsystem"], "command": s["command"], "status": "pending", "message": ""}
                for s in steps
            ],
        }
        await self._audit.add(user, role, "序列启动", f"{seq['name']}（{len(steps)} 步）", None)
        logger.info("序列启动: %s by %s", seq["name"], user)
        self._task = asyncio.create_task(self._run(steps, user, role))
        return self.current

    async def abort(self, user: str, role: str) -> bool:
        if not self.running:
            return False
        self._abort = True
        await self._audit.add(user, role, "序列中止请求", self.current["name"], None)
        return True

    async def stop(self) -> None:
        self._abort = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _fail_step(self, i: int, message: str) -> None:
        assert self.current is not None
        self.current["steps"][i]["status"] = "failed"
        self.current["steps"][i]["message"] = message
        self.current["state"] = "failed"
        self.current["error"] = f"第 {i + 1} 步「{self.current['steps'][i]['label']}」失败：{message}"

    async def _run(self, steps: list[dict[str, Any]], user: str, role: str) -> None:
        assert self.current is not None
        cur = self.current
        try:
            for i, step in enumerate(steps):
                cur["current_step"] = i
                cur["steps"][i]["status"] = "running"
                if self._abort:
                    cur["steps"][i]["status"] = "skipped"
                    cur["state"] = "aborted"
                    cur["error"] = "操作员中止"
                    break
                if self._safety_value() == "急停":
                    self._fail_step(i, "系统急停，序列中止")
                    break
                try:
                    ad = registry.get(SubsystemId(step["subsystem"]))
                    if ad.state not in (ConnState.connected, ConnState.degraded, ConnState.local_override):
                        raise RuntimeError("子系统未连接")
                    msg = await ad.write_command(step["command"], step.get("params") or {})
                    cur["steps"][i]["message"] = msg
                    await self._wait_condition(ad, step["wait"], i)
                    if cur["state"] != "running":
                        break  # 等待失败/中止
                    cur["steps"][i]["status"] = "ok"
                    logger.info("序列步骤完成: %s → %s.%s", cur["name"], step["subsystem"], step["command"])
                except Exception as exc:  # noqa: BLE001
                    self._fail_step(i, str(exc))
                    logger.warning("序列步骤失败: %s 第%d步 → %s", cur["name"], i + 1, exc)
                    break
            if cur["state"] == "running":
                cur["state"] = "succeeded"
                await self._audit.add(user, role, "序列完成", cur["name"], None)
                logger.info("序列完成: %s", cur["name"])
            else:
                await self._audit.add(user, role, "序列未成功", f"{cur['name']}: {cur['error']}", None)
        finally:
            cur["finished_at"] = local_now().isoformat(timespec="seconds")

    async def _wait_condition(self, ad: Any, wait: dict[str, Any], step_idx: int) -> None:
        """等待步骤条件满足；超时/中止时直接修改 current 状态并返回。"""
        assert self.current is not None
        kind = wait.get("kind", "none")
        if kind == "none":
            return
        deadline = time.monotonic() + float(wait.get("timeout_s", 30))
        while time.monotonic() < deadline:
            if self._abort:
                self.current["steps"][step_idx]["status"] = "skipped"
                self.current["state"] = "aborted"
                self.current["error"] = "操作员中止"
                return
            st = await ad.read_status()
            if kind == "running" and st.running:
                return
            if kind == "stopped" and not st.running:
                return
            if kind in ("point_lt", "point_gt"):
                val = next((p.value for p in st.points if p.key == wait.get("point")), None)
                if isinstance(val, (int, float)):
                    if kind == "point_lt" and val < float(wait["value"]):
                        return
                    if kind == "point_gt" and val > float(wait["value"]):
                        return
            await asyncio.sleep(0.2)
        self._fail_step(step_idx, f"等待条件超时（{wait.get('timeout_s', 30)}s）")
