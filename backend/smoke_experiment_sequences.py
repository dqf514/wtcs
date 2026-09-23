# -*- coding: utf-8 -*-
"""P0-7 试验序列编排冒烟：CRUD/校验/启动执行（全链路命令单）/暂停继续/跳过/中止/版本/审计/并发冲突。"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000/api"


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


def execution(token):
    st, e = req("GET", "/experiment-sequences/execution", token=token)
    assert st == 200, e
    return e


def wait_state(token, states, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = execution(token)
        if e.get("state") in states:
            return e
        time.sleep(0.4)
    return execution(token)


maintainer = login("maintainer")
operator = login("operator")

# ---------- 基线：无进行中执行 ----------
e0 = execution(maintainer)
check("基线无进行中试验序列", e0.get("state") not in ("running", "paused"), str(e0.get("state")))

# ---------- 权限与校验 ----------
st, _ = req("POST", "/experiment-sequences", {"name": "x", "steps": [{"type": "hold", "seconds": 1}]}, token=operator)
check("操作员建序列 403", st == 403, str(st))

st, bad = req("POST", "/experiment-sequences",
              {"name": "坏步骤", "steps": [{"type": "fly_to_moon"}]}, token=maintainer)
check("非法步骤类型 400", st == 400, str(bad)[:80])

st, bad2 = req("POST", "/experiment-sequences",
               {"name": "坏子系统", "steps": [{"type": "setpoint", "subsystem": "warp_drive", "command": "x"}]}, token=maintainer)
check("非法子系统 400", st == 400, str(bad2)[:80])

# ---------- 建主序列：notify→setpoint→hold→acquire→notify→acquire stop→setpoint 0 ----------
steps_main = [
    {"type": "notify", "message": "开始阶梯风速试验", "alert": True},
    {"type": "setpoint", "subsystem": "main_fan", "command": "set_speed", "params": {"target_speed": 8}},
    {"type": "hold", "seconds": 3},
    {"type": "acquire", "subsystem": "acoustic", "action": "start"},
    {"type": "notify", "message": "采集完成"},
    {"type": "acquire", "subsystem": "acoustic", "action": "stop"},
    {"type": "setpoint", "subsystem": "main_fan", "command": "set_speed", "params": {"target_speed": 0}},
]
st, seq = req("POST", "/experiment-sequences",
              {"name": "冒烟-阶梯风速", "description": "P0-7 冒烟", "steps": steps_main}, token=maintainer)
check("维护员建序列成功", st == 200 and seq["version"] == 1 and len(seq["steps"]) == 7, str(seq)[:120])
seq_id = seq["id"]

st, lst = req("GET", "/experiment-sequences", token=operator)
check("序列列表可见", st == 200 and any(s["id"] == seq_id for s in lst))

# ---------- 启动并执行到成功（operator） ----------
st, ex = req("POST", f"/experiment-sequences/{seq_id}/start", {}, token=operator)
check("启动试验序列", st == 200 and ex["state"] == "running" and ex["total_steps"] == 7, str(ex)[:120])
check("自动新建实验记录", bool(ex.get("experiment_id")), str(ex.get("experiment_id")))

# hold 期间能看到剩余秒数提示
saw_hold_msg = False
t0 = time.time()
while time.time() - t0 < 15:
    e = execution(operator)
    if e.get("state") == "running" and e.get("current_step") == 2:
        msg = e["steps"][2].get("message", "")
        if "剩余" in msg:
            saw_hold_msg = True
            break
    if e.get("current_step", 0) > 2:
        break
    time.sleep(0.3)
check("hold 步显示剩余秒数", saw_hold_msg)

e = wait_state(operator, ("succeeded", "failed", "aborted"))
check("主序列执行成功", e["state"] == "succeeded", e.get("error", ""))
check("全部步骤 ok", all(s["status"] == "ok" for s in e["steps"]), str([s["status"] for s in e["steps"]]))

# setpoint 走全链路：命令单有 operator 的 acked set_speed
st, hist = req("GET", "/commands/history?subsystem=main_fan&status=acked&limit=20", token=operator)
check("setpoint 全链路命令单 acked",
      any(o["command"] == "set_speed" and o["operator"] == "operator" for o in hist), str(hist[:1])[:120])
st, hist2 = req("GET", "/commands/history?subsystem=acoustic&limit=20", token=operator)
check("acquire 全链路命令单留痕",
      any(o["command"] == "start_acquire" for o in hist2) and any(o["command"] == "stop_acquire" for o in hist2),
      str([o["command"] for o in hist2][:6]))

# ---------- 暂停/继续 ----------
st, seq2 = req("POST", "/experiment-sequences",
               {"name": "冒烟-暂停", "steps": [{"type": "hold", "seconds": 10}]}, token=maintainer)
check("建暂停序列", st == 200, str(seq2)[:80])
st, _ = req("POST", f"/experiment-sequences/{seq2['id']}/start", {}, token=operator)
check("启动暂停序列", st == 200)
time.sleep(1.0)
st, e = req("POST", "/experiment-sequences/execution/pause", token=operator)
check("暂停", st == 200 and e["state"] == "paused", str(e.get("state")))
time.sleep(2.0)
e = execution(operator)
check("暂停中不推进", e["state"] == "paused" and e["steps"][0]["status"] == "running", str(e["steps"][0]))
st, e = req("POST", "/experiment-sequences/execution/resume", token=operator)
check("继续", st == 200 and e["state"] == "running", str(e.get("state")))
e = wait_state(operator, ("succeeded", "failed", "aborted"), timeout=20)
check("暂停序列执行成功", e["state"] == "succeeded", e.get("error", ""))

# ---------- 跳过当前步 ----------
st, seq3 = req("POST", "/experiment-sequences",
               {"name": "冒烟-跳过", "steps": [{"type": "hold", "seconds": 30}]}, token=maintainer)
check("建跳过序列", st == 200)
st, _ = req("POST", f"/experiment-sequences/{seq3['id']}/start", {}, token=operator)
check("启动跳过序列", st == 200)
time.sleep(1.0)
st, _ = req("POST", "/experiment-sequences/execution/skip", token=operator)
check("跳过当前步", st == 200)
e = wait_state(operator, ("succeeded", "failed", "aborted"), timeout=10)
check("跳过后序列成功且该步 skipped",
      e["state"] == "succeeded" and e["steps"][0]["status"] == "skipped", str(e["steps"][0]))

# ---------- 并发冲突 + 中止 ----------
st, seq4 = req("POST", "/experiment-sequences",
               {"name": "冒烟-中止", "steps": [{"type": "hold", "seconds": 20}]}, token=maintainer)
check("建中止序列", st == 200)
st, _ = req("POST", f"/experiment-sequences/{seq4['id']}/start", {}, token=operator)
check("启动中止序列", st == 200)
st, c = req("POST", f"/experiment-sequences/{seq_id}/start", {}, token=operator)
check("并发启动 409", st == 409, str(c)[:80])
st, d = req("DELETE", f"/experiment-sequences/{seq4['id']}", token=maintainer)
check("执行中删除 409", st == 409, str(d)[:80])
st, e = req("POST", "/experiment-sequences/execution/abort", token=operator)
check("中止", st == 200, str(e.get("state")))
e = wait_state(operator, ("aborted",), timeout=10)
check("序列已中止", e["state"] == "aborted" and "中止" in e.get("error", ""), str(e.get("error")))

# ---------- 版本自增 ----------
st, row = req("PUT", f"/experiment-sequences/{seq_id}",
              {"name": "冒烟-阶梯风速v2", "description": "改", "steps": steps_main}, token=maintainer)
check("PUT 版本自增", st == 200 and row["version"] == 2, str(row.get("version")))

# ---------- 审计留痕 ----------
st, audit = req("GET", "/audit?limit=200", token=operator)
acts = [a["action"] for a in audit]
check("审计：启动/步骤/完成",
      "试验序列启动" in acts and "试验序列步骤" in acts and "试验序列完成" in acts,
      str([a for a in acts if a.startswith("试验序列")][:8]))

# ---------- 清理与复位 ----------
for sid in (seq_id, seq2["id"], seq3["id"], seq4["id"]):
    st, _ = req("DELETE", f"/experiment-sequences/{sid}", token=maintainer)
    check(f"删除序列 {sid}", st == 200, str(st))

e = execution(operator)
check("结束后无进行中执行", e.get("state") not in ("running", "paused"), str(e.get("state")))
st, subs = req("GET", "/subsystems", token=operator)
ac = next((s for s in subs if s["id"] == "acoustic"), {})
check("acoustic 已停止采集", not ac.get("acquiring", False), str(ac.get("acquiring")))

print("\nP0-7 试验序列编排冒烟全部通过")
