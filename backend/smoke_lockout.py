# -*- coding: utf-8 -*-
"""P0-6 子系统挂牌/维护模式（LOTO）冒烟：挂牌→指令被拒（含命令单留痕+审计）→摘牌恢复→状态机联动。"""
import json
import sys
import time
import urllib.request

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


def send(token, sid, cmd, params=None):
    """下发指令（透明处理 confirm_token）。"""
    st, res = req("POST", "/commands", {"subsystem_id": sid, "command": cmd, "params": params or {}}, token)
    if st == 200 and not res.get("ok") and "confirm_token" in res.get("message", ""):
        t = res["message"].split("重发: ").pop().strip()
        st, res = req("POST", "/commands",
                      {"subsystem_id": sid, "command": cmd, "params": params or {}, "confirm_token": t}, token)
    return st, res


def system_state(token):
    st, s = req("GET", "/system/state", token=token)
    assert st == 200, s
    return s


maintainer = login("maintainer")
operator = login("operator")

# ---------- 基线：未挂牌时待机且缺 4 辅机 ----------
s0 = system_state(maintainer)
check("基线待机且缺 4 辅机", s0["state"] in ("standby", "preparing") and "吹扫风系统" in s0["unready_aux"], str(s0))

# ---------- 挂牌权限 ----------
st, _ = req("POST", "/lockout/purge_air", {"reason": "x"}, token=operator)
check("操作员挂牌 403", st == 403)
st, _ = req("POST", "/lockout/not_a_subsystem", {"reason": "x"}, token=maintainer)
check("非法子系统 422", st == 422)

# ---------- 挂牌 → 指令被拒 → 留痕 ----------
st, lo = req("POST", "/lockout/purge_air", {"reason": "更换滤芯"}, token=maintainer)
check("维护员挂牌成功", st == 200 and lo["active"] and lo["tag_by"] == "maintainer" and lo["reason"] == "更换滤芯", str(lo))

st, lst = req("GET", "/lockout", token=operator)
check("挂牌列表可见", st == 200 and any(l["subsystem_id"] == "purge_air" for l in lst))

# API 直调也被拒（require_confirm 的 start 在确认门之前就被挂牌拦截）
st, res = req("POST", "/commands", {"subsystem_id": "purge_air", "command": "start"}, token=operator)
check("挂牌子系统指令被拒", st == 200 and not res["ok"] and "挂牌检修" in res["message"], res.get("message", ""))

st, hist = req("GET", "/commands/history?subsystem=purge_air&status=rejected&limit=5", token=operator)
check("挂牌拦截命令单留痕 rejected", any(o["command"] == "start" and "挂牌检修" in o["receipt"] for o in hist), str(hist[:1]))

st, audit = req("GET", "/audit?limit=50", token=operator)
check("审计留痕（挂牌+挂牌拦截）",
      any(a["action"] == "挂牌" and "purge_air" in a["detail"] for a in audit)
      and any(a["action"] == "挂牌拦截" and "purge_air.start" in a["detail"] for a in audit))

# ---------- 状态机联动：挂牌辅机从就绪判定摘除 ----------
time.sleep(0.3)  # 等一个遥测周期重算
s1 = system_state(maintainer)
check("挂牌吹扫风从就绪判定摘除", "吹扫风系统" not in s1["unready_aux"], str(s1["unready_aux"]))

# ---------- 摘牌恢复 ----------
st, res = req("DELETE", "/lockout/purge_air", token=maintainer)
check("摘牌成功", st == 200 and res["ok"])
st, lst = req("GET", "/lockout", token=operator)
check("摘牌后列表无 purge_air", all(l["subsystem_id"] != "purge_air" for l in lst))
st, res = send(operator, "purge_air", "start")
check("摘牌后指令恢复可下发", st == 200 and res["ok"], res.get("message", ""))
st, res = send(operator, "purge_air", "stop")
check("复位：停吹扫风", st == 200 and res["ok"], res.get("message", ""))
st, _ = req("DELETE", "/lockout/purge_air", token=maintainer)
check("重复摘牌 404", st == 404)

# ---------- 主风机挂牌 → 系统不可开车 ----------
# 先把 4 辅机全部跑起来（此时若主风机未挂牌应为「就绪」）
for aux in ("cooling_water", "compressed_air", "purge_air", "exhaust"):
    st, res = send(operator, aux, "start")
    check(f"启动辅机 {aux}", st == 200 and res["ok"], res.get("message", ""))
time.sleep(0.5)
s2 = system_state(maintainer)
check("辅机全运行 → 就绪", s2["state"] == "ready", str(s2))

st, _ = req("POST", "/lockout/main_fan", {"reason": "轴承检修"}, token=maintainer)
check("主风机挂牌", st == 200)
time.sleep(0.5)
s3 = system_state(maintainer)
check("主风机挂牌 → 不就绪", s3["state"] != "ready", str(s3))
check("未就绪原因含挂牌说明", any("挂牌检修" in n for n in s3["unready_aux"]), str(s3["unready_aux"]))

# 挂牌期间主风机启动被拒（联锁许可已满足，纯粹是挂牌拦截）
st, res = req("POST", "/commands", {"subsystem_id": "main_fan", "command": "start"}, token=operator)
check("挂牌期间主风机启动被拒", st == 200 and not res["ok"] and "挂牌检修" in res["message"], res.get("message", ""))

st, _ = req("DELETE", "/lockout/main_fan", token=maintainer)
check("主风机摘牌", st == 200)
time.sleep(0.5)
s4 = system_state(maintainer)
check("摘牌后恢复就绪", s4["state"] == "ready", str(s4))

# ---------- 复位：停全部辅机回待机 ----------
for aux in ("cooling_water", "compressed_air", "purge_air", "exhaust"):
    st, res = send(operator, aux, "stop")
    check(f"停止辅机 {aux}", st == 200 and res["ok"], res.get("message", ""))
time.sleep(0.5)
s5 = system_state(maintainer)
check("复位回待机", s5["state"] == "standby", str(s5))
st, lst = req("GET", "/lockout", token=operator)
check("复位后无生效挂牌", lst == [])

print("\nP0-6 挂牌/维护模式（LOTO）冒烟全部通过")
