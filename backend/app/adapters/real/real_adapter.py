"""真机适配器骨架 —— 子系统上线时在此实现协议读写即可。

当前全部抛出明确错误，避免误接；连通性测试会报告端点与 ICD 检查项。
后续可按协议拆分为：
  - real/opcua_adapter.py
  - real/tcp_adapter.py
  - real/modbus_adapter.py
"""

from __future__ import annotations

from typing import Any

from app.adapters.base.adapter import SubsystemAdapter
from app.models.schemas import ConnMode, ConnState, SubsystemId


class RealAdapter(SubsystemAdapter):
    """真机适配器占位：接口形状与 Sim 完全一致。"""

    def __init__(self, subsystem_id: SubsystemId, endpoint: str = "", protocol: str = "opcua"):
        super().__init__(subsystem_id, endpoint)
        self.protocol = protocol

    @property
    def mode(self) -> ConnMode:
        return ConnMode.real

    async def _connect_impl(self) -> None:
        if not self.endpoint:
            self.state = ConnState.fault
            raise ConnectionError(f"{self.subsystem_id.value} 未配置 endpoint")
        # TODO: 按 protocol 建立 OPC UA / TCP / Modbus 会话
        # 建设期未接真机时保持未实现，便于连通性测试明确失败原因
        raise NotImplementedError(
            f"真机适配器尚未实现协议读写: protocol={self.protocol}, endpoint={self.endpoint}。"
            "请在 adapters/real/ 中补齐后，将 subsystems.yaml 中 mode 改为 real。"
        )

    async def _disconnect_impl(self) -> None:
        pass

    async def tick(self, dt: float, context: dict[str, Any]) -> None:
        # TODO: 批量读关键点位（仅 critical 点实时上送）
        raise NotImplementedError("真机 tick 未实现")

    async def _write_impl(self, command: str, params: dict[str, Any]) -> str:
        # TODO: 映射 ICD 命令到 PLC/设备标签
        raise NotImplementedError(f"真机命令未实现: {command}")
