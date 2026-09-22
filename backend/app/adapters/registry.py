from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from app.adapters.base.adapter import SubsystemAdapter
from app.adapters.real.real_adapter import RealAdapter
from app.adapters.sim.sim_adapter import SimAdapter
from app.core.config import CONFIG_DIR, settings
from app.models.schemas import ConnMode, SubsystemId


def _load_yaml() -> dict[str, Any]:
    path = CONFIG_DIR / "subsystems.yaml"
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


class AdapterRegistry:
    def __init__(self) -> None:
        self._adapters: dict[SubsystemId, SubsystemAdapter] = {}
        self._meta: dict[SubsystemId, dict[str, Any]] = {}
        # 运行时生效的强制仿真标志（启动取 env 值，PUT /settings 可切换并重建适配器）
        self.force_simulation: bool = settings.force_simulation

    def load(self, force_simulation: bool | None = None) -> None:
        if force_simulation is None:
            force_simulation = settings.force_simulation
        self.force_simulation = force_simulation
        cfg = _load_yaml()
        subs = cfg.get("subsystems", {})
        self._adapters.clear()
        self._meta.clear()
        for key, meta in subs.items():
            sid = SubsystemId(key)
            mode = meta.get("mode", cfg.get("mode_default", "simulation"))
            if force_simulation:
                mode = "simulation"
            endpoint = meta.get("endpoint", "")
            protocol = meta.get("protocol", "opcua")
            if mode == ConnMode.real.value:
                adapter: SubsystemAdapter = RealAdapter(sid, endpoint=endpoint, protocol=protocol)
            else:
                adapter = SimAdapter(sid, endpoint=endpoint)
            self._adapters[sid] = adapter
            self._meta[sid] = meta

    def all(self) -> list[SubsystemAdapter]:
        return list(self._adapters.values())

    def get(self, sid: SubsystemId) -> SubsystemAdapter:
        return self._adapters[sid]

    def meta(self, sid: SubsystemId) -> dict[str, Any]:
        return self._meta[sid]

    def switch_mode(self, sid: SubsystemId, mode: ConnMode) -> SubsystemAdapter:
        """运行时切换仿真/真机（用于联调），并写回内存；持久化请改 yaml。"""
        meta = self._meta[sid]
        endpoint = meta.get("endpoint", "")
        protocol = meta.get("protocol", "opcua")
        if mode == ConnMode.real and self.force_simulation:
            raise RuntimeError("当前强制仿真已开启（force_simulation=true），禁止切真机。请先在设置中关闭。")
        adapter: SubsystemAdapter
        if mode == ConnMode.real:
            adapter = RealAdapter(sid, endpoint=endpoint, protocol=protocol)
        else:
            adapter = SimAdapter(sid, endpoint=endpoint)
        self._adapters[sid] = adapter
        meta["mode"] = mode.value
        return adapter


registry = AdapterRegistry()
