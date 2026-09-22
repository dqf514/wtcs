# -*- coding: utf-8 -*-
"""第三阶段冒烟：健康基线 / NL 语义层 / 开放接口 / MQTT 降级 / twin 快照去假。

前置：uvicorn app.main:app --port 8001 已启动。
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8001/api"


def req(method, path, body=None, token=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        sys.exit(1)


def cmd(token, sid, command, params=None):
    """下发指令，自动处理二次确认令牌。"""
    body = {"subsystem_id": sid, "command": command, "params": params or {}}
    st, r = req("POST", "/commands", body, token)
    if st == 200 and not r.get("ok") and "confirm_token" in str(r.get("message", "")):
        tk = r["message"].split("confirm_token 重发:")[-1].strip()
        body["confirm_token"] = tk
        st, r = req("POST", "/commands", body, token)
    return st, r


_, login = req("POST", "/auth/login", {"username": "operator", "password": "wtcs123"})
op = login["access_token"]
_, mlogin = req("POST", "/auth/login", {"username": "maintainer", "password": "wtcs123"})
mt = mlogin["access_token"]
print("登录 ok")

MONITORED = ["main_fan", "cooling_water", "rrs", "boundary_layer", "purge_air", "compressed_air", "acoustic"]

# 0. 加快冷启动：min_samples=5，评估周期 1s
st, s = req("PUT", "/settings", {"health_min_samples": 5, "health_eval_interval_sec": 1}, mt)
check("PUT 健康基线设置", st == 200 and s.get("health_min_samples") == 5, f"st={st}")

# 1. 重置全部受监控子系统基线（验证 reset + 进入 learning）
st, r = req("POST", "/twin/health/main_fan/reset", None, op)
check("operator 重置基线 → 403", st == 403, f"st={st}")
for sid in MONITORED:
    st, r = req("POST", f"/twin/health/{sid}/reset", None, mt)
    check(f"重置基线 {sid}", st == 200 and r.get("ok"), f"st={st}")
st, r = req("POST", "/twin/health/traverse/reset", None, mt)
check("无监控测点子系统重置 → 404", st == 404, f"st={st}")

st, h = req("GET", "/twin/health", token=op)
check("twin/health 结构", st == 200 and len(h["points"]) == 20 and len(h["subsystems"]) == 7)
st0 = {p["status"] for p in h["points"]}
check("重置后全部 learning", st0 == {"learning"}, f"statuses={st0}")

# 2. 等待学习完成（5 样本 @1s）
t0 = time.time()
while time.time() - t0 < 40:
    time.sleep(2)
    st, h = req("GET", "/twin/health", token=op)
    fan = next(p for p in h["points"] if p["subsystem"] == "main_fan" and p["point"] == "wind_speed")
    if fan["status"] != "learning":
        break
check("基线学习完成 → normal", fan["status"] == "normal", f"status={fan['status']} z={fan['z_score']} n={fan['sample_count']}")
check("健康度评分 0-100", 0 <= fan["score"] <= 100, f"score={fan['score']}")

# 3. 开放接口
st, p = req("GET", "/open/points", token=op)
check("open/points 全量元数据", st == 200 and p["count"] >= 60 and p["points"][0]["aliases"], f"count={p.get('count')}")
check("元数据不含控制面字段", "commands" not in p["points"][0] and "min_role" not in p["points"][0])
st, lat = req("GET", "/open/latest", token=op)
ws = next((x for x in lat["points"] if x["subsystem"] == "main_fan" and x["point"] == "wind_speed"), None)
check("open/latest 当前值快照", st == 200 and lat["count"] >= 60 and ws is not None and isinstance(ws["value"], (int, float)),
      f"count={lat.get('count')} wind={ws and ws['value']}")

# 4. NL 语义层
def ask(q):
    st, r = req("POST", "/ai/ask", {"question": q}, op)
    assert st == 200, f"ask 失败: {st} {r}"
    return r

r = ask("当前风速多少")
check("NL 当前值", "m/s" in r["answer"] and r["sources"] and r["sources"][0]["point"] == "wind_speed",
      f"answer={r['answer'][:60]}")
r = ask("最近10分钟平均风速")
check("NL 统计带 sources", "平均" in r["answer"] and r["sources"][0]["sample_count"] >= 3
      and "最近10分钟" in r["sources"][0]["time_range"], f"answer={r['answer'][:80]}")
r = ask("天平正常吗")
check("NL 状态（天平）", ("天平" in r["answer"] or "滚动路面" in r["answer"]) and ("健康度" in r["answer"] or "学习中" in r["answer"]),
      f"answer={r['answer'][:80]}")
r = ask("供水温度和回水温度哪个高")
check("NL 比较", "低于" in r["answer"] or "高于" in r["answer"], f"answer={r['answer'][:80]}")
check("NL 比较双 sources", len(r["sources"]) == 2)
r = ask("火星车速度多少")
check("NL 兜底提示", "暂未覆盖" in r["answer"] and "示例" in r["answer"], f"answer={r['answer'][:60]}")

# 5. 制造偏差：大风速 → 健康偏差告警（持续越限 3 周期 + AI 巡检同步）
st, r = cmd(op, "main_fan", "set_speed", {"target_speed": 120})
check("设定风速 120", st == 200 and r.get("ok"), f"{r.get('message')}")
st, r = cmd(op, "main_fan", "start")
check("启动主风机", st == 200 and r.get("ok"))

t0 = time.time()
abnormal = None
while time.time() - t0 < 40:
    time.sleep(2)
    st, h = req("GET", "/twin/health", token=op)
    abnormal = [p for p in h["points"] if p["status"] == "abnormal"]
    if abnormal:
        break
check("偏差测点进入 abnormal", bool(abnormal),
      f"e.g. {abnormal[0]['subsystem']}.{abnormal[0]['point']} z={abnormal[0]['z_score']}" if abnormal else "无")

t0 = time.time()
hal = []
while time.time() - t0 < 60:
    time.sleep(4)
    st, alerts = req("GET", "/ai/alerts?active=true&limit=100", token=op)
    hal = [a for a in alerts if ":health_deviation:" in a.get("dedupe_key", "")]
    if hal:
        break
check("健康偏差告警产生", bool(hal), f"n={len(hal)}")
dk = hal[0]["dedupe_key"]
n1 = sum(1 for a in hal if a["dedupe_key"] == dk)
c1 = hal[0]["count"]
time.sleep(10)
st, alerts2 = req("GET", "/ai/alerts?active=true&limit=100", token=op)
hal2 = [a for a in alerts2 if a.get("dedupe_key") == dk]
check("告警去重（同 dedupe_key 仅 1 条）", n1 == 1 and len(hal2) == 1, f"{dk} n1={n1} n2={len(hal2)}")
check("告警 count 累加不重复插入", hal2 and hal2[0]["count"] > c1, f"count {c1}→{hal2[0]['count'] if hal2 else '?'}")

# 6. twin 快照去假
st, tw = req("GET", "/twin", token=op)
h0 = tw["health"][0]
check("twin 健康度为真实评分", isinstance(h0["score"], int) and "health_status" in h0, f"{h0}")
cam_fan = next(c for c in tw["cameras"] if c["id"] == "cam_fan")
check("twin 摄像头推导", isinstance(cam_fan["online"], bool) and isinstance(cam_fan["temp_max"], (int, float)),
      f"online={cam_fan['online']} temp={cam_fan['temp_max']}")
check("twin 几何参数集中", tw["model"]["tunnel_length_m"] == 48 and "test_section" in tw["model"])

# 7. MQTT 降级：未安装 paho 时开启不崩溃
st, s = req("PUT", "/settings", {"mqtt_enabled": True}, mt)
check("开启 mqtt_enabled", st == 200 and s.get("mqtt_enabled") is True and s.get("mqtt_available") is False,
      f"mqtt_available={s.get('mqtt_available')}")
time.sleep(3)
st, hh = req("GET", "/health")
check("MQTT 降级下服务正常", st == 200 and hh["status"] == "ok")
st, lat2 = req("GET", "/open/latest", token=op)
check("MQTT 降级下接口正常", st == 200 and lat2["count"] >= 60)
st, s = req("PUT", "/settings", {"mqtt_enabled": False}, mt)
check("关闭 mqtt_enabled", st == 200)

# 8. 收尾：停风机 + 恢复默认设置
cmd(op, "main_fan", "set_speed", {"target_speed": 0})
cmd(op, "main_fan", "stop")
st, s = req("PUT", "/settings", {"health_min_samples": 100, "health_eval_interval_sec": 2}, mt)
check("恢复默认健康设置", st == 200 and s.get("health_min_samples") == 100)

print("\n第三阶段冒烟全部通过")
