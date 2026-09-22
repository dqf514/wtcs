"""数字孪生健康基线服务：滚动 EMA 基线 + z-score 偏差评估 + 告警联动。

务实版设计：
- 每个受监控测点维护指数滑动均值/方差（EMA），内存为主，每 60s 批量落库
  （health_baselines 表），重启后从库恢复；
- 低频评估（默认每 2s 一次，设置项 health_eval_interval_sec），不在 10Hz
  tick 里做全量统计，计算量可忽略；
- z-score = (当前值 - 基线均值) / max(基线标准差, |均值|*1%, 1e-6)；
  |z|<2 正常 / 2~3 关注 / >=3 异常；健康度评分 = clamp(100 - 15*|z|, 0, 100)；
- 冷启动：样本数 < health_min_samples（默认 100）时状态 learning，不产出告警；
- 学习保护：|z|>=3 的样本不学进基线（防止异常污染基线）；
  设置项 health_learning_enabled=false 可整体暂停学习；
- 告警：|z|>3 持续 3 个评估周期才产出"健康偏差"告警，dedupe_key 为
  `<subsystem>:health_deviation:<point>`，经现有 ai_alerts 体系去重与自动恢复。

局限（遗留）：基线不分工况，风速/功率等随工况变化的测点在工况切换后会
出现偏差告警，需要操作员用学习开关/基线重置配合；后续可升级为分工况基线。
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections import deque
from typing import Any, Callable

from app.adapters.registry import registry
from app.contracts.icd import CONTRACTS
from app.models.schemas import ConnState, SubsystemId, local_now
from app.services.store import store

logger = logging.getLogger(__name__)

# 受监控测点：12 个子系统中的关键 float 测点（以 ICD 实际点位为准）。
# 移测架位置/风阀计数等随任务合法变化的点位不建基线。
MONITORED_POINTS: dict[str, tuple[str, ...]] = {
    "main_fan": ("wind_speed", "frequency", "power"),
    "cooling_water": ("supply_temp", "return_temp", "flow", "pressure"),
    "rrs": ("fx", "fy", "fz", "mx", "my", "mz"),
    "boundary_layer": ("suction_flow", "inverter_hz", "static_pressure"),
    "purge_air": ("temp", "humidity"),
    "compressed_air": ("pressure",),
    "acoustic": ("spl",),
}

EMA_ALPHA = 0.05  # 稳态 EMA 系数（约 40 个样本的记忆窗口）
FAST_CONVERGE_N = 40  # 前 N 个样本用 2/(n+1) 加速收敛
Z_ATTENTION = 2.0  # |z| 关注阈值
Z_ABNORMAL = 3.0  # |z| 异常阈值（同时是学习排除阈值）
Z_ALARM = 5.0  # |z| 告警升级为 alarm 的阈值
ALERT_CYCLES = 3  # 持续越限多少个评估周期后产出告警
PERSIST_INTERVAL_SEC = 60.0  # 基线落库周期
HISTORY_MAXLEN = 7200  # 每测点内存历史上限（默认 2s 周期 ≈ 4 小时）
Z_DISPLAY_CAP = 50.0  # z-score 展示封顶（标准差近 0 时避免天文数字）

STATUS_CN = {"normal": "正常", "attention": "关注", "abnormal": "异常", "learning": "学习中"}


class _Baseline:
    """单测点滚动基线：EMA 均值 + EMA 方差 + 样本数。"""

    __slots__ = ("mean", "var", "count")

    def __init__(self, mean: float = 0.0, var: float = 0.0, count: int = 0) -> None:
        self.mean = mean
        self.var = var
        self.count = count

    def update(self, v: float) -> None:
        self.count += 1
        alpha = 2.0 / (self.count + 1) if self.count < FAST_CONVERGE_N else EMA_ALPHA
        delta = v - self.mean
        self.mean += alpha * delta
        self.var = (1.0 - alpha) * (self.var + alpha * delta * delta)

    @property
    def std(self) -> float:
        return math.sqrt(max(self.var, 0.0))

    def z_score(self, v: float) -> float:
        # 标准差下限：|均值|的 1%，防止恒值测点上微小波动被放大
        floor = max(abs(self.mean) * 0.01, 1e-6)
        z = (v - self.mean) / max(self.std, floor)
        return max(-Z_DISPLAY_CAP, min(Z_DISPLAY_CAP, z))


class HealthService:
    """健康基线运行时：评估循环、偏差告警、历史环形缓冲（供 NL 统计查询）。"""

    def __init__(self) -> None:
        self._baselines: dict[tuple[str, str], _Baseline] = {}
        self._violations: dict[tuple[str, str], int] = {}
        self._latest: dict[tuple[str, str], dict[str, Any]] = {}
        self._history: dict[tuple[str, str], deque[tuple[float, float]]] = {}
        self._settings: Callable[[], dict[str, Any]] = lambda: {}
        self._last_persist = 0.0

    def attach(self, settings_getter: Callable[[], dict[str, Any]]) -> None:
        """注入运行时设置获取器（live_settings 会整体重建，必须用回调）。"""
        self._settings = settings_getter

    async def load(self) -> None:
        """启动时从 health_baselines 表恢复基线。"""
        try:
            rows = await store.load_health_baselines()
        except Exception:  # noqa: BLE001
            logger.exception("健康基线加载失败")
            return
        monitored = {(s, k) for s, keys in MONITORED_POINTS.items() for k in keys}
        n = 0
        for r in rows:
            key = (r["subsystem"], r["point"])
            if key not in monitored:
                continue
            std = float(r["baseline_std"])
            self._baselines[key] = _Baseline(
                float(r["baseline_mean"]), std * std, int(r["sample_count"])
            )
            n += 1
        if n:
            logger.info("健康基线已从数据库恢复: %d 条", n)

    async def run(self) -> None:
        """评估主循环（由 RuntimeHub 托管为后台任务）。"""
        while True:
            cfg = self._settings()
            interval = max(1.0, float(cfg.get("health_eval_interval_sec", 2)))
            try:
                await self.evaluate()
                if time.monotonic() - self._last_persist >= PERSIST_INTERVAL_SEC:
                    await self.persist()
            except Exception:  # noqa: BLE001
                logger.exception("健康基线评估异常")
            await asyncio.sleep(interval)

    async def evaluate(self) -> None:
        """单轮评估：读受监控子系统状态 → 更新基线 → 计算 z-score 与越限计数。"""
        cfg = self._settings()
        learning = bool(cfg.get("health_learning_enabled", True))
        min_samples = max(5, int(cfg.get("health_min_samples", 100)))
        now = time.time()
        for sid, keys in MONITORED_POINTS.items():
            try:
                st = await registry.get(SubsystemId(sid)).read_status()
            except Exception:  # noqa: BLE001
                logger.warning("健康评估读取 %s 失败", sid, exc_info=True)
                continue
            if st.state not in (ConnState.connected, ConnState.degraded, ConnState.local_override):
                continue
            vals = {p.key: p.value for p in st.points}
            for k in keys:
                v = vals.get(k)
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    continue
                v = float(v)
                key = (sid, k)
                self._history.setdefault(key, deque(maxlen=HISTORY_MAXLEN)).append((now, v))
                b = self._baselines.get(key)
                if b is None:
                    b = _Baseline(v, 0.0, 0)
                    self._baselines[key] = b
                ready = b.count >= min_samples
                z = b.z_score(v) if b.count >= 2 else 0.0
                violating = ready and abs(z) > Z_ABNORMAL
                # 学习：开启且当前未越限才更新，避免把异常学进基线
                if learning and not violating:
                    b.update(v)
                self._violations[key] = (
                    self._violations.get(key, 0) + 1 if violating else 0
                )
                if not ready:
                    status = "learning"
                elif abs(z) >= Z_ABNORMAL:
                    status = "abnormal"
                elif abs(z) >= Z_ATTENTION:
                    status = "attention"
                else:
                    status = "normal"
                score = None if status == "learning" else int(max(0.0, min(100.0, 100.0 - 15.0 * abs(z))))
                self._latest[key] = {
                    "current": round(v, 4),
                    "baseline_mean": round(b.mean, 4),
                    "baseline_std": round(b.std, 4),
                    "z_score": round(z, 2),
                    "sample_count": b.count,
                    "status": status,
                    "score": score,
                    "violation_cycles": self._violations[key],
                }

    # ---------- 查询接口 ----------

    def report(self) -> dict[str, Any]:
        """GET /api/twin/health 的响应体：测点级 + 子系统级健康度。"""
        cfg = self._settings()
        points: list[dict[str, Any]] = []
        for sid, keys in MONITORED_POINTS.items():
            contract = CONTRACTS[SubsystemId(sid)]
            specs = {p.key: p for p in contract.points}
            for k in keys:
                spec = specs.get(k)
                latest = self._latest.get((sid, k)) or {
                    "current": None,
                    "baseline_mean": None,
                    "baseline_std": None,
                    "z_score": None,
                    "sample_count": 0,
                    "status": "learning",
                    "score": None,
                    "violation_cycles": 0,
                }
                points.append(
                    {
                        "subsystem": sid,
                        "subsystem_name": contract.name,
                        "point": k,
                        "name": spec.label if spec else k,
                        "unit": spec.unit if spec else "",
                        **latest,
                    }
                )
        return {
            "ts": local_now().isoformat(timespec="seconds"),
            "learning_enabled": bool(cfg.get("health_learning_enabled", True)),
            "min_samples": int(cfg.get("health_min_samples", 100)),
            "points": points,
            "subsystems": self._subsystem_summary(points),
        }

    @staticmethod
    def _subsystem_summary(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for sid in MONITORED_POINTS:
            ps = [p for p in points if p["subsystem"] == sid]
            ready = [p for p in ps if p["status"] != "learning"]
            if ready:
                score = min(int(p["score"]) for p in ready)
                worst = max(
                    (p["status"] for p in ready),
                    key=lambda s: ("normal", "attention", "abnormal").index(s),
                )
                status = worst
            else:
                score, status = None, "learning"
            out.append(
                {
                    "id": sid,
                    "name": CONTRACTS[SubsystemId(sid)].name,
                    "score": score,
                    "status": status,
                    "status_cn": STATUS_CN[status],
                    "monitored_points": len(ps),
                }
            )
        return out

    def subsystem_scores(self) -> dict[str, dict[str, Any]]:
        """子系统级健康度 {sid: {score, status}}，供数字孪生快照使用。"""
        return {s["id"]: s for s in self._subsystem_summary(self.report()["points"])}

    def history_stats(self, subsystem: str, point: str, window_sec: int) -> dict[str, Any] | None:
        """内存环形缓冲上的窗口统计（NL 查询用），样本不足返回 None。"""
        buf = self._history.get((subsystem, point))
        if not buf:
            return None
        cutoff = time.time() - max(1, window_sec)
        vals = [v for ts, v in buf if ts >= cutoff]
        if not vals:
            return None
        return {
            "mean": round(sum(vals) / len(vals), 3),
            "max": round(max(vals), 3),
            "min": round(min(vals), 3),
            "count": len(vals),
        }

    # ---------- 告警联动 ----------

    def collect_alerts(self) -> list[dict[str, Any]]:
        """产出当前仍处于持续越限的"健康偏差"告警（并入 AI 巡检去重体系）。"""
        now = local_now().isoformat(timespec="seconds")
        out: list[dict[str, Any]] = []
        for (sid, k), cycles in self._violations.items():
            if cycles < ALERT_CYCLES:
                continue
            latest = self._latest.get((sid, k))
            if not latest or latest["status"] != "abnormal":
                continue
            contract = CONTRACTS[SubsystemId(sid)]
            spec = next((p for p in contract.points if p.key == k), None)
            name = spec.label if spec else k
            unit = spec.unit if spec else ""
            z = float(latest["z_score"])
            severity = "alarm" if abs(z) >= Z_ALARM else "warning"
            out.append(
                {
                    "id": uuid.uuid4().hex[:12],
                    "level": severity,  # 兼容旧字段
                    "severity": severity,
                    "dedupe_key": f"{sid}:health_deviation:{k}",
                    "subsystem_id": sid,
                    "subsystem_name": contract.name,
                    "message": (
                        f"健康偏差：{name} 当前 {latest['current']}{unit}，"
                        f"基线 {latest['baseline_mean']}±{latest['baseline_std']}，"
                        f"z={z:.1f} 已持续 {cycles} 个评估周期"
                    ),
                    "ts": now,
                    "source": "健康基线",
                    "active": True,
                    "count": 1,
                }
            )
        return out

    # ---------- 维护 ----------

    async def persist(self) -> None:
        rows = [
            {
                "subsystem": sid,
                "point": k,
                "baseline_mean": b.mean,
                "baseline_std": b.std,
                "sample_count": b.count,
                "updated_at": local_now().isoformat(timespec="seconds"),
            }
            for (sid, k), b in self._baselines.items()
        ]
        try:
            await store.save_health_baselines(rows)
            self._last_persist = time.monotonic()
        except Exception:  # noqa: BLE001
            logger.exception("健康基线落库失败")

    async def reset(self, subsystem: str) -> int:
        """重置某子系统全部基线（内存 + 落库记录），返回删除的持久化条数。"""
        for key in [k for k in self._baselines if k[0] == subsystem]:
            self._baselines.pop(key, None)
            self._violations.pop(key, None)
            self._latest.pop(key, None)
        removed = await store.delete_health_baselines(subsystem)
        logger.info("健康基线重置: %s（删除持久化记录 %d 条）", subsystem, removed)
        return removed


health = HealthService()
