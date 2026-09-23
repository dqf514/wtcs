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
    lockouts: set[str] | None = None,
) -> dict[str, Any]:
    """由子系统状态聚合系统级状态。

    statuses: snapshot() 里的子系统状态字典列表（id/running/ready/fault）。
    sequence_kind: 正在执行的序列类型（startup/shutdown），无则 None。
    lockouts: 挂牌检修（LOTO）的子系统 id 集——挂牌辅机从就绪判定中摘除；主风机挂牌则系统不可开车。
    """
    lockouts = lockouts or set()
    required = [sid for sid in (required_aux or DEFAULT_REQUIRED_AUX) if sid not in lockouts]
    by_id = {s["id"]: s for s in statuses}
    fan_locked = "main_fan" in lockouts

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
        elif not aux_unready and not fan_locked and sequence_kind is None:
            state = "ready"
        elif sequence_kind == "startup" or (aux_unready and len(aux_unready) < len(required)):
            # 部分辅机已运行或开车序列执行中
            state = "preparing"
        else:
            state = "standby"

    meta = SYSTEM_STATES[state]
    unready_names = [by_id.get(sid, {}).get("name", sid) for sid in required if not by_id.get(sid, {}).get("running")]
    # 主风机挂牌：就绪无望，徽章 title 明示原因
    if fan_locked and state in ("standby", "preparing"):
        unready_names.append(f"{by_id.get('main_fan', {}).get('name', '主风机系统')}（挂牌检修）")
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


# ---------- 试验序列编排（实验工况步序列） ----------

# 步骤类型：sequence_step 调子系统启停序列 / setpoint 设定下发 / hold 保持 / acquire 采集开关 / notify 提示
EXP_STEP_TYPES = ("sequence_step", "setpoint", "hold", "acquire", "notify")

# setpoint/acquire 允许的子系统即全部 12 子系统（SubsystemId 枚举校验）
_ACQUIRE_ACTIONS = ("start", "stop")


def validate_exp_steps(steps: Any) -> list[dict[str, Any]]:
    """校验试验序列步骤结构，非法抛 ValueError。返回规范化后的步骤列表。"""
    if not isinstance(steps, list) or not steps:
        raise ValueError("步骤列表不能为空")
    out: list[dict[str, Any]] = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"第 {i + 1} 步必须是对象")
        t = step.get("type")
        if t not in EXP_STEP_TYPES:
            raise ValueError(f"第 {i + 1} 步类型无效（须为 {'/'.join(EXP_STEP_TYPES)}）: {t}")
        s: dict[str, Any] = {"type": t, "label": str(step.get("label") or "")}
        if t == "sequence_step":
            seq_id = str(step.get("sequence_id") or "").strip()
            if not seq_id:
                raise ValueError(f"第 {i + 1} 步缺少 sequence_id（子系统序列 id）")
            s["sequence_id"] = seq_id
            s["label"] = s["label"] or f"执行序列 {seq_id}"
        elif t == "setpoint":
            try:
                sid = SubsystemId(step.get("subsystem"))
            except ValueError as exc:
                raise ValueError(f"第 {i + 1} 步子系统不存在: {step.get('subsystem')}") from exc
            command = str(step.get("command") or "").strip()
            if not command:
                raise ValueError(f"第 {i + 1} 步缺少 command")
            s.update(subsystem=sid.value, command=command, params=dict(step.get("params") or {}))
            s["label"] = s["label"] or f"{sid.value}.{command}"
        elif t == "hold":
            try:
                seconds = float(step.get("seconds"))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"第 {i + 1} 步保持时长无效: {step.get('seconds')}") from exc
            if not 0 < seconds <= 3600:
                raise ValueError(f"第 {i + 1} 步保持时长须在 (0, 3600] 秒: {seconds}")
            s["seconds"] = seconds
            s["label"] = s["label"] or f"保持 {seconds:g}s"
        elif t == "acquire":
            try:
                sid = SubsystemId(step.get("subsystem"))
            except ValueError as exc:
                raise ValueError(f"第 {i + 1} 步子系统不存在: {step.get('subsystem')}") from exc
            action = str(step.get("action") or "")
            if action not in _ACQUIRE_ACTIONS:
                raise ValueError(f"第 {i + 1} 步采集动作须为 start/stop: {action}")
            s.update(subsystem=sid.value, action=action)
            s["label"] = s["label"] or f"{sid.value} 采集{'开始' if action == 'start' else '停止'}"
        else:  # notify
            message = str(step.get("message") or "").strip()
            if not message:
                raise ValueError(f"第 {i + 1} 步缺少提示内容 message")
            s["message"] = message
            s["alert"] = bool(step.get("alert"))
            s["label"] = s["label"] or f"提示：{message[:20]}"
        out.append(s)
    return out


class _SeqAbort(Exception):
    """试验序列中止信号（引擎内部使用）。"""


class ExperimentSequenceEngine:
    """试验序列执行引擎：实验工况步编排。

    - setpoint/acquire 经 exec_command 回调走 execute_command 全链路（限值/联锁/挂牌/命令单均生效）；
    - sequence_step 经 run_sequence 回调调子系统启停序列并等待完成；
    - 执行期持有 exec_lock（与矩阵/实验流水线互斥），同一时刻只允许一个试验序列；
    - 支持暂停/继续/跳过当前步/中止；急停立即中止；每步执行写审计。
    """

    def __init__(self, audit: Any, get_safety: Any, exec_command: Any, run_sequence: Any, exec_lock: asyncio.Lock) -> None:
        self._audit = audit
        self._get_safety = get_safety
        self._exec_command = exec_command  # async (subsystem, command, params, user, role) -> str
        self._run_sequence = run_sequence  # async (sequence_id, user, role, should_abort) -> str
        self._exec_lock = exec_lock
        self._task: asyncio.Task | None = None
        self._pause = asyncio.Event()
        self._pause.set()
        self._abort = False
        self._skip = False
        self.current: dict[str, Any] | None = None  # 进行中或最近一次执行

    @property
    def running(self) -> bool:
        return self.current is not None and self.current["state"] in ("running", "paused")

    @property
    def task(self) -> asyncio.Task | None:
        return self._task

    def snapshot(self) -> dict[str, Any] | None:
        return self.current

    def _safety_value(self) -> str:
        s = self._get_safety()
        return s if isinstance(s, str) else s.value

    def _estop(self) -> bool:
        return self._safety_value() == "急停"

    async def execute(self, seq: dict[str, Any], user: str, role: Any, experiment_id: str | None = None) -> dict[str, Any]:
        if self.running:
            raise RuntimeError("已有试验序列在执行中")
        if self._exec_lock.locked():
            raise RuntimeError("已有矩阵或实验流水线在执行，稍后再试")
        if self._estop():
            raise RuntimeError("系统处于急停状态，请先复位急停")
        steps = validate_exp_steps(seq["steps"])
        self._abort = False
        self._skip = False
        self._pause.set()
        self.current = {
            "id": uuid.uuid4().hex[:10],
            "seq_id": seq["id"],
            "name": seq["name"],
            "experiment_id": experiment_id,
            "state": "running",
            "operator": user,
            "started_at": local_now().isoformat(timespec="seconds"),
            "finished_at": "",
            "error": "",
            "current_step": 0,
            "total_steps": len(steps),
            "steps": [
                {"label": s["label"], "type": s["type"], "status": "pending", "message": ""}
                for s in steps
            ],
        }
        await self._audit.add(
            user, role, "试验序列启动",
            f"{seq['name']}（{len(steps)} 步，实验 {experiment_id or '未关联'}）", None,
        )
        logger.info("试验序列启动: %s by %s（实验 %s）", seq["name"], user, experiment_id)
        self._task = asyncio.create_task(self._run(steps, user, role))
        return self.current

    async def control(self, action: str, user: str, role: Any) -> dict[str, Any]:
        """执行控制：pause / resume / skip（跳过当前步）/ abort。"""
        if not self.running:
            raise RuntimeError("当前没有执行中的试验序列")
        cur = self.current
        assert cur is not None
        cn = {"pause": "暂停", "resume": "继续", "skip": "跳过当前步", "abort": "中止"}.get(action)
        if cn is None:
            raise RuntimeError(f"未知控制动作: {action}")
        if action == "pause":
            self._pause.clear()
            cur["state"] = "paused"
        elif action == "resume":
            self._pause.set()
            cur["state"] = "running"
        elif action == "skip":
            self._skip = True
            self._pause.set()  # 暂停中也允许跳过（唤醒当前步）
            if cur["state"] == "paused":
                cur["state"] = "running"
        else:  # abort
            self._abort = True
            self._pause.set()
        await self._audit.add(user, role, f"试验序列{cn}", cur["name"], None)
        logger.info("试验序列控制: %s → %s by %s", cur["name"], action, user)
        return cur

    async def stop(self) -> None:
        self._abort = True
        self._pause.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    # ---------- 内部 ----------

    def _fail_step(self, i: int, message: str) -> None:
        cur = self.current
        assert cur is not None
        cur["steps"][i]["status"] = "failed"
        cur["steps"][i]["message"] = message
        cur["state"] = "failed"
        cur["error"] = f"第 {i + 1} 步「{cur['steps'][i]['label']}」失败：{message}"

    def _abort_at(self, i: int, reason: str) -> None:
        cur = self.current
        assert cur is not None
        cur["steps"][i]["status"] = "skipped"
        cur["steps"][i]["message"] = reason
        for j in range(i + 1, cur["total_steps"]):
            cur["steps"][j]["status"] = "skipped"
        cur["state"] = "aborted"
        cur["error"] = reason

    async def _run(self, steps: list[dict[str, Any]], user: str, role: Any) -> None:
        cur = self.current
        assert cur is not None
        async with self._exec_lock:  # 执行期持锁：矩阵/实验流水线/其他试验序列不得并发
            try:
                for i, step in enumerate(steps):
                    cur["current_step"] = i
                    st = cur["steps"][i]
                    # 暂停：步骤开始前等待继续（暂停中也可跳过/中止）
                    if not self._pause.is_set():
                        cur["state"] = "paused"
                        await self._pause.wait()
                        if not self._abort and not self._estop():
                            cur["state"] = "running"
                    if self._abort:
                        self._abort_at(i, "操作员中止")
                        break
                    if self._estop():
                        self._fail_step(i, "系统急停，序列中止")
                        cur["state"] = "aborted"
                        cur["error"] = "系统急停，序列中止"
                        break
                    if self._skip:
                        # 暂停期间点了跳过：本步不执行
                        self._skip = False
                        st["status"] = "skipped"
                        st["message"] = "已跳过"
                        await self._audit.add(user, role, "试验序列步骤", f"{cur['name']} 第{i + 1}步「{st['label']}」→ 已跳过", None)
                        continue
                    st["status"] = "running"
                    try:
                        msg = await self._exec_step(step, i, user, role)
                    except _SeqAbort:
                        self._abort_at(i, "操作员中止")
                        break
                    except Exception as exc:  # noqa: BLE001
                        self._fail_step(i, str(exc))
                        logger.warning("试验序列步骤失败: %s 第%d步 → %s", cur["name"], i + 1, exc)
                        break
                    if self._skip:
                        self._skip = False
                        st["status"] = "skipped"
                        st["message"] = "已跳过"
                    else:
                        st["status"] = "ok"
                        st["message"] = msg
                    await self._audit.add(user, role, "试验序列步骤", f"{cur['name']} 第{i + 1}步「{st['label']}」→ {st['message']}", None)
                if cur["state"] in ("running", "paused"):
                    cur["state"] = "succeeded"
                    await self._audit.add(user, role, "试验序列完成", cur["name"], None)
                    logger.info("试验序列完成: %s", cur["name"])
                else:
                    await self._audit.add(user, role, "试验序列未成功", f"{cur['name']}: {cur['error']}", None)
            finally:
                cur["finished_at"] = local_now().isoformat(timespec="seconds")
                self._skip = False

    async def _exec_step(self, step: dict[str, Any], idx: int, user: str, role: Any) -> str:
        t = step["type"]
        if t == "setpoint":
            return await self._exec_command(step["subsystem"], step["command"], step["params"], user, role)
        if t == "acquire":
            cmd = "start_acquire" if step["action"] == "start" else "stop_acquire"
            return await self._exec_command(step["subsystem"], cmd, {}, user, role)
        if t == "hold":
            return await self._hold(step["seconds"], idx)
        if t == "sequence_step":
            return await self._run_sequence(
                step["sequence_id"], user, role,
                lambda: self._abort or self._skip or self._estop(),
            )
        # notify：写审计（调用方统一写步骤审计）+ 可选 info 级告警
        msg = step["message"]
        if step.get("alert"):
            cur = self.current
            assert cur is not None
            await store.activate_interlock_alert({
                "id": uuid.uuid4().hex[:12],
                "level": "info",
                "severity": "info",
                "dedupe_key": f"exp_seq:{cur['id']}:{idx}",
                "subsystem_id": "",
                "subsystem_name": "试验序列",
                "message": f"试验序列「{cur['name']}」第 {idx + 1} 步：{msg}",
                "ts": local_now().isoformat(timespec="seconds"),
                "source": "试验序列",
                "active": True,
                "count": 1,
            })
        return msg

    async def _hold(self, seconds: float, idx: int) -> str:
        """保持 N 秒：暂停顺延、可跳过、可中止、急停中止；step message 实时显示剩余秒数。"""
        cur = self.current
        assert cur is not None
        deadline = time.monotonic() + seconds
        while True:
            if self._abort:
                raise _SeqAbort()
            if self._estop():
                raise RuntimeError("系统急停，序列中止")
            if self._skip:
                return "已跳过"
            if not self._pause.is_set():
                remaining = deadline - time.monotonic()
                await self._pause.wait()
                deadline = time.monotonic() + max(0.0, remaining)
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                cur["steps"][idx]["message"] = ""
                return f"保持 {seconds:g}s 完成"
            cur["steps"][idx]["message"] = f"剩余 {remaining:.1f}s"
            await asyncio.sleep(min(0.2, remaining))
