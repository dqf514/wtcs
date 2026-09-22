from __future__ import annotations

import abc
import logging
import time
from typing import Any

from app.contracts.icd import CONTRACTS, SubsystemContract
from app.models.schemas import (
    ConnMode,
    ConnState,
    ConnectivityCheckItem,
    ConnectivityReport,
    SubsystemId,
    SubsystemStatus,
    TelemetryPoint,
    local_now,
)

logger = logging.getLogger(__name__)


class SubsystemAdapter(abc.ABC):
    """所有子系统适配器必须实现本接口。

    建设期使用 SimAdapter；真机上线替换为 Real*Adapter，
    业务层（编排/前端）零改动，只需改 config 并跑连通性测试。
    """

    def __init__(self, subsystem_id: SubsystemId, endpoint: str = ""):
        self.subsystem_id = subsystem_id
        self.endpoint = endpoint
        self.contract: SubsystemContract = CONTRACTS[subsystem_id]
        self.state = ConnState.disconnected
        self._values: dict[str, Any] = {}
        self._init_defaults()

    def _init_defaults(self) -> None:
        for p in self.contract.points:
            if p.dtype == "bool":
                self._values[p.key] = False
            elif p.dtype == "int":
                self._values[p.key] = 0
            elif p.dtype == "str":
                self._values[p.key] = ""
            else:
                self._values[p.key] = 0.0
        if "ready" in self._values:
            self._values["ready"] = True
        if "interlock_ok" in self._values:
            self._values["interlock_ok"] = True
        if "door_ok" in self._values:
            self._values["door_ok"] = True
        if "message" in self._values:
            self._values["message"] = "正常"
        if "damper_total" in self._values:
            self._values["damper_total"] = 36
        if "channels_total" in self._values:
            self._values["channels_total"] = 64
            self._values["channels_ok"] = 64

    @property
    @abc.abstractmethod
    def mode(self) -> ConnMode: ...

    async def connect(self) -> None:
        self.state = ConnState.connecting
        await self._connect_impl()
        self.state = ConnState.connected

    async def disconnect(self) -> None:
        await self._disconnect_impl()
        self.state = ConnState.disconnected

    @abc.abstractmethod
    async def _connect_impl(self) -> None: ...

    @abc.abstractmethod
    async def _disconnect_impl(self) -> None: ...

    @abc.abstractmethod
    async def tick(self, dt: float, context: dict[str, Any]) -> None:
        """周期刷新遥测。context 含全局风速、实验阶段等。"""

    async def read_status(self) -> SubsystemStatus:
        points = [
            TelemetryPoint(
                key=p.key,
                label=p.label,
                value=self._values.get(p.key),
                unit=p.unit,
                ts=local_now(),
            )
            for p in self.contract.points
        ]
        local_debug = bool(self._values.get("local_debug", False))
        state = ConnState.local_override if local_debug and self.state == ConnState.connected else self.state
        return SubsystemStatus(
            id=self.subsystem_id,
            name=self.contract.name,
            mode=self.mode,
            state=state,
            local_debug=local_debug,
            ready=bool(self._values.get("ready", False)),
            running=bool(self._values.get("running", self._values.get("acquiring", False))),
            fault=bool(self._values.get("fault", self._values.get("e_stop", False))),
            fault_message=str(self._values.get("message", "") if self._values.get("fault") else ""),
            points=points,
            updated_at=local_now(),
        )

    async def write_command(self, command: str, params: dict[str, Any]) -> str:
        names = {c.name for c in self.contract.commands}
        if command not in names:
            raise ValueError(f"子系统 {self.subsystem_id.value} 不支持命令: {command}")
        if self.state not in (ConnState.connected, ConnState.local_override, ConnState.degraded):
            raise RuntimeError("子系统未连接，无法下发指令")
        if bool(self._values.get("local_debug")) and command not in ("e_stop",):
            raise RuntimeError("子系统处于本地调试模式，总控不可写（急停除外）")
        return await self._write_impl(command, params)

    @abc.abstractmethod
    async def _write_impl(self, command: str, params: dict[str, Any]) -> str: ...

    async def connectivity_test(self) -> ConnectivityReport:
        items: list[ConnectivityCheckItem] = []
        t0 = time.perf_counter()
        try:
            if self.state == ConnState.disconnected:
                await self.connect()
            latency = (time.perf_counter() - t0) * 1000
            items.append(
                ConnectivityCheckItem(
                    name="物理/仿真连接",
                    ok=self.state in (ConnState.connected, ConnState.degraded, ConnState.local_override),
                    detail=f"状态={self.state.value}",
                    latency_ms=round(latency, 2),
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("连通性测试连接失败 %s: %s", self.subsystem_id.value, exc)
            items.append(
                ConnectivityCheckItem(
                    name="物理/仿真连接",
                    ok=False,
                    detail=str(exc),
                    latency_ms=None,
                )
            )

        status = await self.read_status()
        point_keys = {p.key for p in status.points}
        expected = {p.key for p in self.contract.points}
        missing = sorted(expected - point_keys)
        items.append(
            ConnectivityCheckItem(
                name="ICD点位完整性",
                ok=not missing,
                detail="完整" if not missing else f"缺失: {', '.join(missing)}",
            )
        )

        cmd_ok = True
        cmd_detail = "命令表与契约一致"
        contract_cmds = {c.name for c in self.contract.commands}
        if not contract_cmds:
            cmd_detail = "无写命令"
        items.append(ConnectivityCheckItem(name="ICD命令表", ok=cmd_ok, detail=cmd_detail))

        # 只读探测：不真正破坏工况
        try:
            await self.tick(0.1, {"wind_speed": 0.0, "phase": "空闲"})
            items.append(ConnectivityCheckItem(name="周期读刷新", ok=True, detail="tick 成功"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("连通性测试 tick 失败 %s: %s", self.subsystem_id.value, exc)
            items.append(ConnectivityCheckItem(name="周期读刷新", ok=False, detail=str(exc)))

        # 真机模式额外：端点可达性说明
        if self.mode == ConnMode.real:
            items.append(
                ConnectivityCheckItem(
                    name="端点配置",
                    ok=bool(self.endpoint),
                    detail=self.endpoint or "未配置 endpoint",
                )
            )

        passed = all(i.ok for i in items)
        return ConnectivityReport(
            subsystem_id=self.subsystem_id,
            mode=self.mode,
            passed=passed,
            items=items,
        )
