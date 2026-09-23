# -*- coding: utf-8 -*-
"""联锁矩阵冒烟：种子规则/真值表/指令拦截/告警联动/自动停车/CRUD 与权限/恢复闭环。

用法: python smoke_interlocks.py   （需后端运行在 127.0.0.1:8000）
注意：会把仿真系统从待机开车再停车，结束后系统回到待机；过程中产生的测试规则会删除。
"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000/api"
PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {detail}")


def login(username: str) -> str:
    req = urllib.request.Request(
        f"{BASE}/auth/login",
        data=json.dumps({"username": username, "password": "wtcs123"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["access_token"]


def req(method: str, path: str, token: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"{BASE}{path}", data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def cmd(token: str, sid: str, command: str, params=None):
    """下发指令（自动完成二次确认令牌流程），返回最终响应体。"""
    s, b = req("POST", "/commands", token, {"subsystem_id": sid, "command": command, "params": params or {}})
    msg = b.get("message", "")
    if not b.get("ok") and "confirm_token" in msg:
        token_armed = msg.rsplit(":", 1)[-1].strip()
        s, b = req("POST", "/commands", token,
                   {"subsystem_id": sid, "command": command, "params": params or {}, "confirm_token": token_armed})
    return s, b


def wait_state(token: str, want: str, timeout: float = 90) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        s, b = req("GET", "/system/state", token)
        if b.get("state") == want:
            return b
        time.sleep(0.5)
    return {"state": "timeout"}


def wait_seq_done(token: str, timeout: float = 90) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        s, b = req("GET", "/sequence-execution", token)
        if isinstance(b, dict) and b.get("state") in ("succeeded", "failed", "aborted"):
            return b
        time.sleep(0.5)
    return {"state": "timeout"}


def get_status(token: str) -> list:
    s, b = req("GET", "/interlocks/status", token)
    return b if isinstance(b, list) else []


def main():
    print("== 联锁矩阵冒烟 ==")
    op = login("operator")
    mt = login("maintainer")
    cust = login("customer")

    # 0. 前置：系统待机（非待机则先执行停车序列）
    s, cur = req("GET", "/system/state", op)
    if cur.get("state") not in ("standby", None):
        req("POST", "/sequences/shutdown/execute", op)
        wait_seq_done(op)
    st = wait_state(op, "standby", 60)
    check("前置：系统待机", st.get("state") == "standby", str(st))

    # 1. 种子规则与真值表
    s, rules = req("GET", "/interlocks", op)
    ids = [r["id"] for r in rules] if isinstance(rules, list) else []
    check("种子规则 4 条", s == 200 and len(ids) >= 4, f"got {s} {ids}")
    stat = get_status(op)
    check("真值表字段齐全", all("pass" in x and "violated" in x and "error" in x for x in stat), str(stat)[:200])
    perm = next((x for x in stat if x["id"] == "il_fan_start_perm"), {})
    check("待机时主风机启动许可不成立", perm.get("pass") is False, str(perm))

    # 2. 指令拦截：待机下直接启动主风机被拒
    s, b = cmd(op, "main_fan", "start")
    check("联锁拦截主风机启动", not b.get("ok") and "联锁拦截" in b.get("message", ""), str(b))

    # 3. 规则校验：非法表达式 400 / 合法创建
    s, b = req("POST", "/interlocks", mt, {"name": "bad", "kind": "alarm", "condition": "main_fan.wind_speed >>> 1"})
    check("非法表达式 400", s == 400, f"got {s} {b}")
    s, b = req("POST", "/interlocks", mt, {"name": "x", "kind": "alarm", "condition": "__import__('os')"})
    check("危险表达式 400", s == 400, f"got {s} {b}")
    s, b = req("POST", "/interlocks", mt, {"name": "x", "kind": "block", "condition": "main_fan.wind_speed > 1"})
    check("block 缺目标指令 400", s == 400, f"got {s} {b}")
    s, rule = req("POST", "/interlocks", mt, {
        "name": "smoke风速报警", "kind": "alarm", "severity": "warning",
        "condition": "main_fan.wind_speed > 1", "message": "smoke: 有风报警"})
    check("创建报警规则", s == 200 and rule.get("id"), f"got {s} {rule}")
    rid = rule.get("id", "")

    # 4. 权限：客户只读
    s, _ = req("POST", "/interlocks", cust, {"name": "x", "kind": "alarm", "condition": "1 > 0"})
    check("客户建规则 403", s == 403, f"got {s}")
    s, _ = req("GET", "/interlocks", cust)
    check("客户可读规则", s == 200, f"got {s}")

    # 5. 开车：许可条件随辅机运行变为成立
    s, b = req("POST", "/sequences/startup/execute", op)
    check("开车序列受理", s == 200, f"got {s} {b}")
    ex = wait_seq_done(op)
    check("开车成功", ex.get("state") == "succeeded", str(ex.get("error")))
    time.sleep(2)
    stat = get_status(op)
    perm = next((x for x in stat if x["id"] == "il_fan_start_perm"), {})
    check("运行后启动许可成立", perm.get("pass") is True, str(perm))

    # 6. 告警联动：有风触发 smoke 报警规则 → 告警表出现 interlock 条目且不被巡检误关
    t0 = time.time()
    alert_seen = False
    while time.time() - t0 < 30:
        s, alerts = req("GET", "/ai/alerts?active=1", op)
        items = alerts.get("items", alerts) if isinstance(alerts, dict) else alerts
        if any(f"interlock:{rid}" in json.dumps(a, ensure_ascii=False) for a in items):
            alert_seen = True
            break
        time.sleep(1)
    check("联锁告警产生", alert_seen, "未在告警表发现 interlock 条目")
    time.sleep(10)  # 跨过一轮 AI 巡检同步，验证 interlock: 域不被误关闭
    s, alerts = req("GET", "/ai/alerts?active=1", op)
    items = alerts.get("items", alerts) if isinstance(alerts, dict) else alerts
    still = any(f"interlock:{rid}" in json.dumps(a, ensure_ascii=False) for a in items)
    check("巡检同步不误关联锁告警", still, "联锁告警被巡检同步误关闭")

    # 7. 自动停车：建一条 wind>5 停主风机的规则 → 风速应自动回落
    s, arule = req("POST", "/interlocks", mt, {
        "name": "smoke自动停车", "kind": "auto_stop", "severity": "critical",
        "condition": "main_fan.wind_speed > 5", "target_subsystem": "main_fan", "target_command": "stop",
        "message": "smoke: 自动停车"})
    check("创建自动停车规则", s == 200 and arule.get("id"), f"got {s} {arule}")
    arid = arule.get("id", "")
    t0 = time.time()
    stopped = False
    while time.time() - t0 < 30:
        s, subs = req("GET", "/subsystems", op)
        fan = next((x for x in subs if x["id"] == "main_fan"), {})
        wind = next((p["value"] for p in fan.get("points", []) if p["key"] == "wind_speed"), 999)
        if not fan.get("running") and float(wind or 0) < 5:
            stopped = True
            break
        time.sleep(1)
    check("联锁自动停车生效", stopped, "主风机未被自动停止")

    # 8. 更新/删除：version 自增、删除后真值表移除
    s, upd = req("PUT", f"/interlocks/{rid}", mt, {"message": "smoke: 有风报警 v2", "enabled": False})
    check("更新规则 version+1", s == 200 and upd.get("version") == rule.get("version", 1) + 1, f"got {s} {upd}")
    s, _ = req("DELETE", f"/interlocks/{rid}", mt)
    check("删除报警规则", s == 200, f"got {s}")
    s, _ = req("DELETE", f"/interlocks/{arid}", mt)
    check("删除自动停车规则", s == 200, f"got {s}")
    stat = get_status(op)
    check("真值表已移除删除项", all(x["id"] not in (rid, arid) for x in stat), str([x['id'] for x in stat]))

    # 9. 审计留痕
    s, logs = req("GET", "/audit?limit=50", op)
    text = json.dumps(logs, ensure_ascii=False)
    check("审计含联锁拦截", "联锁拦截" in text)
    check("审计含联锁自动执行", "联锁自动执行" in text or "联锁触发" in text)

    # 10. 收尾：停车序列恢复待机
    req("POST", "/sequences/shutdown/execute", op)
    ex = wait_seq_done(op)
    st = wait_state(op, "standby", 60)
    check("恢复待机", ex.get("state") == "succeeded" and st.get("state") == "standby", str(st))

    print(f"\n结果: {PASS} PASS / {FAIL} FAIL")
    return FAIL


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
