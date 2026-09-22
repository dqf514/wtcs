# -*- coding: utf-8 -*-
"""客户管理冒烟：客户 CRUD / code 重复 409 / 删除保护 400 / 项目订单关联 customer_name / 权限矩阵。

幂等演示数据：HF-001 示例汽车科技（关联 customer 账号）、HF-002 合肥风洞演示客户（无关联账号），
并把演示项目 HF-2026-01、订单 WD-2026-001 关联到 HF-001（已关联则跳过）。
"""
import json
import sys
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
otoken = login["access_token"]
_, login_m = req("POST", "/auth/login", {"username": "maintainer", "password": "wtcs123"})
mtoken = login_m["access_token"]
_, login_a = req("POST", "/auth/login", {"username": "admin", "password": "wtcs123"})
atoken = login_a["access_token"]
_, login_c = req("POST", "/auth/login", {"username": "customer", "password": "wtcs123"})
ctoken = login_c["access_token"]
print("登录 ok")

# 页面权限：maintainer/admin 含 customers，operator 不含
_, me_m = req("GET", "/auth/me", token=mtoken)
check("maintainer 页面含 customers", "customers" in me_m.get("pages", []), f"pages={me_m.get('pages')}")
_, me_o = req("GET", "/auth/me", token=otoken)
check("operator 页面不含 customers", "customers" not in me_o.get("pages", []), f"pages={me_o.get('pages')}")

# ---------- 演示客户档案（幂等：按 code 已存在则跳过） ----------
st, custs = req("GET", "/customers", token=atoken)
check("客户列表可读", st == 200, f"st={st} count={len(custs)}")
by_code = {c["code"]: c for c in custs}

if "HF-001" not in by_code:
    st, c1 = req("POST", "/customers", {
        "code": "HF-001", "name": "示例汽车科技", "contact": "王工", "phone": "13800000001",
        "email": "wang@example-auto.com", "address": "合肥市经开区演示路 1 号",
        "notes": "演示客户：关联 customer 登录账号", "username": "customer",
    }, atoken)
    check("创建演示客户 HF-001", st == 200 and c1.get("id"), f"st={st}")
    by_code["HF-001"] = c1
else:
    print("[PASS] 演示客户 HF-001 已存在")

if "HF-002" not in by_code:
    st, c2 = req("POST", "/customers", {
        "code": "HF-002", "name": "合肥风洞演示客户", "contact": "李工", "phone": "13800000002",
        "notes": "演示客户：无关联登录账号",
    }, atoken)
    check("创建演示客户 HF-002", st == 200 and c2.get("id"), f"st={st}")
    by_code["HF-002"] = c2
else:
    print("[PASS] 演示客户 HF-002 已存在")

hf1 = by_code["HF-001"]
check("HF-001 关联 customer 账号", hf1.get("username") == "customer", f"username={hf1.get('username')}")

# ---------- 演示客户行业/职务回填（幂等：只补空字段） ----------
if not hf1.get("industry") or not hf1.get("contact_title"):
    st, hf1 = req("PUT", f"/customers/{hf1['id']}", {
        "industry": hf1.get("industry") or "整车厂",
        "contact_title": hf1.get("contact_title") or "试验主管",
    }, atoken)
    check("HF-001 回填行业/职务", st == 200 and hf1.get("industry") == "整车厂" and hf1.get("contact_title") == "试验主管", f"st={st}")
else:
    print("[PASS] HF-001 行业/职务已填")
check("HF-001 行业=整车厂", hf1.get("industry") == "整车厂", f"industry={hf1.get('industry')}")

hf2 = by_code["HF-002"]
if not hf2.get("industry"):
    st, hf2 = req("PUT", f"/customers/{hf2['id']}", {"industry": "科研院所"}, atoken)
    check("HF-002 回填行业", st == 200 and hf2.get("industry") == "科研院所", f"st={st}")
else:
    print("[PASS] HF-002 行业已填")
check("HF-002 行业=科研院所", hf2.get("industry") == "科研院所", f"industry={hf2.get('industry')}")

# 关联账号校验：不存在的账号 400、非客户角色账号 400
st, _ = req("POST", "/customers", {"code": "HF-900-X", "name": "x", "username": "no_such_user"}, mtoken)
check("关联不存在账号 400", st == 400, f"st={st}")
st, _ = req("POST", "/customers", {"code": "HF-900-X", "name": "x", "username": "operator"}, mtoken)
check("关联非客户角色账号 400", st == 400, f"st={st}")

# 重复 code → 409
st, dup = req("POST", "/customers", {"code": "HF-001", "name": "重复编号"}, mtoken)
check("重复 code 409", st == 409, f"st={st} body={dup}")

# ---------- 演示项目/订单关联到 HF-001（幂等） ----------
st, projs = req("GET", "/projects", token=atoken)
proj = next((p for p in projs if p["project_no"] == "HF-2026-01"), None)
check("演示项目 HF-2026-01 存在", proj is not None)
if proj.get("customer_id") != hf1["id"]:
    st, proj = req("PUT", f"/projects/{proj['id']}", {"customer_id": hf1["id"]}, atoken)
    check("项目关联 HF-001", st == 200 and proj.get("customer_id") == hf1["id"], f"st={st}")
else:
    print("[PASS] 项目已关联 HF-001")
check("项目 customer_name", proj.get("customer_name") == "示例汽车科技", f"customer_name={proj.get('customer_name')}")
check("项目自动带出账号", proj.get("customer_username") == "customer", f"customer_username={proj.get('customer_username')}")

st, orders = req("GET", "/orders", token=atoken)
wd = next((o for o in orders if o["order_no"] == "WD-2026-001"), None)
check("演示订单 WD-2026-001 存在", wd is not None)
if wd.get("customer_id") != hf1["id"]:
    st, wd = req("PUT", f"/orders/{wd['id']}", {"customer_id": hf1["id"]}, atoken)
    check("订单关联 HF-001", st == 200 and wd.get("customer_id") == hf1["id"], f"st={st}")
else:
    print("[PASS] 订单已关联 HF-001")
check("订单 customer_name", wd.get("customer_name") == "示例汽车科技", f"customer_name={wd.get('customer_name')}")

# 名下有项目/订单 → 删除 400（admin）
st, d = req("DELETE", f"/customers/{hf1['id']}", token=atoken)
check("名下有项目删除 400", st == 400, f"st={st} body={d}")

# 列表计数
st, custs = req("GET", "/customers", token=atoken)
hf1_row = next(c for c in custs if c["code"] == "HF-001")
check("列表项目/订单计数", hf1_row.get("project_count", 0) >= 1 and hf1_row.get("order_count", 0) >= 1,
      f"counts={hf1_row.get('project_count')}/{hf1_row.get('order_count')}")

# 详情：名下项目/订单列表
st, detail = req("GET", f"/customers/{hf1['id']}", token=atoken)
check("客户详情含项目/订单", st == 200
      and any(p["project_no"] == "HF-2026-01" for p in detail.get("projects", []))
      and any(o["order_no"] == "WD-2026-001" for o in detail.get("orders", [])),
      f"st={st}")

# ---------- 新建项目/订单带 customer_id → list 返回 customer_name ----------
st, tp = req("POST", "/projects", {
    "project_no": "HF-SMOKE-CUST", "name": "客户关联冒烟项目",
    "customer_username": "admin", "customer_id": hf1["id"],
}, mtoken)
check("带 customer_id 建项目", st == 200 and tp.get("customer_id") == hf1["id"], f"st={st}")
check("建项目自动带出账号", tp.get("customer_username") == "customer", f"customer_username={tp.get('customer_username')}")
st, projs = req("GET", "/projects", token=mtoken)
tp_row = next((p for p in projs if p["project_no"] == "HF-SMOKE-CUST"), None)
check("项目列表 customer_name", tp_row and tp_row.get("customer_name") == "示例汽车科技",
      f"customer_name={tp_row and tp_row.get('customer_name')}")

st, to = req("POST", "/orders", {
    "order_no": "WD-SMOKE-CUST", "title": "客户关联冒烟订单",
    "customer_username": "admin", "customer_id": hf1["id"],
}, mtoken)
check("带 customer_id 建订单", st == 200 and to.get("customer_id") == hf1["id"], f"st={st}")
check("建订单自动带出账号", to.get("customer_username") == "customer", f"customer_username={to.get('customer_username')}")
st, orders = req("GET", "/orders", token=mtoken)
to_row = next((o for o in orders if o["order_no"] == "WD-SMOKE-CUST"), None)
check("订单列表 customer_name", to_row and to_row.get("customer_name") == "示例汽车科技",
      f"customer_name={to_row and to_row.get('customer_name')}")

# 不存在的 customer_id → 400
st, _ = req("POST", "/projects", {
    "project_no": "HF-SMOKE-BAD", "name": "x", "customer_username": "admin", "customer_id": "no_such_id",
}, mtoken)
check("不存在 customer_id 400", st == 400, f"st={st}")

# 清理冒烟项目/订单（先订单后项目）
st, _ = req("DELETE", f"/orders/{to['id']}", token=mtoken)
check("清理冒烟订单", st == 200, f"st={st}")
st, _ = req("DELETE", f"/projects/{tp['id']}", token=mtoken)
check("清理冒烟项目", st == 200, f"st={st}")

# ---------- 临时客户 CRUD ----------
st, tmp = req("POST", "/customers", {
    "code": "HF-SMOKE-01", "name": "冒烟测试客户", "contact": "测试员", "phone": "0551-0000000",
}, mtoken)
check("维护员创建客户", st == 200 and tmp.get("id"), f"st={st}")
st, tmp2 = req("PUT", f"/customers/{tmp['id']}", {"name": "冒烟测试客户v2", "contact": "测试员乙"}, mtoken)
check("维护员更新客户", st == 200 and tmp2.get("name") == "冒烟测试客户v2", f"st={st}")
st, g = req("GET", f"/customers/{tmp['id']}", token=otoken)
check("操作员可读客户详情", st == 200 and g.get("code") == "HF-SMOKE-01", f"st={st}")

# operator 写 403
st, _ = req("POST", "/customers", {"code": "HF-SMOKE-02", "name": "越权"}, otoken)
check("操作员创建 403", st == 403, f"st={st}")
st, _ = req("PUT", f"/customers/{tmp['id']}", {"name": "越权"}, otoken)
check("操作员更新 403", st == 403, f"st={st}")
# 删除仅 admin：维护员 403，admin 200
st, _ = req("DELETE", f"/customers/{tmp['id']}", token=mtoken)
check("维护员删除 403", st == 403, f"st={st}")
st, _ = req("DELETE", f"/customers/{tmp['id']}", token=atoken)
check("管理员删除客户", st == 200, f"st={st}")

# ---------- 客户角色：只能看到本人档案 ----------
st, clist = req("GET", "/customers", token=ctoken)
check("客户只见本人档案", st == 200 and len(clist) == 1 and clist[0]["code"] == "HF-001",
      f"st={st} list={[c['code'] for c in clist] if isinstance(clist, list) else clist}")
st, _ = req("GET", f"/customers/{by_code['HF-002']['id']}", token=ctoken)
check("客户访问他人档案 403", st == 403, f"st={st}")
st, own = req("GET", f"/customers/{hf1['id']}", token=ctoken)
check("客户可读本人档案", st == 200 and own.get("code") == "HF-001", f"st={st}")

print("\n客户管理冒烟全部通过")
