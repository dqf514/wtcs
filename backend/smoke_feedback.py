# -*- coding: utf-8 -*-
"""反馈系统冒烟：提交 → 5分钟限流 429 → 权限（operator 读列表 403）→ admin 列表/截图/改状态/删除。

用法: python smoke_feedback.py   （需后端运行在 127.0.0.1:8000）
"""
import json
import io
import urllib.request
import urllib.error
import urllib.parse
import uuid

from PIL import Image

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


def req_json(method: str, path: str, token: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def post_feedback(token: str, content: str, with_image: bool = False):
    boundary = uuid.uuid4().hex
    parts = []

    def field(name, value):
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )

    field("content", content)
    field("email", "tester@example.com")
    field("page_url", "/dashboard")
    if with_image:
        buf = io.BytesIO()
        Image.new("RGB", (32, 32), (200, 30, 30)).save(buf, format="PNG")
        png = buf.getvalue()
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"s.png\"\r\n"
            f"Content-Type: image/png\r\n\r\n".encode()
            + png
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    data = b"".join(parts)
    req = urllib.request.Request(
        f"{BASE}/feedback", data=data, method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def get_raw(path: str, token: str):
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    print("== 反馈系统冒烟 ==")
    op = login("operator")
    admin = login("admin")

    # 0. 幂等：清理历史冒烟数据（同时解除限流冷却）
    s, rows = req_json("GET", "/feedback", admin)
    for r in rows if isinstance(rows, list) else []:
        if str(r.get("content", "")).startswith("smoke:"):
            req_json("DELETE", f"/feedback/{r['id']}", admin)

    # 1. operator 提交（不带图）
    s, b = post_feedback(op, "smoke: 风机启动按钮点击无反应")
    check("operator 提交反馈", s == 200 and b.get("ok"), f"got {s} {b}")
    fb_id = b.get("id", "")

    # 2. 立即重复提交 → 429 限流
    s, b = post_feedback(op, "smoke: 重复提交应被限流")
    check("5分钟限流 429", s == 429, f"got {s} {b}")

    # 3. 未登录提交 → 401
    s, _ = post_feedback("", "anonymous")
    check("未登录 401/403", s in (401, 403), f"got {s}")

    # 4. operator 读列表 → 403
    s, _ = req_json("GET", "/feedback", op)
    check("operator 读列表 403", s == 403, f"got {s}")

    # 5. admin 列表可见
    s, rows = req_json("GET", "/feedback", admin)
    mine = [r for r in (rows if isinstance(rows, list) else []) if r.get("id") == fb_id]
    check("admin 列表可见", s == 200 and len(mine) == 1, f"got {s}")
    if mine:
        r = mine[0]
        check("字段完整", r.get("username") == "operator" and r.get("status") == "未处理"
              and r.get("email") == "tester@example.com" and r.get("page_url") == "/dashboard"
              and r.get("has_screenshot") == 0, json.dumps(r, ensure_ascii=False)[:200])

    # 6. admin 提交带截图（admin 此前无反馈，不触发限流）
    s, b = post_feedback(admin, "smoke: 带截图反馈", with_image=True)
    check("admin 带截图提交", s == 200 and b.get("ok"), f"got {s} {b}")
    fb2 = b.get("id", "")

    # 7. admin 读截图 → 200 且为 PNG；operator 读 → 403
    s, raw = get_raw(f"/feedback/{fb2}/screenshot", admin)
    check("admin 读截图 PNG", s == 200 and raw[:4] == b"\x89PNG", f"got {s}")
    s, _ = get_raw(f"/feedback/{fb2}/screenshot", op)
    check("operator 读截图 403", s == 403, f"got {s}")

    # 8. admin 改状态
    s, b = req_json("PUT", f"/feedback/{fb_id}", admin, {"status": "已处理"})
    check("标记已处理", s == 200 and b.get("ok"), f"got {s} {b}")
    s, b = req_json("PUT", f"/feedback/{fb_id}", admin, {"status": "乱写的"})
    check("非法状态 400", s == 400, f"got {s}")

    # 9. 状态过滤
    s, rows = req_json("GET", "/feedback?status=" + urllib.parse.quote("已处理"), admin)
    ids = [r["id"] for r in rows] if isinstance(rows, list) else []
    check("按状态过滤", s == 200 and fb_id in ids and fb2 not in ids, f"got {s}")

    # 10. 删除（清理冒烟数据）
    s, b = req_json("DELETE", f"/feedback/{fb_id}", admin)
    check("删除反馈", s == 200 and b.get("ok"), f"got {s}")
    s, b = req_json("DELETE", f"/feedback/{fb2}", admin)
    check("删除带图反馈", s == 200 and b.get("ok"), f"got {s}")
    s, raw = get_raw(f"/feedback/{fb2}/screenshot", admin)
    check("删除后截图 404", s == 404, f"got {s}")

    print(f"\n结果: {PASS} PASS / {FAIL} FAIL")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
