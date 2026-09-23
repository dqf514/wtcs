# -*- coding: utf-8 -*-
"""P0-5 命令全生命周期追踪冒烟：建单→回执→耗时→拒绝留痕→历史过滤→冲突检测→超时告警。"""
import json
import sqlite3
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path

BASE = "http://127.0.0.1:8000/api"
DB = Path(__file__).resolve().parent / "data" / "wtcs.db"


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


def login(username):
    _, d = req("POST", "/auth/login", {"username": username, "password": "wtcs123"})
    return d["access_token"]


operator = login("operator")
admin = login("admin")

# ---------- 建单 → 回执 → 耗时闭环 ----------
st, res = req("POST", "/commands", {"subsystem_id": "acoustic", "command": "start_acquire"}, token=operator)
check("下发 start_acquire 成功", st == 200 and res["ok"], res.get("message", ""))

st, hist = req("GET", "/commands/history?subsystem=acoustic&limit=5", token=operator)
check("历史查询 200", st == 200)
order = next((o for o in hist if o["command"] == "start_acquire"), None)
check("建单存在", order is not None)
check("状态 acked（回执闭环）", order["status"] == "acked", str(order))
check("回执消息非空", bool(order["receipt"]))
check("耗时已记录", order["duration_ms"] is not None and order["duration_ms"] >= 0)
check("操作者/角色留痕", order["operator"] == "operator" and order["role"] == "操作员")
check("params 为 JSON 对象", isinstance(order["params"], dict))
check("finished_at 已写", bool(order["finished_at"]))

st, active = req("GET", "/commands/active", token=operator)
check("进行中队列可查（仿真同步回执，通常空）", st == 200 and isinstance(active, list))

# ---------- 拒绝留痕：越权（operator 发维护员指令 reset_fault） ----------
st, res = req("POST", "/commands", {"subsystem_id": "main_fan", "command": "reset_fault"}, token=operator)
check("越权指令 403", st == 403, str(res))
st, hist = req("GET", "/commands/history?subsystem=main_fan&status=rejected&limit=10", token=operator)
rej = next((o for o in hist if o["command"] == "reset_fault" and o["operator"] == "operator"), None)
check("越权拒绝已建单 status=rejected", rej is not None, str(rej))
check("receipt 写拒绝原因", rej is not None and "权限不足" in rej["receipt"])

# ---------- 冲突检测：5 秒内互斥指令需二次确认 ----------
st, res = req("POST", "/commands", {"subsystem_id": "acoustic", "command": "stop_acquire"}, token=operator)
check("互斥指令被拦（need_confirm）", st == 200 and not res["ok"], res.get("message", ""))
check("警告消息含互斥说明", "互斥" in res["message"] and "警告" in res["message"], res["message"])
check("消息带 confirm_token", "confirm_token" in res["message"])
token = res["message"].split("重发: ").pop().strip()
st, res2 = req("POST", "/commands",
               {"subsystem_id": "acoustic", "command": "stop_acquire", "confirm_token": token}, token=operator)
check("确认后互斥指令放行", st == 200 and res2["ok"], res2.get("message", ""))
st, hist = req("GET", "/commands/history?subsystem=acoustic&status=acked&limit=5", token=operator)
check("冲突确认单也闭环 acked", any(o["command"] == "stop_acquire" for o in hist))

# 超过 5 秒窗口后不再拦截（created_at 秒级截断，多等 1.5s 余量）
time.sleep(6.5)
st, res = req("POST", "/commands", {"subsystem_id": "acoustic", "command": "start_acquire"}, token=operator)
check("窗口外互斥指令直放", st == 200 and res["ok"], res.get("message", ""))
st, res = req("POST", "/commands", {"subsystem_id": "acoustic", "command": "stop_acquire"}, token=operator)
check("复位：停止采集（窗口内对 start_acquire 互斥，需确认）", st == 200)
if not res["ok"] and "confirm_token" in res["message"]:
    token = res["message"].split("重发: ").pop().strip()
    st, res = req("POST", "/commands",
                  {"subsystem_id": "acoustic", "command": "stop_acquire", "confirm_token": token}, token=operator)
    check("复位：确认后停止采集", st == 200 and res["ok"], res.get("message", ""))

# ---------- 超时告警：库内插一条过期 accepted 单，等扫描置 timeout + 告警 ----------
stale_id = "smoke" + uuid.uuid4().hex[:6]
old_ts = (datetime.now() - timedelta(seconds=120)).isoformat(timespec="seconds")
conn = sqlite3.connect(DB)
conn.execute(
    "INSERT INTO command_orders(id, subsystem, command, params, operator, role, status, receipt, duration_ms, created_at, finished_at)"
    " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    (stale_id, "main_fan", "set_speed", "{}", "smoke", "操作员", "accepted", "", None, old_ts, None),
)
conn.commit()
conn.close()

found_alert = False
found_timeout = False
for _ in range(15):
    time.sleep(1)
    st, hist = req("GET", f"/commands/history?status=timeout&limit=20", token=operator)
    found_timeout = any(o["id"] == stale_id for o in hist)
    st, alerts = req("GET", "/ai/alerts?active=true&limit=50", token=admin)
    found_alert = any(a.get("dedupe_key") == f"cmd_timeout:{stale_id}" for a in alerts)
    if found_timeout and found_alert:
        break
check("超时单被扫描置 timeout", found_timeout)
check("超时产生 cmd_timeout 告警", found_alert)

# ---------- 历史过滤：operator / since ----------
since = (datetime.now() - timedelta(minutes=10)).isoformat(timespec="seconds")
st, hist = req("GET", f"/commands/history?operator=operator&since={since}&limit=100", token=operator)
check("operator+since 过滤", st == 200 and len(hist) >= 3 and all(
    o["operator"] == "operator" and o["created_at"] >= since for o in hist))
st, hist = req("GET", "/commands/history?operator=nobody&limit=10", token=operator)
check("无匹配过滤返回空", st == 200 and hist == [])

print("\nP0-5 命令全生命周期追踪冒烟全部通过")
