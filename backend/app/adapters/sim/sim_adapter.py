from __future__ import annotations

import math
import random
from typing import Any

from app.adapters.base.adapter import SubsystemAdapter
from app.models.schemas import ConnMode, SubsystemId


class SimAdapter(SubsystemAdapter):
    """高保真仿真适配器：业务与 UI 在建设期完全可跑通。"""

    def __init__(self, subsystem_id: SubsystemId, endpoint: str = ""):
        super().__init__(subsystem_id, endpoint)
        self._t = 0.0
        self._target_speed = 0.0
        self._belt_target = 0.0
        # 天平夹零偏置：tare 命令记录六分量当前值，此后读数扣除
        self._tare_off: dict[str, float] = {}

    @property
    def mode(self) -> ConnMode:
        return ConnMode.simulation

    async def _connect_impl(self) -> None:
        # 仿真瞬时就绪
        if "ready" in self._values:
            self._values["ready"] = True

    async def _disconnect_impl(self) -> None:
        pass

    async def tick(self, dt: float, context: dict[str, Any]) -> None:
        self._t += dt
        sid = self.subsystem_id
        wind = float(context.get("wind_speed", 0.0))
        phase = str(context.get("phase", "空闲"))

        if sid == SubsystemId.main_fan:
            cur = float(self._values.get("wind_speed", 0.0))
            tgt = float(self._values.get("target_speed", self._target_speed))
            # 一阶跟随
            cur += (tgt - cur) * min(1.0, dt * 0.35)
            self._values["wind_speed"] = max(0.0, cur + random.uniform(-0.05, 0.05) * (1 if cur > 1 else 0))
            self._values["frequency"] = self._values["wind_speed"] * 0.42
            self._values["power"] = (self._values["wind_speed"] ** 3) * 0.015
            self._values["running"] = self._values["wind_speed"] > 0.5
            self._values["ready"] = not self._values.get("fault", False)

        elif sid == SubsystemId.cooling_water:
            base = 8.0 + 0.3 * math.sin(self._t / 20)
            self._values["supply_temp"] = base
            self._values["return_temp"] = base + 4.5 + wind * 0.02
            self._values["flow"] = 180 + wind * 0.5
            self._values["pressure"] = 3.2
            self._values["chiller1_on"] = True
            self._values["chiller2_on"] = wind > 80
            self._values["chiller3_on"] = False
            self._values["running"] = True
            self._values["ready"] = True

        elif sid == SubsystemId.rrs:
            belt = float(self._values.get("belt_speed", 0.0))
            tgt = float(self._values.get("_belt_target", belt))
            belt += (tgt - belt) * min(1.0, dt * 0.5)
            self._values["belt_speed"] = max(0.0, belt)
            yaw = float(self._values.get("yaw", 0.0))
            # 简化气动力（raw 为未扣除夹零偏置的原值）
            q = 0.5 * 1.225 * (wind ** 2)
            fx = q * 0.85 * math.cos(math.radians(yaw)) + random.uniform(-2, 2)
            fy = q * 0.12 * math.sin(math.radians(yaw)) + random.uniform(-1, 1)
            fz = -q * 0.05 + random.uniform(-1, 1)
            raw = {"fx": fx, "fy": fy, "fz": fz, "mx": fy * 0.4, "my": fx * 0.35, "mz": fy * 0.2}
            for k, v in raw.items():
                self._values[k] = v - self._tare_off.get(k, 0.0)
            self._values["ready"] = True

        elif sid == SubsystemId.traverse:
            if self._values.get("moving"):
                # 向目标逼近
                for axis in ("x", "y", "z"):
                    cur = float(self._values[axis])
                    tgt = float(self._values.get(f"_{axis}_t", cur))
                    step = (tgt - cur) * min(1.0, dt * 2.0)
                    self._values[axis] = cur + step
                if all(abs(float(self._values[a]) - float(self._values.get(f"_{a}_t", self._values[a]))) < 0.5 for a in "xyz"):
                    self._values["moving"] = False
            self._values["ready"] = not self._values["moving"] and not self._values.get("fault", False)

        elif sid == SubsystemId.boundary_layer:
            ratio = float(self._values.get("suction_ratio", 1.2))
            self._values["suction_flow"] = wind * 0.012 * ratio + random.uniform(-0.01, 0.01)
            self._values["inverter_hz"] = 20 + wind * 0.15 * ratio
            self._values["static_pressure"] = -50 - wind * 0.8
            if phase in ("数据采集", "点位移动", "工况设置") and wind > 5:
                self._values["running"] = True
            self._values["ready"] = True

        elif sid == SubsystemId.purge_air:
            self._values["temp"] = float(self._values.get("temp", 25.0))
            self._values["humidity"] = float(self._values.get("humidity", 45.0))
            self._values["ready"] = True

        elif sid == SubsystemId.exhaust:
            total = int(self._values.get("damper_total", 36))
            if self._values.get("running"):
                self._values["damper_open_count"] = min(total, 12 + int(wind / 10))
            else:
                self._values["damper_open_count"] = 0
            self._values["ready"] = True

        elif sid == SubsystemId.compressed_air:
            self._values["pressure"] = 20.0 + random.uniform(-0.2, 0.2)
            self._values["running"] = True
            self._values["ready"] = True

        elif sid == SubsystemId.safety:
            # 由命令改写 e_stop；保持连锁正常除非急停
            if self._values.get("e_stop"):
                self._values["interlock_ok"] = False
                self._values["fault_level"] = 3
                self._values["message"] = "急停已触发"
            else:
                self._values["interlock_ok"] = True
                self._values["door_ok"] = True
                self._values["fault_level"] = 0
                self._values["message"] = "正常"

        elif sid in (SubsystemId.acoustic, SubsystemId.pressure, SubsystemId.flow_field):
            self._values["ready"] = True
            if sid == SubsystemId.acoustic:
                self._values["spl"] = 45 + wind * 0.15 + random.uniform(-0.5, 0.5)

    async def _write_impl(self, command: str, params: dict[str, Any]) -> str:
        sid = self.subsystem_id
        if command == "e_stop":
            self._values["e_stop"] = True
            return "急停已触发（仿真）"
        if command == "reset_e_stop":
            self._values["e_stop"] = False
            return "急停已复位（仿真）"
        if command == "ack_alarm":
            return "报警已确认"

        if sid == SubsystemId.main_fan:
            if command == "start":
                if "target_speed" not in self._values or self._values["target_speed"] == 0:
                    self._values["target_speed"] = 40.0
                return "主风机启动指令已接受"
            if command == "stop":
                self._values["target_speed"] = 0.0
                return "主风机停止指令已接受"
            if command == "set_speed":
                self._values["target_speed"] = float(params["target_speed"])
                return f"目标风速 → {self._values['target_speed']} m/s"
            if command == "reset_fault":
                self._values["fault"] = False
                return "故障已复位"

        if sid == SubsystemId.cooling_water:
            if command == "start":
                self._values["running"] = True
                return "冷却水系统已启动"
            if command == "stop":
                self._values["running"] = False
                return "冷却水系统已停止"
            if command == "set_temp":
                self._values["supply_temp"] = float(params["supply_temp"])
                return f"供水温度设定 → {params['supply_temp']} ℃"

        if sid == SubsystemId.rrs:
            if command == "start_belt":
                self._values["_belt_target"] = float(self._values.get("belt_speed") or params.get("belt_speed", 40))
                if self._values["_belt_target"] <= 0:
                    self._values["_belt_target"] = 40.0
                return "滚动路面启动"
            if command == "stop_belt":
                self._values["_belt_target"] = 0.0
                return "滚动路面停止"
            if command == "set_yaw":
                self._values["yaw"] = float(params["yaw"])
                return f"偏航 → {params['yaw']}°"
            if command == "set_belt_speed":
                self._values["_belt_target"] = float(params["belt_speed"])
                self._values["belt_speed"] = float(params["belt_speed"])
                return f"路面速度 → {params['belt_speed']} m/s"
            if command == "start_acquire":
                self._values["acquiring"] = True
                return "天平采集开始"
            if command == "stop_acquire":
                self._values["acquiring"] = False
                return "天平采集停止"
            if command == "tare":
                # 夹零：把六分量当前读数（原值 = 显示值 + 既有偏置）记为零点偏置，此后读数≈0
                for k in ("fx", "fy", "fz", "mx", "my", "mz"):
                    self._tare_off[k] = self._tare_off.get(k, 0.0) + float(self._values.get(k, 0.0))
                return "天平夹零完成，六分量已归零（仿真）"

        if sid == SubsystemId.traverse:
            if command == "move_to":
                self._values["_x_t"] = float(params["x"])
                self._values["_y_t"] = float(params["y"])
                self._values["_z_t"] = float(params["z"])
                self._values["moving"] = True
                self._values["ready"] = False
                return f"移测架目标 ({params['x']},{params['y']},{params['z']})"
            if command == "home":
                self._values["_x_t"] = self._values["_y_t"] = self._values["_z_t"] = 0.0
                self._values["moving"] = True
                return "回零中"
            if command == "stop":
                self._values["moving"] = False
                return "运动已停止"

        if sid == SubsystemId.boundary_layer:
            if command == "start":
                self._values["running"] = True
                return "边界层抽吸启动"
            if command == "stop":
                self._values["running"] = False
                return "边界层抽吸停止"
            if command == "set_ratio":
                self._values["suction_ratio"] = float(params["suction_ratio"])
                return f"抽吸比 → {params['suction_ratio']}%"

        if sid == SubsystemId.purge_air:
            if command == "start":
                self._values["running"] = True
                return "吹扫风启动"
            if command == "stop":
                self._values["running"] = False
                return "吹扫风停止"
            if command == "set_climate":
                self._values["temp"] = float(params["temp"])
                self._values["humidity"] = float(params["humidity"])
                return "温湿度目标已下发"

        if sid == SubsystemId.exhaust:
            if command == "start":
                self._values["running"] = True
                return "尾气抽排启动"
            if command == "stop":
                self._values["running"] = False
                return "尾气抽排停止"
            if command == "sync_with_fan":
                self._values["running"] = True
                return "风阀已跟随风机加减速"

        if sid == SubsystemId.compressed_air:
            if command == "start":
                self._values["running"] = True
                return "压缩空气启动"
            if command == "stop":
                self._values["running"] = False
                return "压缩空气停止"

        if sid in (SubsystemId.acoustic, SubsystemId.pressure, SubsystemId.flow_field):
            if command == "start_acquire":
                self._values["acquiring"] = True
                return "测量采集开始"
            if command == "stop_acquire":
                self._values["acquiring"] = False
                return "测量采集停止"

        return f"命令 {command} 已执行（仿真）"
