# -*- coding: utf-8 -*-
"""第二阶段冒烟脚本：矩阵执行 → runs/samples/summary → pause/resume/abort → 409 → 报告 → cleanup。"""
import json
import sys
import threading
import time
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8001/api"


def req(method, path, body=None, token=None, raw=False):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload.decode("utf-8")))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def check(name, cond, extra=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {extra}")
    if not cond:
        sys.exit(1)


_, login = req("POST", "/auth/login", {"username": "operator", "password": "wtcs123"})
token = login["access_token"]
print("登录 ok")

# 1. 建实验
st, exp = req("POST", "/experiments", {
    "title": "矩阵冒烟实验", "scenario": "气动实验", "wind_speed": 30, "belt_speed": 25,
    "traverse_x": 120, "traverse_y": 60, "traverse_z": 30, "duration_sec": 2,
}, token)
check("创建实验", st == 200 and exp.get("id"), f"id={exp.get('id')}")
exp_id = exp["id"]

# 2. 建矩阵（2 行工况，第 2 行 repeat=2，duration 2s）
st, m = req("POST", "/matrices", {
    "name": "冒烟矩阵A", "scenario": "气动实验", "on_error": "abort",
    "conditions": [
        {"wind_speed": 20, "temperature": 25, "yaw_angle": 0, "belt_speed": 18,
         "traverse_x": 100, "traverse_y": 50, "traverse_z": 20, "duration_sec": 2, "repeat": 1},
        {"wind_speed": 25, "temperature": 26, "yaw_angle": 5,
         "traverse_x": 150, "traverse_y": 60, "traverse_z": 30, "duration_sec": 2, "repeat": 2},
    ],
}, token)
check("创建矩阵", st == 200 and m.get("version") == 1, f"id={m.get('id')}")
mid = m["id"]

# 3. 并发互斥：先启动矩阵，再启动第二个矩阵 → 409
st, run = req("POST", f"/matrices/{mid}/run", {"experiment_id": exp_id}, token)
check("启动矩阵", st == 200 and run.get("status") == "running", f"total={run.get('total_rows')}")
check("总行数=3（1+2 repeat）", run.get("total_rows") == 3)

st, m2 = req("POST", "/matrices", {"name": "冒烟矩阵B", "conditions": [{"wind_speed": 10, "duration_sec": 1}]}, token)
mid2 = m2["id"]
st, conflict = req("POST", f"/matrices/{mid2}/run", None, token)
check("并发第二个矩阵 → 409", st == 409, f"got {st}")

# 4. 轮询 status 等待完成
t0 = time.time()
last = None
while time.time() - t0 < 240:
    st, s = req("GET", f"/matrices/{mid}/status", token=token)
    if s.get("progress") != last:
        print(f"  进度 {s.get('progress')} status={s.get('status')} eta={s.get('eta_seconds')}")
        last = s.get("progress")
    if s.get("status") in ("completed", "failed", "aborted"):
        break
    time.sleep(2)
check("矩阵执行完成", s.get("status") == "completed", f"status={s.get('status')}")
check("全部行完成", all(r["status"] == "completed" for r in s.get("rows", [])))
run_ids = [r["run_id"] for r in s["rows"]]
check("每行都有 run_id", all(run_ids), f"runs={run_ids}")

# 5. runs / samples / summary
st, runs = req("GET", f"/experiments/{exp_id}/runs", token=token)
check("实验 runs 列表=3", st == 200 and len(runs) == 3, f"n={len(runs)}")
rid = run_ids[0]
st, rdetail = req("GET", f"/runs/{rid}", token=token)
check("run 详情含配置快照", st == 200 and rdetail["config"].get("wind_speed") == 20 and rdetail.get("config_hash"))
st, samples = req("GET", f"/runs/{rid}/samples", token=token)
n_full = samples["count"]
check("采样数据非空", st == 200 and n_full > 5, f"count={n_full}")
ch0 = samples["samples"][0]["channels"]
check("含三类通道组", all(g in ch0 for g in ("balance", "pressure", "acoustic", "env")), f"groups={list(ch0)}")
check("天平六分量", all(k in ch0["balance"] for k in ("fx", "fy", "fz", "mx", "my", "mz")))
st, sf = req("GET", f"/runs/{rid}/samples?channels=balance&downsample=5", token=token)
check("通道过滤+降采样", st == 200 and "pressure" not in sf["samples"][0]["channels"] and sf["count"] < n_full,
      f"{sf['count']} < {n_full}")
st, summ = req("GET", f"/runs/{rid}/summary", token=token)
fx = summ["stats"]["balance"]["fx"]
check("summary 统计齐全", st == 200 and all(k in fx for k in ("mean", "max", "min", "std")))
check("Cd/Cl 系数换算", "Cd" in summ.get("coefficients", {}), f"Cd={summ['coefficients'].get('Cd')} Cl={summ['coefficients'].get('Cl')}")

# 6. 第二个矩阵验证 pause/resume/abort
st, run2 = req("POST", f"/matrices/{mid2}/run", None, token)
check("启动矩阵B", st == 200)
st, p = req("POST", f"/matrices/{mid2}/pause", None, token)
check("pause → paused", st == 200 and p["status"] == "paused")
st, s1 = req("GET", f"/matrices/{mid2}/status", token=token)
check("status=paused", s1["status"] == "paused")
st, r = req("POST", f"/matrices/{mid2}/resume", None, token)
check("resume → running", st == 200 and r["status"] == "running")
st, a = req("POST", f"/matrices/{mid2}/abort", None, token)
check("abort 接受", st == 200)
t0 = time.time()
while time.time() - t0 < 60:
    st, s2 = req("GET", f"/matrices/{mid2}/status", token=token)
    if s2["status"] in ("aborted", "failed", "completed"):
        break
    time.sleep(1)
check("矩阵B aborted", s2["status"] == "aborted", f"status={s2['status']}")

# 7. 实验流水线中止（phase=aborted 联动）
st, exp2 = req("POST", "/experiments", {
    "title": "中止冒烟实验", "scenario": "气动实验", "wind_speed": 40, "duration_sec": 30}, token)
e2 = exp2["id"]
st, _ = req("POST", f"/experiments/{e2}/phase?phase=" + urllib.parse.quote("工况设置"), None, token)

pipe_result = {}
def run_pipe():
    st_, body_ = req("POST", f"/experiments/{e2}/run", None, token)
    pipe_result["st"] = st_
    pipe_result["phase"] = body_.get("phase") if isinstance(body_, dict) else None
th = threading.Thread(target=run_pipe, daemon=True)
th.start()
time.sleep(6)  # 等流水线进入就绪/采集前
st, ab = req("POST", f"/experiments/{e2}/phase?phase=" + urllib.parse.quote("已中止"), None, token)
check("phase=aborted 接受", st == 200, f"phase={ab.get('phase')}")
th.join(timeout=90)
check("流水线中止返回", pipe_result.get("st") == 200 and pipe_result.get("phase") == "已中止",
      f"st={pipe_result.get('st')} phase={pipe_result.get('phase')}")

# 8. 矩阵 PUT 版本号 + 历史快照
st, mu = req("PUT", f"/matrices/{mid}", {"name": "冒烟矩阵A-v2"}, token)
check("PUT version+1", st == 200 and mu["version"] == 2 and len(mu["history"]) == 1, f"v={mu.get('version')}")

# 9. 报告（关联实验，应含 run 统计 + SVG）
st, rep = req("POST", "/reports", {"title": "第二阶段冒烟报告", "experiment_id": exp_id}, token)
check("生成报告", st == 200 and rep.get("id"))
st, rdoc = req("GET", f"/reports/{rep['id']}", token=token)
html = rdoc.get("html", "")
check("报告含 run 统计", "统计摘要" in html and "Cd=" in html)
check("报告含 SVG 图表", html.count("<svg") >= 2, f"svg={html.count('<svg')}")
check("报告含可复现声明", "可复现" in html and "SHA-256" in html)
check("报告含配置快照", "配置快照" in html)

# 10. cleanup（需 admin/maintainer 角色）
_, alogin = req("POST", "/auth/login", {"username": "admin", "password": "wtcs123"})
st, cl = req("POST", "/system/cleanup", None, alogin["access_token"])
check("cleanup 不报错", st == 200 and cl.get("ok"), f"removed={cl.get('removed')}")

# 11. DELETE 矩阵
st, _ = req("DELETE", f"/matrices/{mid2}", None, token)
check("删除矩阵B", st == 200)

print("\n全部冒烟通过")
