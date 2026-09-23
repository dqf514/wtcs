# -*- coding: utf-8 -*-
"""系统状态机 + 启停序列冒烟：待机→开车→运行→停车→待机全链路 + 权限与并发保护。

用法: python smoke_sequence.py   （需后端运行在 127.0.0.1:8000）
注意：会把仿真子系统全部启动再停止，结束后系统回到待机。
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


def wait_exec_done(token: str, timeout: float = 60) -> dict:
    """轮询序列执行直到终态。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        s, b = req("GET", "/sequence-execution", token)
        if isinstance(b, dict) and b.get("state") in ("succeeded", "failed", "aborted"):
            return b
        time.sleep(0.5)
    return {"state": "timeout"}


def main():
    print("== 系统状态机 + 启停序列冒烟 ==")
    op = login("operator")
    admin = login("admin")
    cust = login("customer")

    # 1. 初始状态应为待机（仿真重启后辅机全停）
    s, st = req("GET", "/system/state", op)
    check("初始待机", s == 200 and st.get("state") == "standby", f"got {s} {st}")
    check("待机时未就绪辅机清单非空", len(st.get("unready_aux", [])) >= 4, str(st.get("unready_aux")))

    # 2. 序列定义：默认两条
    s, seqs = req("GET", "/sequences", op)
    ids = [q["id"] for q in seqs] if isinstance(seqs, list) else []
    check("默认序列存在", s == 200 and "startup" in ids and "shutdown" in ids, f"got {s} {ids}")
    steps = next((q["steps"] for q in seqs if q["id"] == "startup"), [])
    check("开车序列 5 步", len(steps) == 5, str(len(steps)))

    # 3. 客户无权执行
    s, b = req("POST", "/sequences/startup/execute", cust)
    check("客户执行序列 403", s == 403, f"got {s}")

    # 4. 执行开车序列
    s, b = req("POST", "/sequences/startup/execute", op)
    check("开车序列启动", s == 200 and b.get("state") == "running", f"got {s} {b}")

    # 5. 执行中重复执行 → 409
    s, b = req("POST", "/sequences/shutdown/execute", op)
    check("并发执行 409", s == 409, f"got {s} {b}")

    # 6. 等待开车完成
    fin = wait_exec_done(op, 60)
    check("开车序列成功", fin.get("state") == "succeeded", f"state={fin.get('state')} err={fin.get('error')}")
    ok_steps = [x for x in fin.get("steps", []) if x.get("status") == "ok"]
    check("全部步骤 ok", len(ok_steps) == 5, str([(x['label'], x['status'], x.get('message')) for x in fin.get('steps', [])]))

    # 7. 开车后系统运行中（风机转）或就绪
    time.sleep(1.5)
    s, st = req("GET", "/system/state", op)
    check("开车后运行中", st.get("state") == "running", f"got {st}")

    # 8. 执行停车序列
    s, b = req("POST", "/sequences/shutdown/execute", op)
    check("停车序列启动", s == 200 and b.get("state") == "running", f"got {s} {b}")
    fin = wait_exec_done(op, 120)
    check("停车序列成功", fin.get("state") == "succeeded", f"state={fin.get('state')} err={fin.get('error')}")

    # 9. 停车后回到待机
    time.sleep(1.5)
    s, st = req("GET", "/system/state", op)
    check("停车后待机", st.get("state") == "standby", f"got {st}")

    # 10. 序列编辑权限：operator 403；admin 非法步骤 400；合法保存 version+1
    s, b = req("PUT", "/sequences/startup", op, {"name": "x"})
    check("operator 改序列 403", s == 403, f"got {s}")
    s, b = req("PUT", "/sequences/startup", admin, {"steps": [{"label": "x"}]})
    check("非法步骤 400", s == 400, f"got {s} {b}")
    s, before = req("GET", "/sequences", admin)
    v0 = next(q["version"] for q in before if q["id"] == "startup")
    steps0 = next(q["steps"] for q in before if q["id"] == "startup")
    s, b = req("PUT", "/sequences/startup", admin, {"steps": steps0})
    check("合法保存 version+1", s == 200 and b.get("version") == v0 + 1, f"got {s} v={b.get('version')} v0={v0}")

    # 11. 中止保护：执行开车后立即中止
    req("POST", "/sequences/startup/execute", op)
    s, b = req("POST", "/sequence-execution/abort", op)
    check("中止序列", s == 200 and b.get("ok"), f"got {s} {b}")
    fin = wait_exec_done(op, 60)
    check("中止生效", fin.get("state") in ("aborted", "succeeded"), f"state={fin.get('state')}")
    # 清理：若中止时已启动部分辅机，执行停车序列恢复待机
    s, st = req("GET", "/system/state", op)
    if st.get("state") not in ("standby",):
        req("POST", "/sequences/shutdown/execute", op)
        wait_exec_done(op, 120)

    print(f"\n结果: {PASS} PASS / {FAIL} FAIL")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
