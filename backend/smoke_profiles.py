# -*- coding: utf-8 -*-
"""用户/客户档案字段冒烟：档案字段 CRUD 回读一致 / operator 访问用户管理 403 / 演示档案断言。

前置：后端已启动（启动时 ensure_default_users 幂等回填内置账号演示档案）；
HF-001 演示客户由 smoke_customers.py 播种，本脚本若缺失则自建并回填行业。
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
_, login_a = req("POST", "/auth/login", {"username": "admin", "password": "wtcs123"})
atoken = login_a["access_token"]
print("登录 ok")

# ---------- 用户档案字段：创建/更新后 GET 回读一致 ----------
PROFILE = {
    "phone": "13800000999",
    "email": "smoke@wtcs.local",
    "company": "合肥汽车风洞",
    "department": "试验部",
    "position": "测试工程师",
    "notes": "smoke_profiles 临时账号",
}
st, _ = req("POST", "/admin/users", {
    "username": "smoke_profile", "password": "smoke123", "display_name": "档案冒烟", "role": "操作员",
    **PROFILE,
}, atoken)
check("创建带档案用户", st == 200, f"st={st}")

st, users = req("GET", "/admin/users", token=atoken)
row = next((u for u in users if u["username"] == "smoke_profile"), None)
check("GET 用户返回档案字段", row is not None and all(row.get(k) == v for k, v in PROFILE.items()),
      f"row={ {k: row.get(k) for k in PROFILE} if row else None }")

PATCH = {"department": "运维部", "position": "值班工程师", "notes": "已更新"}
st, _ = req("PUT", "/admin/users/smoke_profile", PATCH, atoken)
check("更新用户档案字段", st == 200, f"st={st}")
st, users = req("GET", "/admin/users", token=atoken)
row = next((u for u in users if u["username"] == "smoke_profile"), None)
check("更新后 GET 一致", row is not None and all(row.get(k) == v for k, v in PATCH.items())
      and row.get("company") == "合肥汽车风洞",
      f"row={ {k: row.get(k) for k in ('department', 'position', 'notes', 'company')} if row else None }")

st, _ = req("DELETE", "/admin/users/smoke_profile", token=atoken)
check("清理临时用户", st == 200, f"st={st}")

# ---------- operator 访问 /admin/users 403 ----------
st, _ = req("GET", "/admin/users", token=otoken)
check("operator 访问用户管理 403", st == 403, f"st={st}")

# ---------- 演示档案断言（启动 seed 幂等回填） ----------
st, users = req("GET", "/admin/users", token=atoken)
admin_row = next(u for u in users if u["username"] == "admin")
check("admin 部门非空", bool(admin_row.get("department")), f"department={admin_row.get('department')}")
cust_row = next(u for u in users if u["username"] == "customer")
check("customer 外部账号公司", cust_row.get("company") == "示例汽车科技", f"company={cust_row.get('company')}")

# ---------- 客户行业/职务字段：创建/更新后回读一致 ----------
st, tmp = req("POST", "/customers", {
    "code": "HF-SMOKE-PROF", "name": "档案冒烟客户", "contact": "张三",
    "industry": "零部件", "contact_title": "项目经理",
}, atoken)
check("创建带行业/职务客户", st == 200 and tmp.get("industry") == "零部件" and tmp.get("contact_title") == "项目经理", f"st={st}")
st, g = req("GET", f"/customers/{tmp['id']}", token=atoken)
check("客户详情回读行业/职务", st == 200 and g.get("industry") == "零部件" and g.get("contact_title") == "项目经理", f"st={st}")
st, g2 = req("PUT", f"/customers/{tmp['id']}", {"industry": "高校", "contact_title": "教授"}, atoken)
check("更新客户行业/职务", st == 200 and g2.get("industry") == "高校" and g2.get("contact_title") == "教授", f"st={st}")
st, _ = req("DELETE", f"/customers/{tmp['id']}", token=atoken)
check("清理临时客户", st == 200, f"st={st}")

# ---------- 演示客户 HF-001 行业断言（缺失则自建回填，幂等） ----------
st, custs = req("GET", "/customers", token=atoken)
hf1 = next((c for c in custs if c["code"] == "HF-001"), None)
if hf1 is None:
    st, hf1 = req("POST", "/customers", {
        "code": "HF-001", "name": "示例汽车科技", "contact": "王工", "phone": "13800000001",
        "industry": "整车厂", "contact_title": "试验主管", "username": "customer",
    }, atoken)
    check("自建演示客户 HF-001", st == 200, f"st={st}")
elif not hf1.get("industry"):
    st, hf1 = req("PUT", f"/customers/{hf1['id']}", {
        "industry": "整车厂", "contact_title": hf1.get("contact_title") or "试验主管",
    }, atoken)
    check("HF-001 回填行业", st == 200, f"st={st}")
check("HF-001 行业=整车厂", hf1.get("industry") == "整车厂", f"industry={hf1.get('industry')}")

print("\n档案字段冒烟全部通过")
