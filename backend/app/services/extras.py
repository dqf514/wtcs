"""报告生成、AI 巡检、自然语言查询、数字孪生状态、run 统计摘要。"""

from __future__ import annotations

import html as html_mod
import logging
import re
import uuid
from typing import Any

import numpy as np

from app.adapters.registry import registry
from app.contracts.semantics import match_points, match_subsystems
from app.core.config import settings
from app.models.schemas import SafetyLevel, SubsystemId, local_now
from app.services.health import STATUS_CN, health
from app.services.store import store

logger = logging.getLogger(__name__)

# 通道组中文名与单位（报告/摘要展示用）
CHANNEL_GROUPS: dict[str, tuple[str, str]] = {
    "balance": ("天平六分量", "N / N·m"),
    "pressure": ("压力扫描", "Pa"),
    "acoustic": ("声学", "dB"),
    "env": ("环境", ""),
}


def compute_run_summary(run: dict[str, Any], samples: list[dict[str, Any]]) -> dict[str, Any]:
    """run 统计摘要：各通道 均值/最大/最小/标准差，并按标准公式换算 Cd/Cl。

    Cd = mean(Fx) / (q·A)，Cl = mean(Fz) / (q·A)，
    动压 q = ½ρV²（ρ=1.225），V 取 env 通道实测风速均值（缺省回退快照工况值），
    参考面积 A 取配置快照 reference_area。
    """
    series: dict[str, dict[str, list[float]]] = {}
    for s in samples:
        for group, chans in (s.get("channels") or {}).items():
            if not isinstance(chans, dict):
                continue
            g = series.setdefault(group, {})
            for k, v in chans.items():
                if isinstance(v, (int, float)):
                    g.setdefault(k, []).append(float(v))

    stats: dict[str, Any] = {}
    for group, chans in series.items():
        gstats: dict[str, Any] = {}
        for k, vals in chans.items():
            arr = np.asarray(vals, dtype=float)
            gstats[k] = {
                "mean": round(float(arr.mean()), 4),
                "max": round(float(arr.max()), 4),
                "min": round(float(arr.min()), 4),
                "std": round(float(arr.std()), 4),
                "count": int(arr.size),
            }
        stats[group] = gstats

    coefficients: dict[str, Any] = {}
    config = run.get("config") or {}
    balance = stats.get("balance") or {}
    fx = balance.get("fx")
    fz = balance.get("fz")
    if fx and fz:
        env = stats.get("env") or {}
        wind = (env.get("wind_speed") or {}).get("mean") or float(config.get("wind_speed") or 0.0)
        area = float(config.get("reference_area") or 2.0)
        q = 0.5 * 1.225 * wind * wind
        if q > 0 and area > 0:
            coefficients = {
                "Cd": round(fx["mean"] / (q * area), 4),
                "Cl": round(fz["mean"] / (q * area), 4),
                "dynamic_pressure_Pa": round(q, 2),
                "reference_area_m2": area,
                "wind_speed_used": round(wind, 3),
                "air_density": 1.225,
                "formula": "Cd=mean(Fx)/(q·A), Cl=mean(Fz)/(q·A), q=½ρV²",
            }
    return {
        "run_id": run.get("id"),
        "status": run.get("status"),
        "sample_count": len(samples),
        "config_hash": run.get("config_hash", ""),
        "stats": stats,
        "coefficients": coefficients,
    }


def _esc(text: Any) -> str:
    return html_mod.escape(str(text))


def _svg_line_chart(
    series: list[dict[str, Any]],
    *,
    title: str,
    width: int = 640,
    height: int = 220,
) -> str:
    """手写 SVG 折线图（零依赖）。series: [{label, color, points: [(t, v), ...]}]。"""
    all_pts = [p for s in series for p in s["points"]]
    if not all_pts:
        return ""
    pad_l, pad_r, pad_t, pad_b = 56, 12, 24, 28
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    t_min = min(p[0] for p in all_pts)
    t_max = max(p[0] for p in all_pts)
    v_min = min(p[1] for p in all_pts)
    v_max = max(p[1] for p in all_pts)
    if t_max <= t_min:
        t_max = t_min + 1.0
    if v_max <= v_min:
        v_max = v_min + 1.0
    v_pad = (v_max - v_min) * 0.08
    v_min -= v_pad
    v_max += v_pad

    def px(t: float) -> float:
        return pad_l + (t - t_min) / (t_max - t_min) * plot_w

    def py(v: float) -> float:
        return pad_t + plot_h - (v - v_min) / (v_max - v_min) * plot_h

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" style="background:#fafbfc;border:1px solid #ddd">',
        f'<text x="{pad_l}" y="16" font-size="13" font-weight="bold">{_esc(title)}</text>',
    ]
    # 网格与纵轴刻度
    for i in range(5):
        v = v_min + (v_max - v_min) * i / 4
        y = py(v)
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width - pad_r}" y2="{y:.1f}" stroke="#e5e7eb"/>')
        parts.append(f'<text x="{pad_l - 6}" y="{y + 4:.1f}" font-size="10" text-anchor="end" fill="#666">{v:.1f}</text>')
    for i in range(6):
        t = t_min + (t_max - t_min) * i / 5
        x = px(t)
        parts.append(f'<text x="{x:.1f}" y="{height - 8}" font-size="10" text-anchor="middle" fill="#666">{t:.1f}s</text>')
    parts.append(
        f'<rect x="{pad_l}" y="{pad_t}" width="{plot_w}" height="{plot_h}" fill="none" stroke="#999"/>'
    )
    # 折线与图例
    lx = pad_l + 8
    for s in series:
        pts = " ".join(f"{px(t):.1f},{py(v):.1f}" for t, v in s["points"])
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{s["color"]}" stroke-width="1.4"/>')
        parts.append(f'<rect x="{lx}" y="8" width="10" height="10" fill="{s["color"]}"/>')
        parts.append(f'<text x="{lx + 14}" y="17" font-size="11">{_esc(s["label"])}</text>')
        lx += 14 + 9 * len(str(s["label"])) + 24
    parts.append("</svg>")
    return "".join(parts)


def _series_from_samples(
    samples: list[dict[str, Any]], group: str, keys: list[tuple[str, str, str]], max_points: int = 200
) -> list[dict[str, Any]]:
    """从采样中抽取若干条 (t, v) 序列，超量降采样。keys: [(通道名, 图例, 颜色)]。"""
    stride = max(1, len(samples) // max_points + (1 if len(samples) % max_points else 0))
    picked = samples[::stride]
    out = []
    for key, label, color in keys:
        pts = [
            (float(s["t"]), float(s["channels"][group][key]))
            for s in picked
            if isinstance((s.get("channels") or {}).get(group), dict)
            and isinstance(s["channels"][group].get(key), (int, float))
        ]
        out.append({"label": label, "color": color, "points": pts})
    return [s for s in out if s["points"]]


def _config_snapshot_table(config: dict[str, Any]) -> str:
    rows = []
    traverse = config.get("traverse") or {}
    items = [
        ("风速", f"{config.get('wind_speed')} m/s"),
        ("温度", f"{config.get('temperature')} ℃"),
        ("偏航角", f"{config.get('yaw_angle')} °"),
        ("路面速度", f"{config.get('belt_speed')} m/s"),
        ("移测架位置", f"({traverse.get('x')}, {traverse.get('y')}, {traverse.get('z')}) mm"),
        ("场景", config.get("scenario")),
        ("采集时长", f"{config.get('duration_sec')} s"),
        ("参考面积", f"{config.get('reference_area')} m²"),
    ]
    settings_snap = config.get("settings") or {}
    if settings_snap:
        items.append(("关联设置", ", ".join(f"{k}={v}" for k, v in settings_snap.items())))
    for k, v in items:
        rows.append(f"<tr><th>{_esc(k)}</th><td>{_esc(v)}</td></tr>")
    return f'<table class="kv"><tbody>{"".join(rows)}</tbody></table>'


def _summary_table(summary: dict[str, Any]) -> str:
    rows = []
    for group, gstats in (summary.get("stats") or {}).items():
        gname, unit = CHANNEL_GROUPS.get(group, (group, ""))
        for ch, st in gstats.items():
            rows.append(
                f"<tr><td>{_esc(gname)}</td><td>{_esc(ch)}</td><td>{_esc(unit)}</td>"
                f"<td>{st['mean']}</td><td>{st['max']}</td><td>{st['min']}</td>"
                f"<td>{st['std']}</td><td>{st['count']}</td></tr>"
            )
    coef = summary.get("coefficients") or {}
    coef_html = ""
    if coef:
        coef_html = (
            f'<p class="meta">气动力系数：Cd={coef["Cd"]}，Cl={coef["Cl"]}'
            f'（q={coef["dynamic_pressure_Pa"]} Pa，A={coef["reference_area_m2"]} m²，'
            f'V={coef["wind_speed_used"]} m/s）</p>'
        )
    return (
        '<table><thead><tr><th>通道组</th><th>通道</th><th>单位</th>'
        "<th>均值</th><th>最大</th><th>最小</th><th>标准差</th><th>样本数</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>{coef_html}"
    )


async def build_report_html(
    *,
    title: str,
    experiment: dict[str, Any] | None,
    overview: dict[str, Any],
    subsystems: list[dict[str, Any]],
    user: str,
    runs_data: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    rid = uuid.uuid4().hex[:10]
    now = local_now().strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for s in subsystems:
        fault = "故障" if s.get("fault") else ("就绪" if s.get("ready") else s.get("state", ""))
        rows.append(
            f"<tr><td>{_esc(s.get('name'))}</td><td>{'仿真' if s.get('mode')=='simulation' else '真机'}</td>"
            f"<td>{_esc(s.get('state'))}</td><td>{_esc(fault)}</td></tr>"
        )
    exp_block = ""
    if experiment:
        exp_block = f"""
        <h2>实验信息</h2>
        <ul>
          <li>编号：{_esc(experiment.get('id'))}</li>
          <li>标题：{_esc(experiment.get('title'))}</li>
          <li>场景：{_esc(experiment.get('scenario'))}</li>
          <li>风速：{_esc(experiment.get('wind_speed'))} m/s</li>
          <li>温度：{_esc(experiment.get('temperature'))} ℃</li>
          <li>偏航：{_esc(experiment.get('yaw_angle'))} °</li>
          <li>阶段：{_esc(experiment.get('phase'))}</li>
        </ul>
        """

    # ---- 实验数据：runs 列表 + 每 run 摘要/快照/图表 ----
    runs_block = ""
    repro_hashes: list[str] = []
    if runs_data:
        list_rows = []
        detail_blocks = []
        for item in runs_data:
            run = item["run"]
            summary = item["summary"]
            samples = item.get("samples") or []
            cfg = run.get("config") or {}
            ch_hash = run.get("config_hash") or ""
            if ch_hash:
                repro_hashes.append(f"{run['id']}:{ch_hash}")
            list_rows.append(
                f"<tr><td>{_esc(run['id'])}</td><td>{_esc(run.get('status'))}</td>"
                f"<td>{_esc(run.get('started_at') or '')}</td><td>{_esc(run.get('ended_at') or '')}</td>"
                f"<td>{_esc(cfg.get('wind_speed'))}</td><td>{_esc(cfg.get('yaw_angle'))}</td>"
                f"<td>{_esc(summary.get('sample_count', 0))}</td><td>{_esc(run.get('operator') or '')}</td></tr>"
            )
            balance_chart = _svg_line_chart(
                _series_from_samples(
                    samples,
                    "balance",
                    [("fx", "Fx (N)", "#d62728"), ("fz", "Fz (N)", "#1f77b4")],
                ),
                title=f"天平时序 — run {run['id']}",
            )
            env_chart = _svg_line_chart(
                _series_from_samples(
                    samples,
                    "env",
                    [("wind_speed", "风速 (m/s)", "#2ca02c"), ("temperature", "温度 (℃)", "#ff7f0e")],
                ),
                title=f"风速/温度趋势 — run {run['id']}",
            )
            detail_blocks.append(
                f"<h3>Run {_esc(run['id'])}（{_esc(run.get('status'))}，快照哈希 {_esc(ch_hash)}）</h3>"
                f"<h4>配置快照</h4>{_config_snapshot_table(cfg)}"
                f"<h4>统计摘要</h4>{_summary_table(summary)}"
                f"{balance_chart}{env_chart}"
            )
        runs_block = f"""
        <h2>实验数据（采集 Runs）</h2>
        <table><thead><tr><th>Run ID</th><th>状态</th><th>开始</th><th>结束</th>
        <th>风速(m/s)</th><th>偏航(°)</th><th>样本数</th><th>操作者</th></tr></thead>
        <tbody>{''.join(list_rows)}</tbody></table>
        {''.join(detail_blocks)}
        """

    repro_block = ""
    if repro_hashes:
        repro_block = (
            "<p class=\"meta\">数据可复现声明：本报告数据均关联采集 run 的配置快照，"
            "快照哈希（SHA-256 前16位）：" + _esc("；".join(repro_hashes)) + "。"
            "凭快照中的工况参数与关联设置可唯一复现对应采集过程。</p>"
        )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>{_esc(title)}</title>
<style>
body{{font-family:"Noto Sans SC","Microsoft YaHei",Ubuntu,sans-serif;margin:32px;color:#111}}
h1{{font-size:22px}} table{{border-collapse:collapse;width:100%;margin-top:12px}}
th,td{{border:1px solid #ddd;padding:8px;text-align:left}} th{{background:#f5f7fb}}
table.kv th{{width:160px}}
.meta{{color:#555;font-size:13px}}
svg{{margin:8px 0;display:block}}
</style></head><body>
<h1>{_esc(title)}</h1>
<p class="meta">版本：{_esc(settings.app_version)} · 生成时间：{now}（本地时间） · 操作者：{_esc(user)} · 系统：合肥汽车风洞 WTCS</p>
{repro_block}
<h2>运行概览</h2>
<ul>
  <li>风速：{overview.get('wind_speed')} m/s</li>
  <li>温度：{overview.get('temperature')} ℃</li>
  <li>安全状态：{overview.get('safety')}</li>
  <li>实验阶段：{overview.get('experiment_phase')}</li>
  <li>仿真/真机：{overview.get('simulation_count')}/{overview.get('real_count')}</li>
</ul>
{exp_block}
{runs_block}
<h2>子系统状态</h2>
<table><thead><tr><th>名称</th><th>模式</th><th>连接</th><th>状态</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
<p class="meta">本报告由 WTCS 自动生成，建设期数据来自仿真适配器。</p>
</body></html>"""
    report = {
        "id": rid,
        "experiment_id": experiment.get("id") if experiment else None,
        "title": title,
        "html": html,
        "created_at": local_now().isoformat(timespec="seconds"),
        "created_by": user,
    }
    await store.save_report(report)
    logger.info("生成报告: %s（%s，runs=%d）", report["title"], rid, len(runs_data or []))
    return report


async def run_ai_inspection(safety: SafetyLevel, overview_wind: float) -> list[dict[str, Any]]:
    """基于阈值与说明书规则的巡检（建设期规则引擎，可替换为大模型）。

    每条规则产出带 dedupe_key 的分级告警，由 store.sync_ai_alerts 做去重与恢复关闭。
    """
    alerts: list[dict[str, Any]] = []
    now = local_now().isoformat(timespec="seconds")

    for ad in registry.all():
        try:
            st = await ad.read_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("巡检读取子系统 %s 失败: %s", ad.subsystem_id.value, exc)
            alerts.append(
                _alert("critical", ad.subsystem_id.value, ad.contract.name,
                       f"读取失败: {exc}", now, "read_failure")
            )
            continue
        vals = {p.key: p.value for p in st.points}
        if st.local_debug:
            alerts.append(
                _alert("warning", st.id.value, st.name, "子系统处于本地调试/接管模式", now, "local_debug")
            )
        if st.fault or vals.get("fault") or vals.get("e_stop"):
            alerts.append(
                _alert("critical", st.id.value, st.name, st.fault_message or "故障或急停触发", now, "fault")
            )
        if st.id == SubsystemId.main_fan:
            speed = float(vals.get("wind_speed") or 0)
            target = float(vals.get("target_speed") or 0)
            if target > 0 and abs(speed - target) > max(5.0, target * 0.25) and speed < target * 0.5:
                alerts.append(
                    _alert("warning", st.id.value, st.name,
                           f"风速跟随偏慢：当前{speed:.1f}/目标{target:.1f}", now, "wind_follow")
                )
            if speed > 220:
                alerts.append(_alert("critical", st.id.value, st.name, f"风速严重超限：{speed:.1f} m/s", now, "wind_high"))
            elif speed > 200:
                alerts.append(_alert("alarm", st.id.value, st.name, f"风速超限：{speed:.1f} m/s", now, "wind_high"))
        if st.id == SubsystemId.cooling_water and vals.get("running"):
            supply = float(vals.get("supply_temp") or 0)
            if supply > 18:
                alerts.append(_alert("critical", st.id.value, st.name, f"供水温度严重偏高：{supply:.1f} ℃", now, "supply_temp_high"))
            elif supply > 14:
                alerts.append(_alert("warning", st.id.value, st.name, f"供水温度偏高：{supply:.1f} ℃", now, "supply_temp_high"))
        if st.id == SubsystemId.compressed_air and vals.get("running"):
            pressure = float(vals.get("pressure") or 0)
            if pressure < 12:
                alerts.append(_alert("alarm", st.id.value, st.name, f"压缩空气压力过低：{pressure:.1f} bar", now, "pressure_low"))
            elif pressure < 16:
                alerts.append(_alert("warning", st.id.value, st.name, f"压缩空气压力偏低：{pressure:.1f} bar", now, "pressure_low"))
        if st.id == SubsystemId.boundary_layer and overview_wind > 10:
            if not vals.get("running"):
                alerts.append(
                    _alert("info", st.id.value, st.name, "有风工况下抽吸未运行，请确认是否需要启动", now, "suction_idle")
                )

    if safety in (SafetyLevel.e_stop, SafetyLevel.safe_stop, SafetyLevel.alarm):
        severity = "critical" if safety == SafetyLevel.e_stop else "alarm"
        alerts.append(_alert(severity, "safety", "安全连锁", f"全局安全状态：{safety.value}", now, "safety_state"))

    # 健康基线偏差告警并入同一去重体系（dedupe_key: <sid>:health_deviation:<point>）
    try:
        alerts.extend(health.collect_alerts())
    except Exception:  # noqa: BLE001
        logger.exception("健康偏差告警收集失败")

    try:
        await store.sync_ai_alerts(alerts)
    except Exception:  # noqa: BLE001
        logger.exception("巡检告警写入数据库失败")
    if alerts:
        logger.info("AI 巡检发现 %d 条告警: %s", len(alerts),
                    ", ".join(f"[{a['severity']}]{a['subsystem_name']}" for a in alerts))
    return alerts


def _alert(severity: str, sid: str, name: str, message: str, ts: str, rule: str) -> dict[str, Any]:
    return {
        "id": uuid.uuid4().hex[:12],
        "level": severity,  # 兼容旧字段
        "severity": severity,
        "dedupe_key": f"{sid}:{rule}",
        "subsystem_id": sid,
        "subsystem_name": name,
        "message": message,
        "ts": ts,
        "source": "规则巡检",
        "active": True,
        "count": 1,
    }


# NL 支持问法示例（兜底回答与前端提示共用）
NL_EXAMPLES = [
    "当前风速多少",
    "最近10分钟平均风速",
    "最近1小时供水温度最大多少",
    "供水温度和回水温度哪个高",
    "天平正常吗",
    "现在有没有报警",
]

_STATUS_WORDS = ("正常吗", "正常么", "有没有报警", "有报警", "报警了吗", "健康", "状态怎么样", "状态如何", "异常吗", "还好吗", "有问题")
_COMPARE_WORDS = ("哪个高", "哪个大", "哪个低", "哪个小", "谁高", "谁大", "谁低", "比较")
_STATS_WORDS = ("平均", "均值", "最大", "最小", "峰值", "波动")


def _parse_window_sec(q: str) -> int:
    """解析常见时间窗表达：最近N分钟/小时/秒、半小时、一小时、今天；默认 10 分钟。"""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:个)?\s*(小时|分钟|分|秒)", q)
    if m:
        n = float(m.group(1))
        unit = m.group(2)
        mult = 3600 if unit == "小时" else (60 if unit in ("分钟", "分") else 1)
        return max(1, int(n * mult))
    if "半小时" in q:
        return 1800
    if "一小时" in q:
        return 3600
    if "今天" in q:
        now = local_now()
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return max(1, int((now - midnight).total_seconds()))
    return 600


def _human_window(sec: int) -> str:
    if sec >= 3600 and sec % 3600 == 0:
        return f"{sec // 3600}小时"
    if sec >= 60 and sec % 60 == 0:
        return f"{sec // 60}分钟"
    return f"{sec}秒"


async def _nl_status_answer(
    sid: str | None,
    sub_by_id: dict[str, dict[str, Any]],
    sources: list[dict[str, Any]],
) -> tuple[str, Any]:
    """状态类问题：子系统连接/故障 + 健康基线评分 + 活动告警。"""
    if sid is None:
        alerts = await store.list_ai_alerts(20, active=True)
        if alerts:
            answer = f"当前全系统活动告警 {len(alerts)} 条：" + "；".join(
                f"[{a['severity']}]{a['subsystem_name']} {a['message']}" for a in alerts[:5]
            )
        else:
            answer = "当前全系统无活动告警，各子系统运行正常。"
        return answer, {"active_alerts": len(alerts)}

    s = sub_by_id.get(sid)
    name = s["name"] if s else sid
    parts: list[str] = []
    if s:
        parts.append(f"连接状态「{s.get('state')}」")
        parts.append("存在故障标志" if s.get("fault") else "无故障标志")
    rep = health.report()
    hs = next((x for x in rep["subsystems"] if x["id"] == sid), None)
    if hs is not None:
        if hs.get("score") is not None:
            parts.append(f"健康度 {hs['score']}/100（{hs['status_cn']}）")
        else:
            parts.append("健康基线学习中，暂无评分")
        abnormal = [p for p in rep["points"] if p["subsystem"] == sid and p["status"] == "abnormal"]
        if abnormal:
            parts.append("异常测点：" + "、".join(f"{p['name']}(z={p['z_score']})" for p in abnormal))
    alerts = [a for a in await store.list_ai_alerts(50, active=True) if a.get("subsystem_id") == sid]
    if alerts:
        parts.append(f"活动告警 {len(alerts)} 条：" + "；".join(a["message"] for a in alerts[:3]))
    else:
        parts.append("无活动告警")
    sources.append(
        {"point": None, "point_name": None, "subsystem": sid, "subsystem_name": name,
         "time_range": "当前", "sample_count": 0}
    )
    return f"{name}：" + "，".join(parts) + "。", {"subsystem": sid, "active_alerts": len(alerts)}


def _fmt_num(v: Any) -> str:
    """数值友好格式化：避免 7e-323 这类科学计数法直接进回答文本。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v)
    if abs(v) < 1e-6:
        return "0"
    if abs(v) >= 1000:
        return f"{v:,.0f}"
    return f"{v:.2f}".rstrip("0").rstrip(".")


async def nl_query(question: str, overview: dict[str, Any], subsystems: list[dict[str, Any]]) -> dict[str, Any]:
    """只读自然语言查询：语义层解析 + 可溯源回答（建设期规则引擎，可替换为 LLM）。

    支持四类问法：当前值 / 时间窗统计 / 两测点比较 / 状态与健康；
    回答附 sources（测点、子系统、时间窗、样本数）便于溯源。
    """
    q = question.strip()
    ql = q.lower()
    sources: list[dict[str, Any]] = []
    pts = match_points(q)
    subs = match_subsystems(q)

    cur: dict[tuple[str, str], Any] = {}
    sub_by_id: dict[str, dict[str, Any]] = {}
    for s in subsystems:
        sub_by_id[s["id"]] = s
        for p in s.get("points", []):
            cur[(s["id"], p["key"])] = p["value"]

    def src(e: dict[str, Any], time_range: str, sample_count: int) -> dict[str, Any]:
        return {
            "point": e["point"],
            "point_name": e["name"],
            "subsystem": e["subsystem"],
            "subsystem_name": e["subsystem_name"],
            "time_range": time_range,
            "sample_count": sample_count,
        }

    def result(answer: str, data: Any) -> dict[str, Any]:
        return {
            "question": question,
            "answer": answer,
            "data": data,
            "sources": sources,
            "ts": local_now().isoformat(timespec="seconds"),
            "readonly": True,
        }

    is_compare = any(w in q for w in _COMPARE_WORDS)
    stat_word = next((w for w in _STATS_WORDS if w in q), None)
    is_status = any(w in q for w in _STATUS_WORDS) or ("报警" in q and not pts and not stat_word)

    # 1. 比较：XX 和 YY 哪个高
    if is_compare and len(pts) >= 2:
        a, b = pts[0], pts[1]
        va, vb = cur.get((a["subsystem"], a["point"])), cur.get((b["subsystem"], b["point"]))
        sources.extend([src(a, "当前", 1), src(b, "当前", 1)])
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            relation = "高于" if va > vb else ("低于" if va < vb else "等于")
            return result(
                f"{a['subsystem_name']}·{a['name']} 当前 {_fmt_num(va)}{a['unit']}，"
                f"{b['subsystem_name']}·{b['name']} 当前 {_fmt_num(vb)}{b['unit']}：前者{relation}后者。",
                {"a": {"point": a["point"], "value": va}, "b": {"point": b["point"], "value": vb}},
            )
        return result("两个测点的当前值不全为数值，无法比较。", None)

    # 2. 状态：XX 正常吗 / 有没有报警
    if is_status:
        sid = subs[0] if subs else (pts[0]["subsystem"] if pts else None)
        answer, data = await _nl_status_answer(sid, sub_by_id, sources)
        return result(answer, data)

    # 3. 统计：最近 N 分钟/小时 XX 的平均/最大/最小
    if stat_word and pts:
        e = pts[0]
        window = _parse_window_sec(q)
        stats = health.history_stats(e["subsystem"], e["point"], window)
        wtxt = _human_window(window)
        sources.append(src(e, f"最近{wtxt}", stats["count"] if stats else 0))
        if stats:
            return result(
                f"{e['subsystem_name']}·{e['name']}：最近{wtxt} 平均 {_fmt_num(stats['mean'])}{e['unit']}，"
                f"最大 {_fmt_num(stats['max'])}，最小 {_fmt_num(stats['min'])}（样本 {stats['count']} 个）。",
                stats,
            )
        return result(
            f"暂无「{e['name']}」最近{wtxt}的历史样本"
            "（统计基于健康基线服务的低频历史缓冲，服务刚启动时需等一会再查）。",
            None,
        )

    # 4. 当前值：XX 现在多少
    if pts:
        parts = []
        for e in pts[:3]:
            v = cur.get((e["subsystem"], e["point"]))
            if v is None:
                parts.append(f"{e['subsystem_name']}·{e['name']} 当前无读数")
            else:
                parts.append(f"{e['subsystem_name']}·{e['name']} 当前为 {_fmt_num(v)}{e['unit']}")
            sources.append(src(e, "当前", 1 if v is not None else 0))
        return result("；".join(parts) + "。", {"values": [s["point"] for s in sources]})

    # 5. 非测点类问题（沿用规则分支）
    if any(k in q for k in ("安全", "急停", "连锁")):
        return result(f"当前安全状态为「{overview.get('safety')}」。", {"safety": overview.get("safety")})
    if any(k in q for k in ("故障", "异常")):
        faults = [s for s in subsystems if s.get("fault")]
        if not faults:
            answer = "当前无子系统故障标志。"
        else:
            answer = "故障子系统：" + "、".join(f"{s['name']}({s.get('fault_message') or '故障'})" for s in faults)
        return result(answer, faults)
    if any(k in q for k in ("仿真", "真机", "接入")):
        return result(
            f"仿真接入 {overview.get('simulation_count')} 套，真机接入 {overview.get('real_count')} 套，"
            f"已连接 {overview.get('connected_count')} 套。",
            None,
        )
    if "报告" in q:
        reps = (await store.list_reports())[:5]
        answer = f"最近报告 {len(reps)} 份：" + "；".join(r["title"] for r in reps) if reps else "暂无报告，可在报告页一键生成。"
        return result(answer, reps)
    if re.search(r"子系统|有哪些|列表", q):
        return result(
            "已接入子系统：" + "、".join(s["name"] for s in subsystems),
            [{"id": s["id"], "name": s["name"], "mode": s["mode"]} for s in subsystems],
        )

    answer = (
        "暂未覆盖该问法。支持问法示例："
        + "；".join(f"「{x}」" for x in NL_EXAMPLES)
        + "。"
    )
    if "openai" in ql or "gpt" in ql:
        answer += "（正式环境可接入内网大模型，本接口保持只读，不下发控制。）"
    return result(answer, None)


# 风洞几何参数（占位值）——现场标定后改配置
TWIN_GEOMETRY: dict[str, Any] = {
    "tunnel_length_m": 48,
    "test_section": {"w": 3.5, "h": 2.5, "l": 10},
    "nozzle": {"area_m2": 12.25},
}

# 孪生健康度旧启发式（健康基线学习中时的回退）
def _legacy_health_score(s: dict[str, Any]) -> int:
    if s.get("fault"):
        return 20
    if s.get("local_debug"):
        return 60
    if not s.get("ready"):
        return 70
    if s.get("state") not in ("已连接", "降级", "本地接管"):
        return 40
    return 100


def _twin_cameras(sub_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """摄像头状态从对应子系统实时数据推导（不再恒 online）。

    热红外温度说明：ICD 暂无相机/电柜直测温点，当前由主风机功率/频率仿真推算，
    现场接入热红外相机 SDK 后替换为实测值。
    """

    def online(sid: str) -> bool:
        s = sub_by_id.get(sid)
        return bool(s) and not s.get("fault") and s.get("state") in ("已连接", "降级", "本地接管")

    fan_pts = {p["key"]: p["value"] for p in (sub_by_id.get("main_fan") or {}).get("points", [])}
    power = float(fan_pts.get("power") or 0.0)
    freq = float(fan_pts.get("frequency") or 0.0)
    # 仿真功率模型偏大，推算温度限制在物理合理区间
    return [
        {"id": "cam_fan", "name": "动力变频器间", "type": "热红外",
         "online": online("main_fan"), "temp_max": round(min(95.0, 28.0 + power * 0.04), 1)},
        {"id": "cam_hv", "name": "高压开关柜", "type": "热红外",
         "online": online("main_fan"), "temp_max": round(min(90.0, 25.0 + freq * 0.15), 1)},
        {"id": "cam_test", "name": "试验段全景", "type": "可见光",
         "online": online("purge_air"), "temp_max": None},
        {"id": "cam_rrs", "name": "滚动路面区", "type": "可见光",
         "online": online("rrs"), "temp_max": None},
    ]


async def twin_snapshot(wind: float, subsystems: list[dict[str, Any]]) -> dict[str, Any]:
    """几何/数据孪生快照（建设期用参数化模型，后续替换为真实 CAD/CFD）。"""
    sub_by_id = {s["id"]: s for s in subsystems}

    def pts(sid: str) -> dict[str, Any]:
        s = sub_by_id.get(sid)
        if not s:
            return {}
        return {p["key"]: p["value"] for p in s.get("points", [])}

    rrs_p, tr_p, bl_p = pts("rrs"), pts("traverse"), pts("boundary_layer")

    # 健康度：优先用健康基线服务的真实评分（z-score 聚合），基线学习中回退旧启发式
    hsub = health.subsystem_scores()
    health_list = []
    for s in subsystems:
        hs = hsub.get(s["id"])
        if hs and hs.get("score") is not None:
            score = hs["score"]
            hstatus = hs["status"]
        else:
            score = _legacy_health_score(s)
            hstatus = (hs or {}).get("status", "learning")
        health_list.append(
            {
                "id": s["id"],
                "name": s["name"],
                "score": score,
                "state": s.get("state"),
                "health_status": hstatus,
                "health_status_cn": STATUS_CN.get(hstatus, hstatus),
            }
        )

    return {
        "phase": "几何孪生+数据联动（建设期）",
        "model": {
            **TWIN_GEOMETRY,
            "fan_rpm_proxy": round(wind * 25, 1),
        },
        "live": {
            "wind_speed": wind,
            "yaw": rrs_p.get("yaw", 0),
            "belt_speed": rrs_p.get("belt_speed", 0),
            "fx": rrs_p.get("fx", 0),
            "fy": rrs_p.get("fy", 0),
            "fz": rrs_p.get("fz", 0),
            "traverse": {"x": tr_p.get("x", 0), "y": tr_p.get("y", 0), "z": tr_p.get("z", 0)},
            "suction_flow": bl_p.get("suction_flow", 0),
        },
        "cfd_layers": [
            {"id": "streamline", "name": "流线", "ready": True},
            {"id": "section", "name": "剖面", "ready": True},
            {"id": "volume", "name": "体积风", "ready": False, "note": "预留代理模型接口"},
        ],
        # 碰撞检测为简化假设：仅确认移测架处于行程范围内即判无干涉，
        # 未做真实几何体相交计算；接入 CAD 包络模型后替换。
        "collision": {
            "ok": True,
            "message": "当前姿态无干涉（简化判定：仅校验行程范围）",
            "checked_at": local_now().isoformat(timespec="seconds"),
        },
        "health": health_list,
        "cameras": _twin_cameras(sub_by_id),
    }
