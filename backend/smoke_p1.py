# -*- coding: utf-8 -*-
"""P1 管理主干一次性冒烟 + 演示数据脚本：项目 CRUD / 客户隔离 / 排程 CRUD / 客户排程过滤 / 角色 pages。"""
import json
import sys
import urllib.request
from datetime import datetime, timedelta

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


admin = login("admin")
customer = login("customer")
operator = login("operator")

# ---------- 项目 CRUD ----------
st, proj = req("GET", "/projects", token=admin)
check("admin 项目列表", st == 200)
target = next((p for p in proj if p["project_no"] == "HF-2026-01"), None)
if target is None:
    st, target = req("POST", "/projects", {
        "project_no": "HF-2026-01", "name": "某车型气动开发",
        "customer_username": "customer", "status": "进行中", "note": "演示项目：全工况气动开发",
    }, token=admin)
    check("创建演示项目", st == 200, target.get("id", ""))
else:
    # 已存在（前面误建的 x 名称）则修正
    st, target = req("PUT", f"/projects/{target['id']}", {
        "name": "某车型气动开发", "customer_username": "customer",
        "status": "进行中", "note": "演示项目：全工况气动开发",
    }, token=admin)
    check("修正演示项目", st == 200)
pid = target["id"]
check("项目状态=进行中", target["status"] == "进行中")

st, dup = req("POST", "/projects", {"project_no": "HF-2026-01", "name": "dup", "customer_username": "customer"}, token=admin)
check("重复项目号 400", st == 400)

st, tmp = req("POST", "/projects", {"project_no": "TMP-SMOKE-01", "name": "临时项目", "customer_username": "customer"}, token=admin)
check("创建临时项目", st == 200)
st, tmp2 = req("PUT", f"/projects/{tmp['id']}", {"status": "验收"}, token=admin)
check("更新临时项目", st == 200 and tmp2["status"] == "验收")
st, _ = req("DELETE", f"/projects/{tmp['id']}", token=admin)
check("删除空项目", st == 200)

# 关联订单 WD-2026-001 到演示项目
st, orders = req("GET", "/orders", token=admin)
wd = next((o for o in orders if o["order_no"] == "WD-2026-001"), None)
check("订单 WD-2026-001 存在", wd is not None)
if wd["project_id"] != pid:
    st, wd = req("PUT", f"/orders/{wd['id']}", {"project_id": pid}, token=admin)
    check("订单关联项目", st == 200 and wd["project_id"] == pid)

# 有订单的项目不可删
st, _ = req("DELETE", f"/projects/{pid}", token=admin)
check("有订单的项目删除 400", st == 400)

st, detail = req("GET", f"/projects/{pid}", token=admin)
check("项目详情带 orders+experiment_count", st == 200 and "orders" in detail
      and any(o["order_no"] == "WD-2026-001" and "experiment_count" in o for o in detail["orders"]))

# 客户只看本人项目
st, cproj = req("GET", "/projects", token=customer)
check("客户项目列表=本人", st == 200 and all(p["customer_username"] == "customer" for p in cproj)
      and any(p["id"] == pid for p in cproj))
st, cforbid = req("POST", "/projects", {"project_no": "X-1", "name": "x", "customer_username": "customer"}, token=customer)
check("客户创建项目 403", st == 403)

# ---------- 排程 CRUD + 演示数据 ----------
today = datetime.now().replace(hour=9, minute=0, second=0, microsecond=0)
st, exps = req("GET", "/experiments", token=admin)
demo_exp = next((e for e in exps if "气动标模" in e.get("title", "")), exps[0] if exps else None)

st, scheds = req("GET", "/schedules", token=admin)
existing_titles = {s["title"] for s in scheds}
demo_defs = [
    ("气动标模工况-演示实验", today.replace(hour=9), today.replace(hour=11), "进行中", "风洞洞体", demo_exp),
    ("滚流比对工况-演示", today + timedelta(days=1, hours=5), today + timedelta(days=1, hours=7), "已确认", "滚动路面", None),
    ("声学包评测-演示", today + timedelta(days=2, hours=1), today + timedelta(days=2, hours=3), "计划中", "声学测量", None),
]
demo_ids = []
for title, s0, s1, status, resource, exp in demo_defs:
    if title in existing_titles:
        continue
    body = {
        "title": title, "project_id": pid, "order_id": wd["id"],
        "experiment_id": exp["id"] if exp else None,
        "resource": resource,
        "start_at": s0.isoformat(timespec="minutes"), "end_at": s1.isoformat(timespec="minutes"),
        "status": status, "note": "演示排程",
    }
    st, row = req("POST", "/schedules", body, token=admin)
    check(f"创建排程 {title}", st == 200, row.get("id", ""))
    demo_ids.append(row["id"])

st, all_sched = req("GET", "/schedules", token=admin)
check("排程列表非空", st == 200 and len(all_sched) >= 3)
one = next(s for s in all_sched if s["title"].startswith("声学包评测"))
st, upd = req("PUT", f"/schedules/{one['id']}", {"status": "已确认"}, token=admin)
check("更新排程状态", st == 200 and upd["status"] == "已确认")
st, bad = req("POST", "/schedules", {
    "title": "bad", "start_at": today.isoformat(timespec="minutes"),
    "end_at": (today - timedelta(hours=1)).isoformat(timespec="minutes"),
}, token=admin)
check("start>=end 400", st == 400)
st, rng = req("GET", f"/schedules?from={today.date().isoformat()}T00:00&to={today.date().isoformat()}T23:59", token=admin)
check("from/to 范围过滤", st == 200 and all(s["start_at"][:10] == today.date().isoformat() for s in rng) and len(rng) >= 1)

# 操作员可读不可写
st, _ = req("GET", "/schedules", token=operator)
check("操作员可读排程", st == 200)
st, _ = req("POST", "/schedules", {"title": "x", "start_at": today.isoformat(timespec="minutes"),
                                   "end_at": (today + timedelta(hours=1)).isoformat(timespec="minutes")}, token=operator)
check("操作员写排程 403", st == 403)

# 客户排程过滤：只见关联本人项目/订单的条目
st, cs = req("GET", "/schedules", token=customer)
check("客户排程=关联本人", st == 200 and len(cs) >= 3 and all(
    s.get("project_id") == pid or s.get("order_id") == wd["id"] for s in cs))
# 无关联条目客户不可见
st, orphan = req("POST", "/schedules", {
    "title": "内部联调（无关联）", "resource": "风洞洞体",
    "start_at": today.isoformat(timespec="minutes"), "end_at": (today + timedelta(hours=1)).isoformat(timespec="minutes"),
}, token=admin)
check("创建无关联排程", st == 200)
st, cs2 = req("GET", "/schedules", token=customer)
check("客户不见无关联排程", all(s["id"] != orphan["id"] for s in cs2))
st, _ = req("DELETE", f"/schedules/{orphan['id']}", token=admin)
check("删除排程", st == 200)

# ---------- 内置角色 pages 迁移 ----------
st, roles = req("GET", "/admin/roles", token=admin)
check("角色列表", st == 200)
by_name = {r["name"]: r["pages"] for r in roles}
check("管理员 pages 含 projects+schedule", {"projects", "schedule"} <= set(by_name["管理员"]))
check("维护员 pages 含 projects+schedule", {"projects", "schedule"} <= set(by_name["维护员"]))
check("操作员 pages 含 schedule", "schedule" in by_name["操作员"])
check("客户 pages 不变", set(by_name["客户"]) == {"portal", "dashboard", "screen"})

print("\nP1 冒烟全部通过")
