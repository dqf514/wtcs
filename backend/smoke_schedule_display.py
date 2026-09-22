# -*- coding: utf-8 -*-
"""排程展示大屏冒烟：display 接口隐私裁剪 / 排队号编号 / 客户 403 / 排程 CRUD 不回归。

幂等演示数据：今天 4 条 + 明天 2 条（标题前缀「公示演示-」，覆盖 已完成/进行中/已确认/计划中），
关联演示项目 HF-2026-01 / 订单 WD-2026-001；已存在同 title 的跳过。
"""
import json
import re
import sys
import urllib.request
import urllib.error
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
maintainer = login("maintainer")
operator = login("operator")
customer = login("customer")
print("登录 ok")

# ---------- 幂等演示数据：今天 4 条 + 明天 2 条 ----------
st, projs = req("GET", "/projects", token=admin)
proj = next((p for p in projs if p["project_no"] == "HF-2026-01"), None)
check("演示项目 HF-2026-01 存在", proj is not None)
st, orders = req("GET", "/orders", token=admin)
wd = next((o for o in orders if o["order_no"] == "WD-2026-001"), None)
check("演示订单 WD-2026-001 存在", wd is not None)

today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
demo_defs = [
    # (title, 天偏移, 开始, 结束, 状态, 资源)
    ("公示演示-气动阻力测量", 0, "08:00", "09:30", "已完成", "风洞洞体"),
    ("公示演示-声学包评测", 0, "10:00", "11:30", "进行中", "声学测量"),
    ("公示演示-滚流比对工况", 0, "13:00", "15:00", "已确认", "滚动路面"),
    ("公示演示-尾流场测量", 0, "15:30", "17:30", "计划中", "压力测量"),
    ("公示演示-高速稳定性", 1, "09:00", "11:00", "已确认", "风洞洞体"),
    ("公示演示-热管理工况", 1, "14:00", "16:00", "计划中", "主风机系统"),
]
st, scheds = req("GET", "/schedules", token=admin)
existing_titles = {s["title"] for s in scheds}
for title, day_off, t0, t1, status, resource in demo_defs:
    if title in existing_titles:
        print(f"[PASS] 演示排程已存在: {title}")
        continue
    day = today + timedelta(days=day_off)
    st, row = req("POST", "/schedules", {
        "title": title, "project_id": proj["id"], "order_id": wd["id"],
        "resource": resource,
        "start_at": f"{day.date().isoformat()}T{t0}", "end_at": f"{day.date().isoformat()}T{t1}",
        "status": status, "note": "排程公示大屏演示数据",
    }, token=admin)
    check(f"创建演示排程 {title}", st == 200, f"st={st}")

# ---------- privacy=1：服务端去标识化 ----------
st, d1 = req("GET", "/schedules/display?days=2&privacy=1", token=operator)
check("display privacy=1 可读", st == 200, f"st={st}")
items = d1["items"]
check("privacy=1 有条目", len(items) >= 5, f"count={len(items)}")
allowed = {"queue_no", "date", "start_at", "end_at", "status", "resource"}
forbidden = {"id", "title", "project_id", "order_id", "experiment_id", "created_by", "note",
             "project_name", "order_name", "raw_status", "customer", "customer_username"}
keys = set().union(*(it.keys() for it in items))
check("privacy=1 字段仅排队号/日期/时间/状态/资源", keys <= allowed, f"keys={sorted(keys)}")
check("privacy=1 无任何可溯源字段", not (keys & forbidden), f"leak={sorted(keys & forbidden)}")
check("排队号格式 A01", all(re.fullmatch(r"A\d{2}", it["queue_no"]) for it in items),
      f"sample={[it['queue_no'] for it in items[:5]]}")
check("按日期+开始时间排序", items == sorted(items, key=lambda x: (x["date"], x["start_at"])))
# 每天从 A01 重新连续编号
by_day = {}
for it in items:
    by_day.setdefault(it["date"], []).append(it["queue_no"])
seq_ok = all(qs == [f"A{i + 1:02d}" for i in range(len(qs))] for qs in by_day.values())
check("排队号每天从 A01 连续编号", seq_ok, f"by_day={by_day}")
check("公示状态枚举", all(it["status"] in {"等待中", "准备中", "试验中", "已完成"} for it in items),
      f"statuses={sorted({it['status'] for it in items})}")
check("不含已取消", all(it["status"] != "已取消" for it in items))

# ---------- privacy=0：控制室完整字段 ----------
st, d0 = req("GET", "/schedules/display?days=2&privacy=0", token=operator)
check("display privacy=0 可读", st == 200, f"st={st}")
items0 = d0["items"]
check("privacy=0 含标题", all("title" in it for it in items0))
named = [it for it in items0 if it.get("project_name")]
check("privacy=0 join 出项目名", len(named) >= 5 and any("HF-2026-01" in it["project_name"] for it in named),
      f"sample={named[0]['project_name'] if named else None}")
check("privacy=0 join 出订单名", any("WD-2026-001" in (it.get("order_name") or "") for it in items0))
check("privacy=0 不含 note", all("note" not in it for it in items0))
check("privacy=0 排队号与 privacy=1 一致",
      [(it["date"], it["queue_no"]) for it in items0] == [(it["date"], it["queue_no"]) for it in items])

# ---------- 权限：客户 403 / 未登录 401 ----------
st, _ = req("GET", "/schedules/display?days=2&privacy=1", token=customer)
check("客户访问 display 403", st == 403, f"st={st}")
st, _ = req("GET", "/schedules/display?days=2&privacy=0", token=customer)
check("客户访问 display(privacy=0) 403", st == 403, f"st={st}")
st, _ = req("GET", "/schedules/display")
check("未登录 401", st == 401, f"st={st}")

# ---------- 排程 CRUD 不回归（快速建删一条） ----------
st, row = req("POST", "/schedules", {
    "title": "冒烟-临时排程", "resource": "风洞洞体",
    "start_at": f"{today.date().isoformat()}T19:00", "end_at": f"{today.date().isoformat()}T20:00",
}, token=maintainer)
check("维护员建排程", st == 200 and row.get("id"), f"st={st}")
st, upd = req("PUT", f"/schedules/{row['id']}", {"status": "已确认"}, token=maintainer)
check("维护员改排程", st == 200 and upd["status"] == "已确认", f"st={st}")
st, _ = req("DELETE", f"/schedules/{row['id']}", token=maintainer)
check("维护员删排程", st == 200, f"st={st}")
st, _ = req("POST", "/schedules", {
    "title": "x", "start_at": f"{today.date().isoformat()}T19:00", "end_at": f"{today.date().isoformat()}T20:00",
}, token=operator)
check("操作员写排程仍 403", st == 403, f"st={st}")

print("\n排程展示大屏冒烟全部通过")
