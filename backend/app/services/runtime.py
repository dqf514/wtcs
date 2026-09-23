from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import time
import uuid
from collections import deque
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException

from app.adapters.registry import registry
from app.core.auth import ROLE_ORDER
from app.core.config import settings
from app.services.orchestration import SequenceEngine, compute_system_state, seed_sequences
from app.models.schemas import (
    AuditEntry,
    CommandRequest,
    CommandResult,
    ConnMode,
    ConnState,
    Experiment,
    ExperimentCreate,
    ExperimentPhase,
    MatrixCondition,
    MatrixCreate,
    MatrixUpdate,
    Role,
    SafetyLevel,
    SubsystemId,
    SystemOverview,
    local_now,
)
from app.services import mqtt_pub
from app.services.health import health as health_svc
from app.services.store import WIDE_POINTS, store

logger = logging.getLogger(__name__)

# 就绪校验 / 风速稳定 / 移测架到位的统一看门狗超时（秒）
READY_TIMEOUT_SEC = 60.0
# 风速稳定判据：|实际-目标| <= max(WIND_TOL_ABS, 目标*WIND_TOL_RATIO)
WIND_TOL_ABS = 1.0
WIND_TOL_RATIO = 0.03
# 移测架到位判据（mm）
TRAVERSE_TOL_MM = 1.0
# 设备运行时长落库周期（秒）
EQUIP_PERSIST_SEC = 60.0


class ExecutionAborted(Exception):
    """执行上下文中止信号（矩阵/实验流水线内部使用）。"""


class ProfileContext:
    """一次风速程控（阶梯剖面）执行的共享上下文。

    状态机: running → completed | aborted | failed
    与矩阵 ExecutionContext 共用 _exec_lock 互斥，但不做暂停（语义简单：逐步 set_speed + 保持）。
    """

    def __init__(self, *, user: str, role: Role, profile_id: str, name: str, steps: list[dict[str, Any]]) -> None:
        self.user = user
        self.role = role
        self.profile_id = profile_id
        self.name = name
        self.steps = steps
        self.status = "running"
        self.step_index = -1
        self.step_remaining_sec = 0.0
        self.abort_requested = False
        self.started_at = local_now()
        self.finished_at: datetime | None = None

    @property
    def total_steps(self) -> int:
        return len(self.steps)

    def status_dict(self) -> dict[str, Any]:
        return {
            "id": self.profile_id,
            "name": self.name,
            "step_index": self.step_index,
            "total_steps": self.total_steps,
            "step_remaining_sec": round(self.step_remaining_sec, 1),
            "state": "running" if self.status == "running" else "idle",
            "status": self.status,
            "steps": self.steps,
            "started_by": self.user,
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "finished_at": self.finished_at.isoformat(timespec="seconds") if self.finished_at else None,
        }


class RunRecorder:
    """一次采集 run 的运行时记录器：遥测 tick 经它把采样写入 run_samples。"""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.t0 = time.monotonic()
        self.paused = False


class ExecutionContext:
    """一次矩阵执行（或单实验流水线）的共享上下文。

    状态机: running ⇄ paused → completed | aborted | failed
    """

    def __init__(
        self,
        *,
        user: str,
        role: Role,
        matrix_id: str | None = None,
        matrix_name: str = "",
        experiment_id: str | None = None,
        scenario: str = "",
        on_error: str = "abort",
    ) -> None:
        self.user = user
        self.role = role
        self.matrix_id = matrix_id
        self.matrix_name = matrix_name
        self.experiment_id = experiment_id
        self.scenario = scenario
        self.on_error = on_error
        self.status = "running"
        # pause_event 置位=运行中，清除=暂停
        self.pause_event = asyncio.Event()
        self.pause_event.set()
        self.abort_requested = False
        self.rows: list[dict[str, Any]] = []
        self.current_index = -1
        self.started_at = local_now()
        self.finished_at: datetime | None = None
        self.row_durations: list[float] = []

    @property
    def total_rows(self) -> int:
        return len(self.rows)

    @property
    def done_rows(self) -> int:
        return sum(1 for r in self.rows if r["status"] in ("completed", "failed", "aborted"))

    def eta_seconds(self) -> float | None:
        """估计剩余时间：已完成行平均耗时 × 剩余行数。"""
        if not self.row_durations:
            return None
        avg = sum(self.row_durations) / len(self.row_durations)
        remaining = self.total_rows - self.done_rows
        return round(avg * max(0, remaining), 1)

    def status_dict(self) -> dict[str, Any]:
        current = None
        if 0 <= self.current_index < self.total_rows:
            row = self.rows[self.current_index]
            if row["status"] == "running":
                current = {"row_index": row["index"], "repeat_no": row["repeat_no"], "condition": row["condition"]}
        return {
            "matrix_id": self.matrix_id,
            "matrix_name": self.matrix_name,
            "experiment_id": self.experiment_id,
            "status": self.status,
            "progress": f"{self.done_rows}/{self.total_rows}",
            "done_rows": self.done_rows,
            "total_rows": self.total_rows,
            "current": current,
            "eta_seconds": self.eta_seconds(),
            "rows": [
                {k: r[k] for k in ("index", "repeat_no", "status", "run_id", "error")}
                for r in self.rows
            ],
            "started_by": self.user,
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "finished_at": self.finished_at.isoformat(timespec="seconds") if self.finished_at else None,
        }

# 运行时生效的设置默认值（PUT /api/settings 保存后由 refresh_settings 刷新）
DEFAULT_LIVE_SETTINGS: dict[str, Any] = {
    "theme": "dark",
    "default_scenario": "气动实验",
    "language": "zh",
    "large_screen_refresh_ms": 1000,
    "telemetry_hz": 10,
    "history_retention_days": 30,
    "audit_retention_days": 180,
    "alert_retention_count": 5000,
    "ai_inspect_enabled": True,
    "ai_inspect_interval_sec": 8,
    "force_simulation": settings.force_simulation,
    "auto_backup_enabled": False,
    "auto_backup_interval_hours": 24,
    # 健康基线（数字孪生）：学习开关 / 评估周期 / 冷启动样本数
    "health_learning_enabled": True,
    "health_eval_interval_sec": 2,
    "health_min_samples": 100,
    # MQTT 开放数据通道（可选，需安装 paho-mqtt，未安装时自动降级）
    "mqtt_enabled": False,
    "mqtt_host": "127.0.0.1",
    "mqtt_port": 1883,
    "mqtt_topic_prefix": "wtcs",
}


class AuditService:
    def __init__(self, maxlen: int = 5000) -> None:
        self._entries: deque[AuditEntry] = deque(maxlen=maxlen)

    async def load(self) -> None:
        for raw in await store.list_audit(200):
            try:
                self._entries.append(AuditEntry.model_validate(raw))
            except Exception:  # noqa: BLE001
                logger.warning("跳过无法解析的审计记录: %s", raw.get("id", "?"))

    async def add(self, user: str, role: Role | str, action: str, detail: str, subsystem_id: str | None = None) -> AuditEntry:
        entry = AuditEntry(
            id=uuid.uuid4().hex[:12],
            user=user,
            role=role.value if isinstance(role, Role) else str(role),
            action=action,
            detail=detail,
            subsystem_id=subsystem_id,
        )
        self._entries.appendleft(entry)
        try:
            await store.add_audit(entry.model_dump(mode="json"))
        except Exception:  # noqa: BLE001
            logger.exception("审计记录写入数据库失败: %s %s", action, detail)
        return entry

    def list(self, limit: int = 100) -> list[AuditEntry]:
        return list(self._entries)[:limit]


class ExperimentService:
    def __init__(self, audit: AuditService) -> None:
        self._audit = audit
        self._items: dict[str, Experiment] = {}
        self.active_id: str | None = None

    async def load(self) -> None:
        for raw in await store.list_experiments():
            try:
                exp = Experiment.model_validate(raw)
                self._items[exp.id] = exp
            except Exception:  # noqa: BLE001
                logger.warning("跳过无法解析的实验记录: %s", raw.get("id", "?"))

    async def create(self, body: ExperimentCreate, user: str, role: Role) -> Experiment:
        exp = Experiment(
            id=uuid.uuid4().hex[:10],
            title=body.title,
            scenario=body.scenario,
            phase=ExperimentPhase.idle,
            wind_speed=body.wind_speed,
            temperature=body.temperature,
            yaw_angle=body.yaw_angle,
            belt_speed=body.belt_speed,
            traverse_x=body.traverse_x,
            traverse_y=body.traverse_y,
            traverse_z=body.traverse_z,
            duration_sec=body.duration_sec,
            reference_area=body.reference_area,
            notes=body.notes,
            order_id=body.order_id,
            created_by=user,
        )
        self._items[exp.id] = exp
        await store.save_experiment(exp.model_dump(mode="json"))
        await self._audit.add(user, role, "创建实验", f"{exp.title} / {exp.scenario.value}", None)
        logger.info("实验创建: %s（%s）by %s", exp.title, exp.id, user)
        return exp

    def list(self) -> list[Experiment]:
        return sorted(self._items.values(), key=lambda x: x.created_at, reverse=True)

    def get(self, exp_id: str) -> Experiment:
        return self._items[exp_id]

    async def set_phase(self, exp_id: str, phase: ExperimentPhase, user: str, role: Role) -> Experiment:
        exp = self._items[exp_id]
        exp.phase = phase
        exp.updated_at = local_now()
        if phase != ExperimentPhase.idle and phase != ExperimentPhase.aborted:
            self.active_id = exp_id
        if phase in (ExperimentPhase.finishing, ExperimentPhase.aborted, ExperimentPhase.idle):
            if self.active_id == exp_id:
                self.active_id = None
        await store.save_experiment(exp.model_dump(mode="json"))
        await self._audit.add(user, role, "实验阶段", f"{exp.title} → {phase.value}", None)
        logger.info("实验 %s 阶段变更 → %s（操作者 %s）", exp_id, phase.value, user)
        return exp


class RuntimeHub:
    """总控运行时：遥测循环、指令网关、安全态、概览。"""

    def __init__(self) -> None:
        self.audit = AuditService()
        self.experiments = ExperimentService(self.audit)
        self.safety = SafetyLevel.normal
        self._task: asyncio.Task | None = None
        self._ai_task: asyncio.Task | None = None
        self._maintenance_task: asyncio.Task | None = None
        self._health_task: asyncio.Task | None = None
        self._mqtt_task: asyncio.Task | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._wind_speed = 0.0
        self._temperature = 25.0
        self._confirm_tokens: dict[str, CommandRequest] = {}
        self._sample_counter = 0
        self.latest_ai_alerts: list[dict[str, Any]] = []
        self.live_settings: dict[str, Any] = dict(DEFAULT_LIVE_SETTINGS)
        self.started_at: datetime | None = None
        self._last_cleanup_day: str = ""
        self._last_backup_at: datetime | None = None
        # 执行互斥：同一时刻只允许一个矩阵或实验流水线
        self._exec_lock = asyncio.Lock()
        # 当前采集记录器（遥测 tick 写 run_samples）
        self._recorder: RunRecorder | None = None
        # 系统级状态机（派生态，snapshot 时重算）与启停序列引擎
        self.system_state: dict[str, Any] = {"state": "standby", "label": "待机", "tone": "dim", "unready_aux": [], "since": ""}
        self.sequences = SequenceEngine(self.audit, lambda: self.safety)
        # 矩阵执行上下文（按矩阵 id 保留最近一次执行状态）
        self._matrix_execs: dict[str, ExecutionContext] = {}
        self._matrix_task: asyncio.Task | None = None
        # 单实验流水线执行上下文
        self._exp_ctx: ExecutionContext | None = None
        # 风速程控执行上下文（同时最多一个，与矩阵/流水线共用 _exec_lock）
        self._profile_ctx: ProfileContext | None = None
        self._profile_task: asyncio.Task | None = None
        # 设备台账运行时长累计（秒）：total 持久化、today 按日归零；每 EQUIP_PERSIST_SEC 落库一次
        self._equip_total: dict[str, float] = {}
        self._equip_today: dict[str, float] = {}
        self._equip_day: str = ""
        self._equip_persist_timer = 0.0

    async def start(self) -> None:
        await self.refresh_settings()
        registry.load(bool(self.live_settings.get("force_simulation", True)))
        await self.audit.load()
        await self.experiments.load()
        for ad in registry.all():
            try:
                await ad.connect()
            except Exception:  # noqa: BLE001
                # 真机未实现时允许启动，状态保持故障/未连接
                logger.warning("子系统 %s 连接失败: %s", ad.subsystem_id.value, ad.state.value)
        self.started_at = local_now()
        await self._load_equipment_runtime()
        await seed_sequences()
        self._task = asyncio.create_task(self._loop())
        self._ai_task = asyncio.create_task(self._ai_loop())
        self._maintenance_task = asyncio.create_task(self._maintenance_loop())
        # 健康基线：恢复落库基线后启动低频评估循环
        health_svc.attach(lambda: self.live_settings)
        await health_svc.load()
        self._health_task = asyncio.create_task(health_svc.run())
        # MQTT 开放数据通道（默认关闭；未安装 paho-mqtt 时自动降级）
        self._mqtt_task = asyncio.create_task(mqtt_pub.run(lambda: self.live_settings))
        logger.info(
            "RuntimeHub 启动完成：%d 个子系统，遥测 %s Hz",
            len(registry.all()),
            self.live_settings.get("telemetry_hz"),
        )

    async def stop(self) -> None:
        for ctx in list(self._matrix_execs.values()) + ([self._exp_ctx] if self._exp_ctx else []):
            ctx.abort_requested = True
            ctx.pause_event.set()
        if self._profile_ctx is not None:
            self._profile_ctx.abort_requested = True
        await self.sequences.stop()
        for task in (self._task, self._ai_task, self._maintenance_task, self._matrix_task,
                     self._profile_task, self._health_task, self._mqtt_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        # 停止前把设备运行时长落库，重启不丢
        try:
            await self._persist_equipment_runtime()
        except Exception:  # noqa: BLE001
            logger.exception("停止时设备运行时长落库失败")
        # 停止前把健康基线落库，供下次启动恢复
        try:
            await health_svc.persist()
        except Exception:  # noqa: BLE001
            logger.exception("停止时健康基线落库失败")
        for ad in registry.all():
            try:
                await ad.disconnect()
            except Exception:  # noqa: BLE001
                logger.warning("子系统 %s 断开失败", ad.subsystem_id.value, exc_info=True)
        logger.info("RuntimeHub 已停止")

    async def refresh_settings(self) -> dict[str, Any]:
        """从 store 读取已保存设置并与默认值合并，作为运行时生效值。"""
        merged = dict(DEFAULT_LIVE_SETTINGS)
        try:
            merged.update(await store.all_settings())
        except Exception:  # noqa: BLE001
            logger.exception("读取设置失败，使用默认值")
        self.live_settings = merged
        return merged

    async def apply_force_simulation(self, force: bool) -> None:
        """force_simulation 设置真实生效：按新值重建并重连全部适配器。"""
        logger.warning("force_simulation 切换为 %s，重建全部适配器", force)
        for ad in registry.all():
            try:
                await ad.disconnect()
            except Exception:  # noqa: BLE001
                logger.warning("子系统 %s 断开失败", ad.subsystem_id.value, exc_info=True)
        registry.load(force)
        for ad in registry.all():
            try:
                await ad.connect()
            except Exception:  # noqa: BLE001
                logger.warning("子系统 %s 重连失败", ad.subsystem_id.value, exc_info=True)

    async def _ai_loop(self) -> None:
        from app.services.extras import run_ai_inspection

        while True:
            interval = float(self.live_settings.get("ai_inspect_interval_sec", 8))
            try:
                if self.live_settings.get("ai_inspect_enabled", True):
                    self.latest_ai_alerts = await run_ai_inspection(self.safety, self._wind_speed)
                    await store.prune_ai_alerts(int(self.live_settings.get("alert_retention_count", 5000)))
            except Exception:  # noqa: BLE001
                logger.exception("AI 巡检循环异常")
            await asyncio.sleep(max(2.0, interval))

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _loop(self) -> None:
        while True:
            hz = float(self.live_settings.get("telemetry_hz", 10))
            period = 1.0 / max(1.0, min(20.0, hz))
            try:
                await self._tick(period)
            except Exception:  # noqa: BLE001
                logger.exception("遥测循环异常，继续运行")
            await asyncio.sleep(period)

    async def _maintenance_loop(self) -> None:
        """后台维护：每日按保留策略清理 + 定时自动备份。"""
        while True:
            try:
                today = local_now().strftime("%Y-%m-%d")
                if self._last_cleanup_day != today:
                    self._last_cleanup_day = today
                    removed = await store.apply_retention(
                        int(self.live_settings.get("history_retention_days", 30)),
                        int(self.live_settings.get("audit_retention_days", 180)),
                        int(self.live_settings.get("alert_retention_count", 5000)),
                    )
                    logger.info("每日清理完成: %s", removed)
                if self.live_settings.get("auto_backup_enabled", False):
                    interval_h = float(self.live_settings.get("auto_backup_interval_hours", 24))
                    due = self._last_backup_at is None or (
                        local_now() - self._last_backup_at
                    ) >= timedelta(hours=interval_h)
                    if due:
                        from app.services.backup import create_backup

                        info = await create_backup()
                        self._last_backup_at = local_now()
                        logger.info("自动备份完成: %s", info["name"])
            except Exception:  # noqa: BLE001
                logger.exception("后台维护任务异常")
            await asyncio.sleep(60)

    async def _tick(self, dt: float) -> None:
        phase = ExperimentPhase.idle
        if self.experiments.active_id:
            phase = self.experiments.get(self.experiments.active_id).phase

        # 从主风机读风速
        try:
            fan = await registry.get(SubsystemId.main_fan).read_status()
            for p in fan.points:
                if p.key == "wind_speed":
                    self._wind_speed = float(p.value or 0)
        except Exception:  # noqa: BLE001
            logger.warning("读取主风机风速失败", exc_info=True)

        try:
            cool = await registry.get(SubsystemId.cooling_water).read_status()
            for p in cool.points:
                if p.key == "supply_temp":
                    self._temperature = float(p.value or 25)
        except Exception:  # noqa: BLE001
            logger.warning("读取冷却水温度失败", exc_info=True)

        ctx = {"wind_speed": self._wind_speed, "phase": phase.value, "temperature": self._temperature}
        for ad in registry.all():
            if ad.state in (ConnState.connected, ConnState.degraded, ConnState.local_override):
                try:
                    await ad.tick(dt, ctx)
                except Exception:  # noqa: BLE001
                    ad.state = ConnState.fault
                    logger.warning("子系统 %s tick 异常，置为故障", ad.subsystem_id.value, exc_info=True)

        # 设备台账：按子系统运行/采集状态累计运行时长（周期落库，重启不丢）
        try:
            await self._accumulate_equipment_runtime(dt)
        except Exception:  # noqa: BLE001
            logger.exception("设备运行时长累计异常")

        # 安全态
        try:
            safety = await registry.get(SubsystemId.safety).read_status()
            vals = {p.key: p.value for p in safety.points}
            other_fault = False
            for a in registry.all():
                if a.subsystem_id == SubsystemId.safety:
                    continue
                if (await a.read_status()).fault:
                    other_fault = True
                    break
            if vals.get("e_stop"):
                self.safety = SafetyLevel.e_stop
            elif not vals.get("interlock_ok", True):
                self.safety = SafetyLevel.safe_stop
            elif other_fault:
                self.safety = SafetyLevel.alarm
            else:
                self.safety = SafetyLevel.normal
        except Exception:  # noqa: BLE001
            logger.warning("安全态判定失败，保持原状态 %s", self.safety.value, exc_info=True)

        self._sample_counter += 1
        if self._sample_counter % int(max(1, hz := float(self.live_settings.get("telemetry_hz", 10)))) == 0:
            try:
                await store.add_sample(
                    self._wind_speed,
                    self._temperature,
                    self.safety.value,
                    {"phase": phase.value},
                )
            except Exception:  # noqa: BLE001
                logger.exception("遥测采样写入失败")
            # 宽表遥测：1Hz 一行写入关键测点全集，供历史查询/统计分析
            try:
                await store.add_wide_sample(await self._collect_wide_values())
            except Exception:  # noqa: BLE001
                logger.exception("宽表遥测采样写入失败")

        # 采集中的 run：每个遥测 tick 写一条 run_samples（暂停时跳过）
        rec = self._recorder
        if rec is not None and not rec.paused:
            try:
                channels = await self._collect_run_channels()
                await store.add_run_sample(rec.run_id, round(time.monotonic() - rec.t0, 2), channels)
            except Exception:  # noqa: BLE001
                logger.exception("run 采样写入失败")

        snapshot = await self.snapshot()
        dead: list[asyncio.Queue] = []
        for q in self._subscribers:
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(snapshot)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    async def snapshot(self) -> dict[str, Any]:
        statuses = []
        for ad in registry.all():
            try:
                statuses.append((await ad.read_status()).model_dump(mode="json"))
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取子系统 %s 状态失败: %s", ad.subsystem_id.value, exc)
                statuses.append(
                    {
                        "id": ad.subsystem_id.value,
                        "name": ad.contract.name,
                        "mode": ad.mode.value,
                        "state": ConnState.fault.value,
                        "fault": True,
                        "fault_message": str(exc),
                        "points": [],
                    }
                )
        overview = await self.overview()
        # 系统级状态机：由刚采集的子系统状态聚合（辅机清单可在设置中覆盖）
        required = self.live_settings.get("ready_required_subsystems")
        self.system_state = compute_system_state(
            statuses,
            self.safety.value,
            self.sequences.active_kind,
            required if isinstance(required, list) else None,
        )
        return {
            "overview": overview.model_dump(mode="json"),
            "subsystems": statuses,
            "ai_alerts": self.latest_ai_alerts[:8],
            "system_state": self.system_state,
            "sequence_exec": self.sequences.snapshot(),
            "server_time": local_now().isoformat(timespec="seconds"),
        }

    async def overview(self) -> SystemOverview:
        ads = registry.all()
        sim_n = sum(1 for a in ads if a.mode == ConnMode.simulation)
        real_n = len(ads) - sim_n
        connected = sum(
            1
            for a in ads
            if a.state in (ConnState.connected, ConnState.degraded, ConnState.local_override)
        )
        fault_n = 0
        for a in ads:
            try:
                st = await a.read_status()
                if st.fault or a.state == ConnState.fault:
                    fault_n += 1
            except Exception:  # noqa: BLE001
                logger.warning("读取子系统 %s 状态失败", a.subsystem_id.value, exc_info=True)
                fault_n += 1
        phase = ExperimentPhase.idle
        if self.experiments.active_id:
            phase = self.experiments.get(self.experiments.active_id).phase
        return SystemOverview(
            app_name=settings.app_name,
            version=settings.app_version,
            safety=self.safety,
            wind_speed=round(self._wind_speed, 2),
            temperature=round(self._temperature, 2),
            experiment_phase=phase,
            active_experiment_id=self.experiments.active_id,
            simulation_count=sim_n,
            real_count=real_n,
            connected_count=connected,
            fault_count=fault_n,
            profile=self.profile_status(),
        )

    def arm_command(self, req: CommandRequest) -> str:
        token = uuid.uuid4().hex
        self._confirm_tokens[token] = req
        return token

    async def execute_command(self, req: CommandRequest, user: str, role: Role) -> CommandResult:
        # 急停始终可执行
        if self.safety == SafetyLevel.e_stop and req.command not in ("reset_e_stop", "e_stop", "ack_alarm"):
            if req.subsystem_id != SubsystemId.safety:
                return CommandResult(ok=False, message="系统处于急停状态，仅允许安全相关操作")

        contract = registry.get(req.subsystem_id).contract
        cmd_spec = next((c for c in contract.commands if c.name == req.command), None)
        if not cmd_spec:
            return CommandResult(ok=False, message="未知命令")

        # 指令级角色校验：低于 CommandSpec.min_role 拒绝
        try:
            required_role = Role(cmd_spec.min_role)
        except ValueError:
            required_role = Role.operator
        if ROLE_ORDER.get(role, 0) < ROLE_ORDER.get(required_role, 1):
            await self.audit.add(
                user, role, "指令被拒",
                f"{req.subsystem_id.value}.{req.command} 需要 {required_role.value}",
                req.subsystem_id.value,
            )
            logger.warning(
                "指令越权拒绝: %s（%s）→ %s.%s（需 %s）",
                user, role.value, req.subsystem_id.value, req.command, required_role.value,
            )
            raise HTTPException(
                status_code=403,
                detail=f"权限不足：指令 {req.command} 需要 {required_role.value} 及以上角色",
            )

        if cmd_spec.require_confirm:
            if not req.confirm_token or req.confirm_token not in self._confirm_tokens:
                token = self.arm_command(req)
                return CommandResult(
                    ok=False,
                    message=f"高风险指令需二次确认，请携带 confirm_token 重发: {token}",
                    audit_id=None,
                )
            armed = self._confirm_tokens.pop(req.confirm_token)
            if armed.subsystem_id != req.subsystem_id or armed.command != req.command:
                return CommandResult(ok=False, message="确认令牌与指令不匹配")

        try:
            msg = await registry.get(req.subsystem_id).write_command(req.command, req.params)
            # 急停时联动：目标风速清零（仿真）
            if req.subsystem_id == SubsystemId.safety and req.command == "e_stop":
                try:
                    await registry.get(SubsystemId.main_fan).write_command("stop", {})
                except Exception:  # noqa: BLE001
                    logger.warning("急停联动停主风机失败", exc_info=True)
                self.safety = SafetyLevel.e_stop
            entry = await self.audit.add(
                user,
                role,
                "下发指令",
                f"{req.subsystem_id.value}.{req.command} {req.params} → {msg}",
                req.subsystem_id.value,
            )
            logger.info("指令下发: %s → %s.%s %s → %s", user, req.subsystem_id.value, req.command, req.params, msg)
            return CommandResult(ok=True, message=msg, audit_id=entry.id)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            await self.audit.add(user, role, "指令失败", str(exc), req.subsystem_id.value)
            logger.warning("指令执行失败: %s.%s → %s", req.subsystem_id.value, req.command, exc)
            return CommandResult(ok=False, message=str(exc))

    async def _collect_run_channels(self) -> dict[str, Any]:
        """从刚 tick 完的适配器采集一帧 run 通道数据。

        通道组：balance 天平六分量（rrs 仿真值，q=½ρv²+噪声）、
        pressure 8 测点压力扫描（动压×压力系数+噪声）、
        acoustic 4 通道麦克风 dB（声学子系统 spl 加通道偏置）、
        env 风速/温度。
        """
        rrs_vals: dict[str, Any] = {}
        try:
            st = await registry.get(SubsystemId.rrs).read_status()
            rrs_vals = {p.key: p.value for p in st.points}
        except Exception:  # noqa: BLE001
            logger.warning("采集天平通道失败", exc_info=True)
        spl = 45.0
        try:
            st = await registry.get(SubsystemId.acoustic).read_status()
            spl = float(next((p.value for p in st.points if p.key == "spl"), 45.0) or 45.0)
        except Exception:  # noqa: BLE001
            logger.warning("采集声学通道失败", exc_info=True)
        wind = self._wind_speed
        q = 0.5 * 1.225 * wind * wind
        pressure = {
            f"p{i + 1:02d}": round(q * (0.95 - i * 0.11) + random.uniform(-3.0, 3.0), 2)
            for i in range(8)
        }
        acoustic = {
            f"mic{i + 1}": round(spl + offset + random.uniform(-0.8, 0.8), 2)
            for i, offset in enumerate((0.0, -2.5, 1.5, -4.0))
        }
        return {
            "balance": {k: rrs_vals.get(k) for k in ("fx", "fy", "fz", "mx", "my", "mz")},
            "pressure": pressure,
            "acoustic": acoustic,
            "env": {"wind_speed": round(wind, 3), "temperature": round(self._temperature, 2)},
        }

    async def _collect_wide_values(self) -> dict[str, float]:
        """采集宽表落库点集（store.WIDE_POINTS）的当前值；非数值/读取失败的键跳过。"""
        values: dict[str, float] = {}
        for sid, keys in WIDE_POINTS.items():
            try:
                st = await registry.get(SubsystemId(sid)).read_status()
            except Exception:  # noqa: BLE001
                logger.warning("宽表采集读取 %s 失败", sid, exc_info=True)
                continue
            vals = {p.key: p.value for p in st.points}
            for k in keys:
                v = vals.get(k)
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    continue
                values[f"{sid}.{k}"] = round(float(v), 4)
        return values

    # ---------- 矩阵 / 流水线执行引擎 ----------

    def exec_busy(self) -> bool:
        return self._exec_lock.locked()

    def request_abort(self, experiment_id: str | None = None) -> bool:
        """请求中止当前执行（POST /experiments/{id}/phase=aborted 联动）。"""
        ctx = self._exp_ctx
        if ctx is not None and ctx.status in ("running", "paused"):
            if experiment_id is None or ctx.experiment_id == experiment_id:
                ctx.abort_requested = True
                ctx.pause_event.set()
                logger.warning("实验流水线中止请求: experiment=%s", experiment_id)
                return True
        return False

    async def _wait_ready_checks(self, ctx: ExecutionContext, wind_target: float) -> None:
        """就绪校验：子系统无故障且 ready；随后等待风速稳定（超时看门狗 READY_TIMEOUT_SEC）。"""
        not_ready: list[str] = []
        for ad in registry.all():
            st = await ad.read_status()
            if st.fault or st.local_debug:
                not_ready.append(st.name)
            elif "ready" in {p.key for p in st.points}:
                ready = next(p.value for p in st.points if p.key == "ready")
                if not ready:
                    not_ready.append(st.name)
        if not_ready:
            raise RuntimeError(f"就绪校验失败: {', '.join(not_ready)}")

        tol = max(WIND_TOL_ABS, abs(wind_target) * WIND_TOL_RATIO)
        deadline = time.monotonic() + READY_TIMEOUT_SEC
        while abs(self._wind_speed - wind_target) > tol:
            if ctx.abort_requested:
                raise ExecutionAborted()
            if not ctx.pause_event.is_set():
                await ctx.pause_event.wait()
                continue
            if time.monotonic() > deadline:
                raise RuntimeError(
                    f"风速稳定超时（{READY_TIMEOUT_SEC:.0f}s）：当前 {self._wind_speed:.1f} / 目标 {wind_target:.1f} m/s"
                )
            await asyncio.sleep(0.5)

    async def _wait_traverse(self, ctx: ExecutionContext, x: float, y: float, z: float) -> None:
        """等待移测架到位（超时看门狗 READY_TIMEOUT_SEC）。"""
        deadline = time.monotonic() + READY_TIMEOUT_SEC
        while True:
            if ctx.abort_requested:
                raise ExecutionAborted()
            if not ctx.pause_event.is_set():
                await ctx.pause_event.wait()
                continue
            st = await registry.get(SubsystemId.traverse).read_status()
            vals = {p.key: p.value for p in st.points}
            in_pos = all(
                abs(float(vals.get(a, 0.0)) - t) <= TRAVERSE_TOL_MM
                for a, t in (("x", x), ("y", y), ("z", z))
            )
            if not vals.get("moving") and in_pos:
                return
            if time.monotonic() > deadline:
                raise RuntimeError(f"移测架到位超时（{READY_TIMEOUT_SEC:.0f}s）：目标 ({x},{y},{z})")
            await asyncio.sleep(0.3)

    async def _acquire_run(self, ctx: ExecutionContext, cond: dict[str, Any], row_index: int) -> str:
        """采集一个 run：创建配置快照（含可复现哈希），按 duration_sec 采集，中止标记 aborted。"""
        snapshot = {
            "wind_speed": cond.get("wind_speed"),
            "temperature": cond.get("temperature"),
            "yaw_angle": cond.get("yaw_angle"),
            "belt_speed": cond.get("belt_speed"),
            "traverse": {
                "x": cond.get("traverse_x"),
                "y": cond.get("traverse_y"),
                "z": cond.get("traverse_z"),
            },
            "scenario": ctx.scenario,
            "duration_sec": cond.get("duration_sec"),
            "repeat": cond.get("repeat", 1),
            "reference_area": cond.get("reference_area", 2.0),
            "experiment_id": ctx.experiment_id,
            "matrix_id": ctx.matrix_id,
            "row_index": row_index,
            "settings": {
                k: self.live_settings.get(k)
                for k in ("telemetry_hz", "force_simulation", "default_scenario")
            },
        }
        config_hash = hashlib.sha256(
            json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()[:16]
        run_id = uuid.uuid4().hex[:10]
        now = local_now().isoformat(timespec="seconds")
        await store.create_run(
            {
                "id": run_id,
                "experiment_id": ctx.experiment_id,
                "matrix_id": ctx.matrix_id,
                "row_index": row_index,
                "config": snapshot,
                "config_hash": config_hash,
                "status": "running",
                "operator": ctx.user,
                "started_at": now,
                "created_at": now,
            }
        )
        logger.info("采集 run 开始: %s（矩阵 %s 第 %s 行，时长 %ss）", run_id, ctx.matrix_id, row_index, cond.get("duration_sec"))

        recorder = RunRecorder(run_id)
        self._recorder = recorder
        status = "completed"
        try:
            for sid in (SubsystemId.rrs, SubsystemId.pressure, SubsystemId.acoustic):
                try:
                    await registry.get(sid).write_command("start_acquire", {})
                except Exception:  # noqa: BLE001
                    logger.warning("%s start_acquire 失败", sid.value, exc_info=True)
            duration = float(cond.get("duration_sec") or 5.0)
            deadline = time.monotonic() + duration
            while True:
                if ctx.abort_requested:
                    status = "aborted"
                    break
                if not ctx.pause_event.is_set():
                    # 暂停：停止写入采样，采集时长顺延
                    recorder.paused = True
                    remaining = deadline - time.monotonic()
                    await ctx.pause_event.wait()
                    recorder.paused = False
                    deadline = time.monotonic() + max(0.0, remaining)
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(0.2, remaining))
        finally:
            for sid in (SubsystemId.rrs, SubsystemId.pressure, SubsystemId.acoustic):
                try:
                    await registry.get(sid).write_command("stop_acquire", {})
                except Exception:  # noqa: BLE001
                    logger.warning("%s stop_acquire 失败", sid.value, exc_info=True)
            if self._recorder is recorder:
                self._recorder = None
            await store.finish_run(run_id, status)
            logger.info("采集 run 结束: %s → %s", run_id, status)
        if status == "aborted":
            raise ExecutionAborted()
        return run_id

    async def _run_condition(self, ctx: ExecutionContext, cond: dict[str, Any], row_index: int) -> str:
        """执行单行工况：设工况 → 就绪校验 → 移测架到位 → 采集。返回 run_id。"""
        exp_id = ctx.experiment_id

        async def set_phase(phase: ExperimentPhase) -> None:
            if exp_id:
                await self.experiments.set_phase(exp_id, phase, ctx.user, ctx.role)

        # 1. 设定工况
        await set_phase(ExperimentPhase.setpoint)
        await registry.get(SubsystemId.main_fan).write_command(
            "set_speed", {"target_speed": cond.get("wind_speed", 0.0)}
        )
        await registry.get(SubsystemId.main_fan).write_command("start", {})
        await registry.get(SubsystemId.rrs).write_command("set_yaw", {"yaw": cond.get("yaw_angle", 0.0)})
        belt = cond.get("belt_speed")
        if belt is not None:
            await registry.get(SubsystemId.rrs).write_command("set_belt_speed", {"belt_speed": belt})
            await registry.get(SubsystemId.rrs).write_command("start_belt", {})
        await registry.get(SubsystemId.boundary_layer).write_command("start", {})
        await registry.get(SubsystemId.purge_air).write_command(
            "set_climate", {"temp": cond.get("temperature", 25.0), "humidity": 45}
        )
        await registry.get(SubsystemId.purge_air).write_command("start", {})

        # 2. 就绪校验（含风速稳定等待，超时 60s 看门狗）
        await set_phase(ExperimentPhase.readiness)
        await self._wait_ready_checks(ctx, float(cond.get("wind_speed") or 0.0))

        # 3. 移测架到位
        await set_phase(ExperimentPhase.moving)
        tx, ty, tz = cond.get("traverse_x", 0.0), cond.get("traverse_y", 0.0), cond.get("traverse_z", 0.0)
        await registry.get(SubsystemId.traverse).write_command("move_to", {"x": tx, "y": ty, "z": tz})
        await self._wait_traverse(ctx, float(tx), float(ty), float(tz))

        # 4. 采集
        await set_phase(ExperimentPhase.acquiring)
        return await self._acquire_run(ctx, cond, row_index)

    async def _execute_rows(self, ctx: ExecutionContext) -> None:
        """按行执行（调用方需已持有 _exec_lock），行失败按 on_error 处置。"""
        try:
            for i, row in enumerate(ctx.rows):
                if ctx.abort_requested:
                    break
                ctx.current_index = i
                row["status"] = "running"
                t0 = time.monotonic()
                try:
                    run_id = await self._run_condition(ctx, row["condition"], row["index"])
                    row["status"] = "completed"
                    row["run_id"] = run_id
                except ExecutionAborted:
                    row["status"] = "aborted"
                    break
                except Exception as exc:  # noqa: BLE001
                    row["status"] = "failed"
                    row["error"] = str(exc)
                    logger.warning("矩阵行执行失败: 第 %s 行 → %s", row["index"], exc)
                    if ctx.on_error == "abort":
                        ctx.status = "failed"
                        break
                finally:
                    ctx.row_durations.append(time.monotonic() - t0)
                    await self.audit.add(
                        ctx.user,
                        ctx.role,
                        "矩阵工况",
                        f"{ctx.matrix_name or '实验流水线'} 第{row['index'] + 1}行"
                        f"(第{row['repeat_no']}次) → {row['status']}"
                        + (f" run={row['run_id']}" if row.get("run_id") else "")
                        + (f" 原因: {row['error']}" if row.get("error") else ""),
                        None,
                    )
        finally:
            # 收尾：停风机/路面/边界层
            for sid, cmd in (
                (SubsystemId.main_fan, "stop"),
                (SubsystemId.rrs, "stop_belt"),
                (SubsystemId.boundary_layer, "stop"),
            ):
                try:
                    await registry.get(sid).write_command(cmd, {})
                except Exception:  # noqa: BLE001
                    logger.warning("收尾 %s.%s 失败", sid.value, cmd, exc_info=True)
            ctx.finished_at = local_now()
            if ctx.status in ("running", "paused"):
                ctx.status = "aborted" if ctx.abort_requested else "completed"
            logger.info("执行结束: %s → %s（%s/%s 行）", ctx.matrix_name or ctx.experiment_id, ctx.status, ctx.done_rows, ctx.total_rows)

    # ---------- 设备台账：运行时长累计 / 一机一档 ----------

    async def _load_equipment_runtime(self) -> None:
        """启动时恢复落库的运行时长；today 与库中日期不一致则归零。"""
        today = local_now().strftime("%Y-%m-%d")
        self._equip_day = today
        for row in await store.load_equipment_runtime():
            sid = row["subsystem_id"]
            self._equip_total[sid] = float(row.get("total_sec") or 0.0)
            self._equip_today[sid] = float(row.get("today_sec") or 0.0) if row.get("day") == today else 0.0

    @staticmethod
    def _equip_active(st: Any) -> bool:
        """运行中判定：running 布尔、采集中、或冷却水任一冷机开启。"""
        if getattr(st, "running", False):
            return True
        vals = {p.key: p.value for p in st.points}
        if vals.get("acquiring"):
            return True
        return any(vals.get(k) for k in ("chiller1_on", "chiller2_on", "chiller3_on"))

    async def _accumulate_equipment_runtime(self, dt: float) -> None:
        today = local_now().strftime("%Y-%m-%d")
        if today != self._equip_day:
            self._equip_day = today
            self._equip_today = {}
        for ad in registry.all():
            try:
                st = await ad.read_status()
            except Exception:  # noqa: BLE001
                continue
            if not self._equip_active(st):
                continue
            sid = ad.subsystem_id.value
            self._equip_total[sid] = self._equip_total.get(sid, 0.0) + dt
            self._equip_today[sid] = self._equip_today.get(sid, 0.0) + dt
        self._equip_persist_timer += dt
        if self._equip_persist_timer >= EQUIP_PERSIST_SEC:
            self._equip_persist_timer = 0.0
            await self._persist_equipment_runtime()

    async def _persist_equipment_runtime(self) -> None:
        rows = [
            (sid, round(self._equip_total.get(sid, 0.0), 1), self._equip_day, round(self._equip_today.get(sid, 0.0), 1))
            for sid in set(self._equip_total) | set(self._equip_today)
        ]
        await store.save_equipment_runtime(rows)

    async def equipment_list(self) -> list[dict[str, Any]]:
        """一机一档列表：12 子系统实时状态 + 今日/累计时长 + 未确认告警数 + 最近维护时间。"""
        last_maintenance = await store.latest_maintenance()
        alert_counts = await store.unacked_alert_counts()
        out: list[dict[str, Any]] = []
        for ad in registry.all():
            sid = ad.subsystem_id.value
            try:
                st = await ad.read_status()
                data = {
                    "state": st.state.value,
                    "mode": st.mode.value,
                    "ready": st.ready,
                    "running": self._equip_active(st),
                    "fault": st.fault,
                    "fault_message": st.fault_message,
                }
            except Exception as exc:  # noqa: BLE001
                logger.warning("设备台账读取 %s 失败: %s", sid, exc)
                data = {"state": ConnState.fault.value, "mode": ad.mode.value, "ready": False,
                        "running": False, "fault": True, "fault_message": str(exc)}
            out.append(
                {
                    "subsystem_id": sid,
                    "name": ad.contract.name,
                    **data,
                    "today_minutes": round(self._equip_today.get(sid, 0.0) / 60.0, 1),
                    "total_minutes": round(self._equip_total.get(sid, 0.0) / 60.0, 1),
                    "unacked_alerts": alert_counts.get(sid, 0),
                    "last_maintenance_at": last_maintenance.get(sid),
                }
            )
        return out

    # ---------- 风速程控（阶梯剖面）执行器 ----------

    def profile_status(self) -> dict[str, Any] | None:
        """overview 用：running 时返回执行详情，否则 None。"""
        ctx = self._profile_ctx
        if ctx is None or ctx.status != "running":
            return None
        return ctx.status_dict()

    def profile_exec_status(self, profile_id: str) -> str:
        """列表附带状态（参照矩阵 exec_status）：无执行记录为 idle。"""
        ctx = self._profile_ctx
        if ctx is None or ctx.profile_id != profile_id:
            return "idle"
        return ctx.status

    async def start_profile(self, profile_id: str, user: str, role: Role) -> dict[str, Any]:
        p = await store.get_profile(profile_id)
        if not p:
            raise HTTPException(404, "程控剖面不存在")
        if self._exec_lock.locked():
            raise HTTPException(409, "已有实验流水线/矩阵/程控在执行，稍后再试")
        if self.safety in (SafetyLevel.e_stop, SafetyLevel.safe_stop):
            raise HTTPException(409, f"系统处于{self.safety.value}状态，禁止启动程控")
        ctx = ProfileContext(
            user=user, role=role, profile_id=profile_id, name=p["name"], steps=p["steps"],
        )
        self._profile_ctx = ctx
        self._profile_task = asyncio.create_task(self._run_profile(ctx))
        await self.audit.add(user, role, "启动程控", f"{p['name']}（{ctx.total_steps} 步阶梯）", SubsystemId.main_fan.value)
        logger.info("程控启动: %s（%s）%d 步 by %s", p["name"], profile_id, ctx.total_steps, user)
        return ctx.status_dict()

    def stop_profile(self, user: str, role: Role) -> dict[str, Any]:
        ctx = self._profile_ctx
        if ctx is None or ctx.status != "running":
            raise HTTPException(409, "当前没有执行中的风速程控")
        ctx.abort_requested = True
        logger.warning("程控中止请求: %s by %s", ctx.profile_id, user)
        asyncio.create_task(self.audit.add(user, role, "中止程控", f"{ctx.name}（第 {ctx.step_index + 1}/{ctx.total_steps} 步）", SubsystemId.main_fan.value))
        return ctx.status_dict()

    async def _run_profile(self, ctx: ProfileContext) -> None:
        """逐步执行阶梯剖面：set_speed → 保持 hold_sec → 下一步。

        风机联动：启动时若风机未运行则先启动；结束/中止的安全语义为
        「保持当前设定风速，仅停止程控」（不停风机，避免气流突变损坏模型）。
        急停/安全停机时自动中止。
        """
        fan = registry.get(SubsystemId.main_fan)
        async with self._exec_lock:
            try:
                st = await fan.read_status()
                vals = {p.key: p.value for p in st.points}
                if not vals.get("running"):
                    await fan.write_command("start", {})
                    logger.info("程控联动：主风机未运行，已自动启动")
                for i, step in enumerate(ctx.steps):
                    if ctx.abort_requested or self.safety in (SafetyLevel.e_stop, SafetyLevel.safe_stop):
                        ctx.abort_requested = True
                        break
                    ctx.step_index = i
                    speed = float(step.get("speed", 0.0))
                    hold = float(step.get("hold_sec", 1.0))
                    await fan.write_command("set_speed", {"target_speed": speed})
                    logger.info("程控 %s 第 %d/%d 步: %s m/s 保持 %ss", ctx.name, i + 1, ctx.total_steps, speed, hold)
                    deadline = time.monotonic() + hold
                    ctx.step_remaining_sec = hold
                    while True:
                        if ctx.abort_requested or self.safety in (SafetyLevel.e_stop, SafetyLevel.safe_stop):
                            ctx.abort_requested = True
                            break
                        remaining = deadline - time.monotonic()
                        ctx.step_remaining_sec = max(0.0, remaining)
                        if remaining <= 0:
                            break
                        await asyncio.sleep(min(0.5, remaining))
                    if ctx.abort_requested:
                        break
                ctx.status = "aborted" if ctx.abort_requested else "completed"
            except asyncio.CancelledError:
                ctx.status = "aborted"
                raise
            except Exception:  # noqa: BLE001
                ctx.status = "failed"
                logger.exception("程控执行异常: %s", ctx.profile_id)
            finally:
                ctx.step_remaining_sec = 0.0
                ctx.finished_at = local_now()
                action = {"completed": "程控完成", "aborted": "程控中止", "failed": "程控失败"}.get(ctx.status, "程控结束")
                await self.audit.add(
                    ctx.user, ctx.role, action,
                    f"{ctx.name} → {ctx.status}（推进到第 {ctx.step_index + 1}/{ctx.total_steps} 步）",
                    SubsystemId.main_fan.value,
                )
                logger.info("程控结束: %s → %s", ctx.name, ctx.status)

    # ---------- 试验矩阵 CRUD 与执行 ----------

    async def create_matrix(self, body: MatrixCreate, user: str, role: Role) -> dict[str, Any]:
        now = local_now().isoformat(timespec="seconds")
        m = {
            "id": uuid.uuid4().hex[:10],
            "name": body.name,
            "scenario": body.scenario.value,
            "conditions": [c.model_dump() for c in body.conditions],
            "on_error": body.on_error,
            "version": 1,
            "history": [],
            "created_by": user,
            "created_at": now,
            "updated_at": now,
        }
        await store.save_matrix(m)
        await self.audit.add(user, role, "创建矩阵", f"{m['name']}（{len(m['conditions'])} 行工况）", None)
        logger.info("矩阵创建: %s（%s）by %s", m["name"], m["id"], user)
        return m

    async def update_matrix(self, matrix_id: str, body: MatrixUpdate, user: str, role: Role) -> dict[str, Any]:
        m = await store.get_matrix(matrix_id)
        if not m:
            raise HTTPException(404, "矩阵不存在")
        ctx = self._matrix_execs.get(matrix_id)
        if ctx and ctx.status in ("running", "paused"):
            raise HTTPException(409, "矩阵正在执行，禁止修改")
        data = body.model_dump(exclude_none=True)
        if not data:
            return m
        # 版本快照：修改前版本入 history
        m["history"].append(
            {
                "version": m["version"],
                "name": m["name"],
                "scenario": m["scenario"],
                "conditions": m["conditions"],
                "on_error": m["on_error"],
                "updated_at": m["updated_at"],
            }
        )
        if "scenario" in data and hasattr(data["scenario"], "value"):
            data["scenario"] = data["scenario"].value
        if "conditions" in data:
            data["conditions"] = [
                c if isinstance(c, dict) else c.model_dump() for c in data["conditions"]
            ]
        m.update(data)
        m["version"] = int(m["version"]) + 1
        m["updated_at"] = local_now().isoformat(timespec="seconds")
        await store.save_matrix(m)
        await self.audit.add(user, role, "修改矩阵", f"{m['name']} → v{m['version']}", None)
        logger.info("矩阵修改: %s（%s）→ v%s by %s", m["name"], matrix_id, m["version"], user)
        return m

    async def delete_matrix(self, matrix_id: str, user: str, role: Role) -> None:
        ctx = self._matrix_execs.get(matrix_id)
        if ctx and ctx.status in ("running", "paused"):
            raise HTTPException(409, "矩阵正在执行，禁止删除")
        ok = await store.delete_matrix(matrix_id)
        if not ok:
            raise HTTPException(404, "矩阵不存在")
        self._matrix_execs.pop(matrix_id, None)
        await self.audit.add(user, role, "删除矩阵", matrix_id, None)
        logger.info("矩阵删除: %s by %s", matrix_id, user)

    async def start_matrix(self, matrix_id: str, user: str, role: Role, experiment_id: str | None = None) -> dict[str, Any]:
        m = await store.get_matrix(matrix_id)
        if not m:
            raise HTTPException(404, "矩阵不存在")
        if self._exec_lock.locked():
            raise HTTPException(409, "已有矩阵或实验流水线在执行，稍后再试")
        if experiment_id:
            try:
                self.experiments.get(experiment_id)
            except KeyError as exc:
                raise HTTPException(404, "关联实验不存在") from exc
        ctx = ExecutionContext(
            user=user,
            role=role,
            matrix_id=matrix_id,
            matrix_name=m["name"],
            experiment_id=experiment_id,
            scenario=m["scenario"],
            on_error=m.get("on_error", "abort"),
        )
        for idx, cond in enumerate(m["conditions"]):
            cond = dict(cond)
            repeat = max(1, int(cond.get("repeat", 1)))
            for r in range(repeat):
                ctx.rows.append(
                    {
                        "index": idx,
                        "repeat_no": r + 1,
                        "status": "pending",
                        "run_id": None,
                        "error": "",
                        "condition": cond,
                    }
                )
        self._matrix_execs[matrix_id] = ctx
        self._matrix_task = asyncio.create_task(self._run_matrix(ctx))
        await self.audit.add(
            user, role, "启动矩阵", f"{m['name']}（{ctx.total_rows} 行执行）"
            + (f"，关联实验 {experiment_id}" if experiment_id else ""),
            None,
        )
        logger.info("矩阵启动: %s（%s）%d 行 by %s", m["name"], matrix_id, ctx.total_rows, user)
        return ctx.status_dict()

    async def _run_matrix(self, ctx: ExecutionContext) -> None:
        async with self._exec_lock:
            try:
                await self._execute_rows(ctx)
            except Exception:  # noqa: BLE001
                ctx.status = "failed"
                ctx.finished_at = local_now()
                logger.exception("矩阵执行异常: %s", ctx.matrix_id)

    def matrix_control(self, matrix_id: str, action: str, user: str, role: Role) -> dict[str, Any]:
        ctx = self._matrix_execs.get(matrix_id)
        if ctx is None or ctx.status not in ("running", "paused"):
            raise HTTPException(409, "矩阵当前不在执行中")
        if action == "pause":
            ctx.pause_event.clear()
            ctx.status = "paused"
        elif action == "resume":
            ctx.pause_event.set()
            ctx.status = "running"
        elif action == "abort":
            ctx.abort_requested = True
            ctx.pause_event.set()
        else:
            raise HTTPException(400, f"未知控制动作: {action}")
        logger.info("矩阵控制: %s → %s by %s", matrix_id, action, user)
        # 审计异步落库，不阻塞控制响应
        asyncio.create_task(self.audit.add(user, role, f"矩阵{action}", matrix_id, None))
        return ctx.status_dict()

    def matrix_status(self, matrix_id: str) -> dict[str, Any]:
        ctx = self._matrix_execs.get(matrix_id)
        if ctx is None:
            return {"matrix_id": matrix_id, "status": "idle", "progress": "0/0", "rows": []}
        return ctx.status_dict()

    async def run_experiment_pipeline(self, exp_id: str, user: str, role: Role) -> Experiment:
        """一键实验流水线：复用矩阵引擎的单行工况执行（带互斥、中止、看门狗）。

        移测架坐标与采集时长取自实验参数（不再硬编码）。
        """
        exp = self.experiments.get(exp_id)
        if self._exec_lock.locked():
            raise HTTPException(409, "已有矩阵或实验流水线在执行，稍后再试")
        cond = {
            "wind_speed": exp.wind_speed,
            "temperature": exp.temperature,
            "yaw_angle": exp.yaw_angle,
            "belt_speed": exp.belt_speed,
            "traverse_x": exp.traverse_x,
            "traverse_y": exp.traverse_y,
            "traverse_z": exp.traverse_z,
            "duration_sec": exp.duration_sec,
            "repeat": 1,
            "reference_area": exp.reference_area,
        }
        ctx = ExecutionContext(
            user=user,
            role=role,
            experiment_id=exp_id,
            scenario=exp.scenario.value,
            on_error="abort",
        )
        ctx.rows.append(
            {"index": 0, "repeat_no": 1, "status": "pending", "run_id": None, "error": "", "condition": cond}
        )
        self._exp_ctx = ctx
        self.experiments.active_id = exp_id
        async with self._exec_lock:
            try:
                await self.experiments.set_phase(exp_id, ExperimentPhase.planning, user, role)
                await self._run_condition(ctx, cond, 0)
                await self.experiments.set_phase(exp_id, ExperimentPhase.finishing, user, role)
            except ExecutionAborted:
                logger.warning("实验 %s 流水线被中止", exp_id)
            except Exception:  # noqa: BLE001
                logger.exception("实验 %s 流水线失败", exp_id)
                try:
                    await self.experiments.set_phase(exp_id, ExperimentPhase.aborted, user, role)
                except Exception:  # noqa: BLE001
                    logger.warning("标记实验中止失败", exc_info=True)
                raise
            finally:
                for sid, cmd in (
                    (SubsystemId.main_fan, "stop"),
                    (SubsystemId.rrs, "stop_belt"),
                    (SubsystemId.boundary_layer, "stop"),
                ):
                    try:
                        await registry.get(sid).write_command(cmd, {})
                    except Exception:  # noqa: BLE001
                        logger.warning("收尾 %s.%s 失败", sid.value, cmd, exc_info=True)
                ctx.finished_at = local_now()
                ctx.status = "aborted" if ctx.abort_requested else ("failed" if ctx.rows[0]["status"] == "failed" else "completed")
                cur = self.experiments.get(exp_id)
                if cur.phase not in (ExperimentPhase.aborted,):
                    await self.experiments.set_phase(exp_id, ExperimentPhase.idle, user, role)
                self._exp_ctx = None
        return self.experiments.get(exp_id)


hub = RuntimeHub()
