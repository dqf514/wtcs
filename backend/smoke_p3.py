# -*- coding: utf-8 -*-
"""P3 冒烟：风速程控（CRUD→start→overview 推进→stop→审计）+ 设备台账 + 维护记录。"""
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


_, login = req("POST", "/auth/login", {"username": "operator", "password": "wtcs123"})
token = login["access_token"]
_, login_m = req("POST", "/auth/login", {"username": "maintainer", "password": "wtcs123"})
mtoken = login_m["access_token"]
print("登录 ok")

# 页面权限迁移：operator 应含 equipment
_, me = req("GET", "/auth/me", token=token)
check("页面矩阵迁移 equipment", "equipment" in me.get("pages", []), f"pages={me.get('pages')}")

# 1. 程控剖面 CRUD
st, p = req("POST", "/profiles", {
    "name": "P3冒烟剖面",
    "steps": [{"speed": 15, "hold_sec": 3}, {"speed": 30, "hold_sec": 3}, {"speed": 20, "hold_sec": 30}],
}, token)
check("创建剖面", st == 200 and p.get("id"), f"id={p.get('id')}")
pid = p["id"]

st, p2 = req("PUT", f"/profiles/{pid}", {"name": "P3冒烟剖面v2"}, token)
check("修改剖面", st == 200 and p2.get("name") == "P3冒烟剖面v2")

st, plist = req("GET", "/profiles", token=token)
check("剖面列表", st == 200 and any(x["id"] == pid for x in plist), f"共{len(plist)}个")

# 2. 启动程控（含风机联动）→ overview 推进
st, run = req("POST", f"/profiles/{pid}/start", {}, token)
check("启动程控", st == 200 and run.get("state") == "running", f"steps={run.get('total_steps')}")

# 执行中重复启动 → 409
st, dup = req("POST", f"/profiles/{pid}/start", {}, token)
check("重复启动 409", st == 409, f"st={st}")

# 执行中删除 → 409（维护员）
st, d = req("DELETE", f"/profiles/{pid}", token=mtoken)
check("执行中删除 409", st == 409, f"st={st}")

time.sleep(4)  # 第 1 步 3s 保持后应推进到第 2 步
st, ov = req("GET", "/overview", token=token)
prof = ov.get("profile")
check("overview.profile 推进", prof and prof.get("state") == "running" and prof.get("step_index") >= 1,
      f"profile={prof}")

# 风机联动：执行中风速应朝目标收敛（>0）
check("风机联动风速", ov.get("wind_speed", 0) > 1.0, f"wind={ov.get('wind_speed')}")

# 3. 中止
st, stop = req("POST", "/profiles/stop", {}, token)
check("中止程控", st == 200, f"st={st}")
time.sleep(1.5)
st, ov = req("GET", "/overview", token=token)
check("中止后 overview.profile 空闲", ov.get("profile") is None, f"profile={ov.get('profile')}")

# 审计：启动/中止有记录
st, audit = req("GET", "/audit?limit=30", token=token)
actions = [a["action"] for a in audit]
check("审计记录", "启动程控" in actions and ("中止程控" in actions or "程控中止" in actions),
      f"actions={actions[:6]}")

# 4. 删除剖面（操作员 403，维护员 200）
st, _ = req("DELETE", f"/profiles/{pid}", token=token)
check("操作员删除 403", st == 403, f"st={st}")
st, _ = req("DELETE", f"/profiles/{pid}", token=mtoken)
check("维护员删除剖面", st == 200, f"st={st}")

# 5. 设备台账
st, eq = req("GET", "/equipment", token=token)
check("设备台账 12 档", st == 200 and len(eq) == 12, f"count={len(eq)}")
fan = next((e for e in eq if e["subsystem_id"] == "main_fan"), None)
check("台账字段", fan and "today_minutes" in fan and "total_minutes" in fan and "unacked_alerts" in fan,
      f"fan={fan}")

# 6. 维护记录：POST（维护员）→ GET；操作员 POST 应 403
st, m = req("POST", "/equipment/main_fan/maintenance",
            {"type": "保养", "content": "P3冒烟：主风机轴承润滑检查"}, mtoken)
check("新增维护记录", st == 200 and m.get("id"), f"id={m.get('id')}")
st, _ = req("POST", "/equipment/main_fan/maintenance", {"type": "巡检", "content": "越权测试"}, token)
check("操作员维护 403", st == 403, f"st={st}")
st, mlist = req("GET", "/equipment/main_fan/maintenance", token=token)
check("维护记录列表", st == 200 and any(x["id"] == m["id"] for x in mlist), f"count={len(mlist)}")

# 7. 演示数据：WLTP 阶梯工况剖面（幂等：已存在则跳过）
st, plist = req("GET", "/profiles", token=token)
if not any(x["name"] == "WLTP 阶梯工况" for x in plist):
    st, demo = req("POST", "/profiles", {
        "name": "WLTP 阶梯工况",
        "steps": [
            {"speed": 10, "hold_sec": 20},
            {"speed": 25, "hold_sec": 30},
            {"speed": 40, "hold_sec": 30},
            {"speed": 60, "hold_sec": 20},
            {"speed": 35, "hold_sec": 20},
            {"speed": 0, "hold_sec": 10},
        ],
    }, token)
    check("演示剖面", st == 200, f"st={st}")
else:
    print("[PASS] 演示剖面已存在")

# 演示维护记录（幂等）
st, mlist = req("GET", "/equipment/cooling_water/maintenance", token=token)
if not any("演示" in x["content"] for x in mlist):
    st, _ = req("POST", "/equipment/cooling_water/maintenance",
                {"type": "巡检", "content": "演示：冷机群控与水泵运行巡检，供回水温差正常"}, mtoken)
    check("演示维护记录", st == 200, f"st={st}")
else:
    print("[PASS] 演示维护记录已存在")

print("\nP3 冒烟全部通过")
