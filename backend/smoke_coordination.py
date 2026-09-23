# -*- coding: utf-8 -*-
"""参数联动冒烟：preview 建议/拒绝/告警、apply 下发与逐项校验、指令级限值拦截、权限。

用法: python smoke_coordination.py   （需后端运行在 127.0.0.1:8000，仿真模式）
"""
import json
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


def main():
    print("== 参数联动冒烟 ==")
    op = login("operator")
    cust = login("customer")

    # 0. 复位路面（停皮带+速度归零），避免上次运行残留影响告警断言
    req("POST", "/commands", op, {"subsystem_id": "rrs", "command": "stop_belt", "params": {}})
    req("POST", "/coordination/apply", op, {"items": [
        {"id": "reset", "label": "复位", "subsystem": "rrs", "command": "set_belt_speed", "params": {"belt_speed": 0}}]})

    # 1. preview：40 m/s → 路面跟随/抽吸比/尾气跟随建议
    s, p = req("POST", "/coordination/preview", op, {"wind_speed": 40})
    ids = [i["id"] for i in p.get("items", [])]
    check("preview 40 三项建议", s == 200 and p.get("ok") and ids == ["belt_follow", "suction_ratio", "exhaust_follow"], f"got {ids}")
    belt = next((i for i in p["items"] if i["id"] == "belt_follow"), {})
    check("路面速比 1:1 建议 40", belt.get("suggested") == 40.0, str(belt))
    check("路面未运行告警", any("路面未运行" in w for w in p.get("warnings", [])), str(p.get("warnings")))

    # 2. preview：超限拒绝 / 非常规区间警告 / 低风速无联动
    s, p = req("POST", "/coordination/preview", op, {"wind_speed": 130})
    check("preview 130 拒绝", s == 200 and not p.get("ok") and "限值" in p.get("reject", ""), str(p))
    s, p = req("POST", "/coordination/preview", op, {"wind_speed": 90})
    check("preview 90 超常规区间告警", p.get("ok") and any("常规试验区间" in w for w in p["warnings"]), str(p.get("warnings")))
    s, p = req("POST", "/coordination/preview", op, {"wind_speed": 2})
    check("preview 2 无联动项", p.get("ok") and len(p.get("items", [])) == 0, str(p.get("items")))
    s, p = req("POST", "/coordination/preview", op, {"wind_speed": "abc"})
    check("preview 非数值 400", s == 400, f"got {s}")

    # 3. apply：合法项下发成功
    s, r = req("POST", "/coordination/apply", op, {"items": [
        {"id": "belt_follow", "label": "路面速度跟随", "subsystem": "rrs", "command": "set_belt_speed", "params": {"belt_speed": 40}},
        {"id": "suction_ratio", "label": "边界层抽吸比", "subsystem": "boundary_layer", "command": "set_ratio", "params": {"suction_ratio": 40}},
    ]})
    check("apply 两项成功", s == 200 and r.get("ok") and all(x["ok"] for x in r["results"]), str(r))

    # 4. apply：超限项被拒且不中断其他项
    s, r = req("POST", "/coordination/apply", op, {"items": [
        {"id": "a", "label": "超限路面", "subsystem": "rrs", "command": "set_belt_speed", "params": {"belt_speed": 200}},
        {"id": "b", "label": "合法抽吸", "subsystem": "boundary_layer", "command": "set_ratio", "params": {"suction_ratio": 30}},
    ]})
    oks = {x["id"]: x["ok"] for x in r.get("results", [])}
    check("apply 超限被拒/合法通过", s == 200 and not r.get("ok") and oks == {"a": False, "b": True}, str(r))
    s, r = req("POST", "/coordination/apply", op, {"items": [
        {"id": "c", "label": "x", "subsystem": "nope", "command": "start", "params": {}}]})
    check("apply 未知子系统被拒", s == 200 and not r["results"][0]["ok"], str(r))

    # 5. 权限：客户 403
    s, _ = req("POST", "/coordination/apply", cust, {"items": [
        {"id": "a", "label": "x", "subsystem": "rrs", "command": "set_belt_speed", "params": {"belt_speed": 10}}]})
    check("客户 apply 403", s == 403, f"got {s}")
    s, _ = req("POST", "/coordination/preview", cust, {"wind_speed": 40})
    check("客户 preview 可读", s == 200, f"got {s}")

    # 6. 指令级限值：/commands 超限直接拒绝
    s, b = req("POST", "/commands", op, {"subsystem_id": "main_fan", "command": "set_speed", "params": {"target_speed": 150}})
    check("set_speed 150 拒绝", not b.get("ok") and "限值" in b.get("message", ""), str(b))
    s, b = req("POST", "/commands", op, {"subsystem_id": "rrs", "command": "set_yaw", "params": {"yaw": 45}})
    check("set_yaw 45 拒绝", not b.get("ok") and "限值" in b.get("message", ""), str(b))
    s, b = req("POST", "/commands", op, {"subsystem_id": "rrs", "command": "set_yaw", "params": {"yaw": 10}})
    if not b.get("ok") and "confirm_token" in b.get("message", ""):
        token_armed = b["message"].rsplit(":", 1)[-1].strip()
        s, b = req("POST", "/commands", op, {"subsystem_id": "rrs", "command": "set_yaw", "params": {"yaw": 10}, "confirm_token": token_armed})
    check("set_yaw 10 放行", b.get("ok"), str(b))

    print(f"\n结果: {PASS} PASS / {FAIL} FAIL")
    return FAIL


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
