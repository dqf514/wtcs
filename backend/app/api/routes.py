from __future__ import annotations

import asyncio
import io
import logging
import math
import platform
import re
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.adapters.registry import registry
from app.contracts.icd import CONTRACTS, contract_as_dict
from app.contracts.semantics import all_point_meta
from app.core.auth import (
    authenticate,
    change_password,
    current_user,
    decode_token,
    hash_password,
    require_page,
    require_roles,
    role_level,
    role_pages,
)
from app.core.config import DATA_DIR, settings
from app.models.schemas import (
    CommandRequest,
    ConnMode,
    CustomerIn,
    CustomerUpdate,
    ExperimentCreate,
    ExperimentPhase,
    LoginRequest,
    MatrixCreate,
    MatrixRunRequest,
    MatrixUpdate,
    OrderIn,
    OrderUpdate,
    ProfileIn,
    ProfileUpdate,
    ProjectIn,
    ProjectUpdate,
    Role,
    RoleUpdate,
    RoleUpsert,
    ScheduleIn,
    ScheduleUpdate,
    SubsystemId,
    UserCreate,
    UserInfo,
    UserUpdate,
    local_now,
)
from app.services import backup as backup_svc
from app.services import mqtt_pub
from app.services.extras import build_report_html, compute_run_summary, nl_query, run_ai_inspection, twin_snapshot
from app.services.health import health as health_svc
from app.services.orchestration import validate_steps
from app.services.interlocks import ExprError, validate_rule
from app.services.coordination import apply_linkage, preview_linkage
from app.services.runtime import hub
from app.services.store import WIDE_POINT_KEYS, store

logger = logging.getLogger(__name__)

router = APIRouter()


class NlAsk(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class ReportCreate(BaseModel):
    title: str = "风洞实验运行报告"
    experiment_id: str | None = None


class PasswordChange(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class SettingsPatch(BaseModel):
    theme: str | None = Field(default=None, max_length=32)
    default_scenario: str | None = Field(default=None, max_length=64)
    language: Literal["zh", "en"] | None = None
    large_screen_refresh_ms: int | None = Field(default=None, ge=100, le=60000)
    telemetry_hz: int | None = Field(default=None, ge=1, le=20)
    history_retention_days: int | None = Field(default=None, ge=1, le=3650)
    audit_retention_days: int | None = Field(default=None, ge=1, le=3650)
    alert_retention_count: int | None = Field(default=None, ge=100, le=100000)
    ai_inspect_enabled: bool | None = None
    ai_inspect_interval_sec: int | None = Field(default=None, ge=2, le=3600)
    force_simulation: bool | None = None
    auto_backup_enabled: bool | None = None
    auto_backup_interval_hours: int | None = Field(default=None, ge=1, le=720)
    # 健康基线
    health_learning_enabled: bool | None = None
    health_eval_interval_sec: int | None = Field(default=None, ge=1, le=60)
    health_min_samples: int | None = Field(default=None, ge=5, le=10000)
    # MQTT 开放数据通道（可选，需安装 paho-mqtt）
    mqtt_enabled: bool | None = None
    mqtt_host: str | None = Field(default=None, max_length=128)
    mqtt_port: int | None = Field(default=None, ge=1, le=65535)
    mqtt_topic_prefix: str | None = Field(default=None, max_length=64)
    # 兼容旧字段名
    ai_inspection_enabled: bool | None = None


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "message": "WTCS 服务正常"}


@router.post("/auth/login")
async def login(body: LoginRequest):
    return await authenticate(body.username, body.password)


@router.get("/auth/me")
async def me(user: Annotated[UserInfo, Depends(current_user)]):
    # 附加当前角色的页面权限列表（前端菜单裁剪用）；角色找不到时按内置默认/空集
    return {**user.model_dump(), "pages": await role_pages(user.role)}


@router.put("/auth/password")
async def put_password(
    body: PasswordChange,
    user: Annotated[UserInfo, Depends(current_user)],
):
    await change_password(user.username, body.old_password, body.new_password)
    await hub.audit.add(user.username, user.role, "修改密码", user.username, None)
    return {"ok": True}


# ---------- 用户管理（管理员） ----------

@router.get("/admin/users")
async def admin_list_users(user: Annotated[UserInfo, Depends(require_roles(Role.admin))]):
    rows = await store.list_users()
    for r in rows:
        r.pop("password_hash", None)
        r["enabled"] = bool(r.get("enabled", 1))
    return rows


@router.post("/admin/users")
async def admin_create_user(
    body: UserCreate,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if await store.get_user(body.username) is not None:
        raise HTTPException(400, "用户名已存在")
    if await store.get_role(body.role) is None:
        raise HTTPException(400, f"角色不存在: {body.role}")
    await store.upsert_user(
        body.username,
        hash_password(body.password),
        body.display_name,
        body.role,
        phone=body.phone,
        email=body.email,
        company=body.company,
        department=body.department,
        position=body.position,
        notes=body.notes,
    )
    await hub.audit.add(user.username, user.role, "创建用户", f"{body.username}（{body.role}）", None)
    logger.info("用户创建: %s（%s）by %s", body.username, body.role, user.username)
    return {"ok": True, "username": body.username}


@router.put("/admin/users/{username}")
async def admin_update_user(
    username: str,
    body: UserUpdate,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if await store.get_user(username) is None:
        raise HTTPException(404, "用户不存在")
    if body.enabled is False and username == user.username:
        raise HTTPException(400, "不能停用自己")
    if body.role is not None and await store.get_role(body.role) is None:
        raise HTTPException(400, f"角色不存在: {body.role}")
    await store.update_user(
        username,
        role=body.role,
        display_name=body.display_name,
        enabled=body.enabled,
        phone=body.phone,
        email=body.email,
        company=body.company,
        department=body.department,
        position=body.position,
        notes=body.notes,
    )
    if body.password:
        await store.set_user_password(username, hash_password(body.password))
    changes = body.model_dump(exclude_none=True)
    changes.pop("password", None)  # 审计不落密码
    await hub.audit.add(user.username, user.role, "更新用户", f"{username}: {changes}" + ("；重置密码" if body.password else ""), None)
    logger.info("用户更新: %s by %s → %s", username, user.username, changes)
    return {"ok": True}


@router.delete("/admin/users/{username}")
async def admin_delete_user(
    username: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if username == user.username:
        raise HTTPException(400, "不能删除自己")
    if not await store.delete_user(username):
        raise HTTPException(404, "用户不存在")
    await hub.audit.add(user.username, user.role, "删除用户", username, None)
    logger.info("用户删除: %s by %s", username, user.username)
    return {"ok": True}


# ---------- 角色权限矩阵（管理员） ----------

@router.get("/admin/roles")
async def admin_list_roles(user: Annotated[UserInfo, Depends(require_roles(Role.admin))]):
    return await store.list_roles()


@router.post("/admin/roles")
async def admin_create_role(
    body: RoleUpsert,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if await store.get_role(body.name) is not None:
        raise HTTPException(400, "角色已存在")
    await store.upsert_role(body.name, body.level, body.pages, builtin=False)
    await hub.audit.add(user.username, user.role, "创建角色", f"{body.name}（level={body.level}）", None)
    logger.info("角色创建: %s level=%s by %s", body.name, body.level, user.username)
    return {"ok": True, "name": body.name}


@router.put("/admin/roles/{name}")
async def admin_update_role(
    name: str,
    body: RoleUpdate,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    role = await store.get_role(name)
    if role is None:
        raise HTTPException(404, "角色不存在")
    level = body.level if body.level is not None else role["level"]
    pages = body.pages if body.pages is not None else role["pages"]
    await store.upsert_role(name, level, pages, builtin=role["builtin"])
    await hub.audit.add(user.username, user.role, "更新角色", f"{name}: level={level} pages={pages}", None)
    logger.info("角色更新: %s by %s", name, user.username)
    return {"ok": True}


@router.delete("/admin/roles/{name}")
async def admin_delete_role(
    name: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    role = await store.get_role(name)
    if role is None:
        raise HTTPException(404, "角色不存在")
    if role["builtin"]:
        raise HTTPException(400, "内置角色不可删除")
    n = await store.count_users_by_role(name)
    if n:
        raise HTTPException(400, f"仍有 {n} 个用户使用该角色，无法删除")
    await store.delete_role(name)
    await hub.audit.add(user.username, user.role, "删除角色", name, None)
    logger.info("角色删除: %s by %s", name, user.username)
    return {"ok": True}


# ---------- 订单管理 ----------

async def _is_order_staff(user: UserInfo) -> bool:
    """维护员及以上（等级按 roles 表，回退内置映射）可看/管全部订单。"""
    return await role_level(user.role) >= 2


async def _can_view_all(user: UserInfo, page: str) -> bool:
    """模块全量可见：维护员+，或等级≥1 且角色矩阵勾选了该页面的内部员工。客户永远只看本人。"""
    level = await role_level(user.role)
    if level >= 2:
        return True
    return level >= 1 and page in await role_pages(user.role)


async def _scope_order_write(user: UserInfo, data: dict[str, Any], existing: dict[str, Any] | None = None) -> None:
    """客户角色（等级<1）写项目/订单时的归属约束，就地修改 data：

    - 新建：归属强制锁定为本人（账号与档案），状态保持默认，防止伪造他人记录或自导状态
    - 编辑：只允许动本人记录；归属与状态字段一律剥离（只能改标题/备注等业务字段）
    - 内部员工（等级≥1）不受约束
    """
    if await role_level(user.role) >= 1:
        return
    if existing is not None and existing.get("customer_username") != user.username:
        raise HTTPException(403, "只能操作本人名下的记录")
    for key in ("status", "customer_username", "customer_id"):
        data.pop(key, None)
    if existing is None:
        data["customer_username"] = user.username
        own = await store.get_customer_by_username(user.username)
        data["customer_id"] = own["id"] if own else None


# ---------- 项目管理（页面权限=新建/编辑；客户仅可动本人记录；删除维护员+） ----------

@router.get("/projects")
async def list_projects(
    user: Annotated[UserInfo, Depends(current_user)],
    customer: str | None = Query(default=None, description="管理端按客户账号过滤"),
):
    if await _can_view_all(user, "projects"):
        return await store.list_projects(customer_username=customer)
    # 客户只能看本人项目
    return await store.list_projects(customer_username=user.username)


@router.post("/projects")
async def create_project(
    body: ProjectIn,
    user: Annotated[UserInfo, Depends(require_page("projects"))],
):
    data = body.model_dump()
    await _scope_order_write(user, data)
    await _resolve_customer_link(data)
    try:
        row = await store.create_project(data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(400, f"项目编号已存在: {body.project_no}") from exc
    await hub.audit.add(user.username, user.role, "创建项目", f"{row['project_no']} / {row['name']}（客户 {row['customer_username']}）", None)
    logger.info("项目创建: %s（%s）by %s", row["project_no"], row["id"], user.username)
    return row


@router.get("/projects/{project_id}")
async def get_project(project_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    project = await store.get_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    if not await _can_view_all(user, "projects") and project["customer_username"] != user.username:
        raise HTTPException(403, "无权访问该项目")
    orders = await store.list_orders(project_id=project_id)
    for o in orders:
        o["experiment_count"] = len(await store.list_experiments_by_order(o["id"]))
    return {**project, "orders": orders}


@router.put("/projects/{project_id}")
async def update_project(
    project_id: str,
    body: ProjectUpdate,
    user: Annotated[UserInfo, Depends(require_page("projects"))],
):
    project = await store.get_project(project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    data = body.model_dump(exclude_none=True)
    # 客户角色：仅可编辑本人项目，且归属/状态字段被剥离
    await _scope_order_write(user, data, existing=project)
    # customer_id 传空字符串表示清除客户归属（置 NULL）
    if data.get("customer_id") == "":
        data["customer_id"] = None
    await _resolve_customer_link(data)
    if data:
        try:
            await store.update_project(project_id, data)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(400, f"项目编号已存在: {data.get('project_no')}") from exc
        await hub.audit.add(user.username, user.role, "更新项目", f"{project_id}: {data}", None)
        logger.info("项目更新: %s by %s → %s", project_id, user.username, data)
    return await store.get_project(project_id)


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    project = await store.get_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    orders = await store.list_orders(project_id=project_id)
    if orders:
        raise HTTPException(400, f"项目下仍有 {len(orders)} 个订单，无法删除")
    await store.delete_project(project_id)
    await hub.audit.add(user.username, user.role, "删除项目", f"{project['project_no']} / {project['name']}", None)
    logger.info("项目删除: %s（%s）by %s", project["project_no"], project_id, user.username)
    return {"ok": True}


# ---------- 订单管理 ----------


@router.get("/orders")
async def list_orders(
    user: Annotated[UserInfo, Depends(current_user)],
    customer: str | None = Query(default=None, description="管理端按客户账号过滤"),
):
    if await _can_view_all(user, "orders"):
        return await store.list_orders(customer_username=customer)
    # 客户只能看本人订单
    return await store.list_orders(customer_username=user.username)


@router.post("/orders")
async def create_order(
    body: OrderIn,
    user: Annotated[UserInfo, Depends(require_page("orders"))],
):
    if body.project_id and await store.get_project(body.project_id) is None:
        raise HTTPException(400, "关联项目不存在")
    data = body.model_dump()
    await _scope_order_write(user, data)
    await _resolve_customer_link(data)
    try:
        row = await store.create_order(data)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(400, f"订单编号已存在: {body.order_no}") from exc
    await hub.audit.add(user.username, user.role, "创建订单", f"{row['order_no']} / {row['title']}（客户 {row['customer_username']}）", None)
    logger.info("订单创建: %s（%s）by %s", row["order_no"], row["id"], user.username)
    return row


@router.get("/orders/{order_id}")
async def get_order(order_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    order = await store.get_order(order_id)
    if not order:
        raise HTTPException(404, "订单不存在")
    if not await _can_view_all(user, "orders") and order["customer_username"] != user.username:
        raise HTTPException(403, "无权访问该订单")
    experiments = await store.list_experiments_by_order(order_id)
    return {**order, "experiments": experiments}


@router.put("/orders/{order_id}")
async def update_order(
    order_id: str,
    body: OrderUpdate,
    user: Annotated[UserInfo, Depends(require_page("orders"))],
):
    order = await store.get_order(order_id)
    if order is None:
        raise HTTPException(404, "订单不存在")
    data = body.model_dump(exclude_none=True)
    # 客户角色：仅可编辑本人订单，且归属/状态字段被剥离
    await _scope_order_write(user, data, existing=order)
    # project_id / customer_id 传空字符串表示清除归属（置 NULL）
    for key in ("project_id", "customer_id"):
        if data.get(key) == "":
            data[key] = None
    if data.get("project_id") and await store.get_project(data["project_id"]) is None:
        raise HTTPException(400, "关联项目不存在")
    await _resolve_customer_link(data)
    if data:
        try:
            await store.update_order(order_id, data)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(400, f"订单编号已存在: {data.get('order_no')}") from exc
        await hub.audit.add(user.username, user.role, "更新订单", f"{order_id}: {data}", None)
        logger.info("订单更新: %s by %s → %s", order_id, user.username, data)
    return await store.get_order(order_id)


@router.delete("/orders/{order_id}")
async def delete_order(
    order_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    order = await store.get_order(order_id)
    if not order:
        raise HTTPException(404, "订单不存在")
    await store.delete_order(order_id)
    await hub.audit.add(user.username, user.role, "删除订单", f"{order['order_no']} / {order['title']}", None)
    logger.info("订单删除: %s（%s）by %s", order["order_no"], order_id, user.username)
    return {"ok": True}


# ---------- 客户管理（页面权限=新建/编辑；客户角色仅可编辑本人档案的联系方式字段；删除仅管理员） ----------

# 客户角色编辑本人档案时允许改的字段（身份字段 编号/名称/关联账号 仍由内部员工维护）
CUSTOMER_SELF_EDITABLE = ("contact", "contact_title", "phone", "email", "address", "notes", "industry")

async def _resolve_customer_link(data: dict[str, Any]) -> None:
    """校验 customer_id 存在；档案有关联账号时自动带出到 customer_username。"""
    customer_id = data.get("customer_id")
    if not customer_id:
        return
    customer = await store.get_customer(customer_id)
    if customer is None:
        raise HTTPException(400, "客户档案不存在")
    if customer.get("username"):
        data["customer_username"] = customer["username"]


async def _validate_customer_username(username: str | None) -> None:
    """关联账号必须存在且为客户角色。"""
    if not username:
        return
    row = await store.get_user(username)
    if row is None:
        raise HTTPException(400, f"关联账号不存在: {username}")
    if row["role"] != Role.customer.value:
        raise HTTPException(400, "关联账号必须是客户角色账号")


@router.get("/customers")
async def list_customers(user: Annotated[UserInfo, Depends(current_user)]):
    # 客户角色只能看到关联自己账号的档案
    if _is_customer(user):
        own = await store.get_customer_by_username(user.username)
        return [own] if own else []
    return await store.list_customers()


@router.post("/customers")
async def create_customer(
    body: CustomerIn,
    user: Annotated[UserInfo, Depends(require_page("customers"))],
):
    # 新建客户档案是内部业务动作，客户角色即使有页面权限也不能开新档案
    if await role_level(user.role) < 1:
        raise HTTPException(403, "客户角色不能新建客户档案")
    await _validate_customer_username(body.username)
    try:
        row = await store.create_customer(body.model_dump())
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, f"客户编号已存在: {body.code}") from exc
    await hub.audit.add(user.username, user.role, "创建客户", f"{row['code']} / {row['name']}", None)
    logger.info("客户创建: %s（%s）by %s", row["code"], row["id"], user.username)
    return row


@router.get("/customers/{customer_id}")
async def get_customer(customer_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    customer = await store.get_customer(customer_id)
    if not customer:
        raise HTTPException(404, "客户档案不存在")
    if _is_customer(user) and customer.get("username") != user.username:
        raise HTTPException(403, "无权访问该客户档案")
    projects = await store.list_projects(customer_id=customer_id)
    orders = await store.list_orders(customer_id=customer_id)
    return {**customer, "project_count": len(projects), "order_count": len(orders),
            "projects": projects, "orders": orders}


@router.put("/customers/{customer_id}")
async def update_customer(
    customer_id: str,
    body: CustomerUpdate,
    user: Annotated[UserInfo, Depends(require_page("customers"))],
):
    customer = await store.get_customer(customer_id)
    if customer is None:
        raise HTTPException(404, "客户档案不存在")
    data = body.model_dump(exclude_none=True)
    if await role_level(user.role) < 1:
        # 客户角色：仅可编辑关联本人账号的档案，且只能改联系方式类字段
        if customer.get("username") != user.username:
            raise HTTPException(403, "只能编辑本人的客户档案")
        data = {k: v for k, v in data.items() if k in CUSTOMER_SELF_EDITABLE}
        if not data:
            raise HTTPException(400, "没有可更新的字段")
    # username 传空字符串表示清除账号关联（置 NULL）
    if data.get("username") == "":
        data["username"] = None
    await _validate_customer_username(data.get("username"))
    if data:
        try:
            await store.update_customer(customer_id, data)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, f"客户编号已存在: {data.get('code')}") from exc
        await hub.audit.add(user.username, user.role, "更新客户", f"{customer_id}: {data}", None)
        logger.info("客户更新: %s by %s → %s", customer_id, user.username, data)
    return await store.get_customer(customer_id)


@router.delete("/customers/{customer_id}")
async def delete_customer(
    customer_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    customer = await store.get_customer(customer_id)
    if not customer:
        raise HTTPException(404, "客户档案不存在")
    n_projects, n_orders = await store.count_customer_refs(customer_id)
    if n_projects or n_orders:
        raise HTTPException(400, f"客户名下仍有 {n_projects} 个项目、{n_orders} 个订单，无法删除")
    await store.delete_customer(customer_id)
    await hub.audit.add(user.username, user.role, "删除客户", f"{customer['code']} / {customer['name']}", None)
    logger.info("客户删除: %s（%s）by %s", customer["code"], customer_id, user.username)
    return {"ok": True}


# ---------- 品牌标识（公开读取；上传/恢复默认仅管理员） ----------
# 自定义文件存 data/branding/{kind}.png；缺省回退到 app/static/ 内置图。
# settings 里的 branding_version 用于前端 URL 缓存穿透（?v=N）。

BRANDING_DIR = DATA_DIR / "branding"
BRANDING_STATIC_DIR = Path(__file__).resolve().parents[1] / "static"
BRANDING_KINDS = {"logo": "完整 Logo", "mark": "图标 Logo"}
_BRANDING_VERSION_KEY = "branding_version"
_BRANDING_MAX_BYTES = 5 * 1024 * 1024


def _branding_file(kind: str) -> Path | None:
    custom = BRANDING_DIR / f"{kind}.png"
    if custom.exists():
        return custom
    default = BRANDING_STATIC_DIR / ("logo.png" if kind == "logo" else "logo-mark.png")
    return default if default.exists() else None


async def _bump_branding_version() -> int:
    version = int(await store.get_setting(_BRANDING_VERSION_KEY, 0) or 0) + 1
    await store.set_setting(_BRANDING_VERSION_KEY, version)
    return version


@router.get("/branding")
async def get_branding():
    """品牌资源地址（无需登录：登录页/候客大屏在鉴权前就要展示）。"""
    version = int(await store.get_setting(_BRANDING_VERSION_KEY, 0) or 0)
    return {
        "version": version,
        "logo_url": f"/api/branding/file/logo?v={version}",
        "mark_url": f"/api/branding/file/mark?v={version}",
        "custom": {
            "logo": (BRANDING_DIR / "logo.png").exists(),
            "mark": (BRANDING_DIR / "mark.png").exists(),
        },
    }


@router.get("/branding/file/{kind}")
async def branding_file(kind: str):
    if kind not in BRANDING_KINDS:
        raise HTTPException(404, "未知品牌资源类型")
    path = _branding_file(kind)
    if path is None:
        raise HTTPException(404, "品牌资源不存在")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.post("/branding/{kind}")
async def upload_branding(
    kind: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
    file: UploadFile = File(...),
):
    if kind not in BRANDING_KINDS:
        raise HTTPException(404, "未知品牌资源类型")
    if (file.content_type or "") not in ("image/png", "image/jpeg", "image/webp"):
        raise HTTPException(400, "仅支持 PNG / JPEG / WebP 图片（建议使用透明背景 PNG）")
    content = await file.read()
    if not content:
        raise HTTPException(400, "文件为空")
    if len(content) > _BRANDING_MAX_BYTES:
        raise HTTPException(400, "图片不能超过 5MB")
    BRANDING_DIR.mkdir(parents=True, exist_ok=True)
    target = BRANDING_DIR / f"{kind}.png"
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(content))
        img.load()
        img = img.convert("RGBA")
        img.thumbnail((1024, 1024))
        img.save(target, format="PNG")
    except ImportError:
        # 环境缺 Pillow 时仅接受 PNG 原样保存
        if file.content_type != "image/png":
            raise HTTPException(400, "当前环境仅支持 PNG 上传")
        target.write_bytes(content)
    except Exception as exc:
        raise HTTPException(400, "不是有效的图片文件") from exc
    version = await _bump_branding_version()
    await hub.audit.add(user.username, user.role, "上传品牌标识", f"{BRANDING_KINDS[kind]}", None)
    logger.info("品牌标识更新: %s by %s", kind, user.username)
    return await get_branding() | {"ok": True, "version": version}


@router.delete("/branding/{kind}")
async def reset_branding(
    kind: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if kind not in BRANDING_KINDS:
        raise HTTPException(404, "未知品牌资源类型")
    target = BRANDING_DIR / f"{kind}.png"
    if target.exists():
        target.unlink()
    await _bump_branding_version()
    await hub.audit.add(user.username, user.role, "恢复默认品牌标识", f"{BRANDING_KINDS[kind]}", None)
    return await get_branding() | {"ok": True}


# ---------- 系统状态机与启停序列（总控协调核心） ----------

@router.get("/system/state")
async def get_system_state(user: Annotated[UserInfo, Depends(current_user)]):
    """系统级运行状态（待机/准备中/就绪/运行中/停车中/急停/安全异常），由子系统状态实时聚合。"""
    return hub.system_state


@router.get("/sequences")
async def list_sequences(user: Annotated[UserInfo, Depends(current_user)]):
    return await store.list_sequences()


@router.put("/sequences/{seq_id}")
async def update_sequence(
    seq_id: str,
    body: dict,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    seq = await store.get_sequence(seq_id)
    if seq is None:
        raise HTTPException(404, "序列不存在")
    name = str(body.get("name") or seq["name"])
    steps = body.get("steps", seq["steps"])
    try:
        steps = validate_steps(steps)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    row = await store.upsert_sequence(seq_id, name, seq["kind"], steps, builtin=seq["builtin"], updated_by=user.username)
    await hub.audit.add(user.username, user.role, "更新序列", f"{name}（v{row.get('version')}）", None)
    return row


@router.post("/sequences/{seq_id}/execute")
async def execute_sequence(
    seq_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer))],
):
    seq = await store.get_sequence(seq_id)
    if seq is None:
        raise HTTPException(404, "序列不存在")
    try:
        return await hub.sequences.execute(seq, user.username, user.role)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/sequence-execution")
async def get_sequence_execution(user: Annotated[UserInfo, Depends(current_user)]):
    """进行中或最近一次序列执行的状态（步骤进度）。"""
    return hub.sequences.snapshot() or {"state": "none"}


@router.post("/sequence-execution/abort")
async def abort_sequence_execution(
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer))],
):
    ok = await hub.sequences.abort(user.username, user.role)
    if not ok:
        raise HTTPException(409, "当前没有执行中的序列")
    return {"ok": True}


# ---------- 联锁矩阵（可配置安全联锁：报警/指令拦截/自动停车） ----------

@router.get("/interlocks")
async def list_interlocks(user: Annotated[UserInfo, Depends(current_user)]):
    """联锁规则列表（含触发统计）。实时真值表见遥测帧 interlocks 或 /interlocks/status。"""
    return await store.list_interlocks()


@router.get("/interlocks/status")
async def interlock_status(user: Annotated[UserInfo, Depends(current_user)]):
    """联锁真值表：每条规则的当前 许可/违规 状态（遥测周期求值）。"""
    return hub.interlocks.status


@router.post("/interlocks")
async def create_interlock(
    body: dict,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer, Role.admin))],
):
    try:
        rule = validate_rule(body)
    except ExprError as exc:
        raise HTTPException(400, str(exc)) from exc
    rule_id = uuid.uuid4().hex[:8]
    row = await store.upsert_interlock(rule_id, **rule, updated_by=user.username)
    await hub.audit.add(user.username, user.role, "新增联锁规则", f"「{rule['name']}」{rule['kind']}：{rule['condition']}", None)
    return row


@router.put("/interlocks/{rule_id}")
async def update_interlock(
    rule_id: str,
    body: dict,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer, Role.admin))],
):
    old = await store.get_interlock(rule_id)
    if old is None:
        raise HTTPException(404, "联锁规则不存在")
    merged = {**old, **{k: v for k, v in body.items() if k in (
        "name", "kind", "enabled", "condition", "severity", "target_subsystem", "target_command", "message")}}
    try:
        rule = validate_rule(merged)
    except ExprError as exc:
        raise HTTPException(400, str(exc)) from exc
    row = await store.upsert_interlock(rule_id, **rule, builtin=old["builtin"], updated_by=user.username)
    await hub.audit.add(
        user.username, user.role, "更新联锁规则",
        f"「{rule['name']}」v{row.get('version')}：enabled={rule['enabled']} condition={rule['condition']}", None,
    )
    return row


@router.delete("/interlocks/{rule_id}")
async def delete_interlock(
    rule_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer, Role.admin))],
):
    old = await store.get_interlock(rule_id)
    if old is None:
        raise HTTPException(404, "联锁规则不存在")
    await store.delete_interlock(rule_id)
    hub.interlocks.forget(rule_id)
    await store.resolve_interlock_alerts([f"interlock:{rule_id}"])
    await hub.audit.add(user.username, user.role, "删除联锁规则", f"「{old['name']}」（{rule_id}）", None)
    return {"ok": True}


# ---------- 跨子系统参数联动（设定值协调） ----------

@router.post("/coordination/preview")
async def coordination_preview(
    body: dict,
    user: Annotated[UserInfo, Depends(current_user)],
):
    """给定目标风速，返回关联子系统的建议设定与冲突告警（不落任何指令）。"""
    try:
        wind = float(body.get("wind_speed"))
    except (TypeError, ValueError):
        raise HTTPException(400, "wind_speed 必须是数值") from None
    return preview_linkage(wind, hub.last_values, hub.live_settings)


@router.post("/coordination/apply")
async def coordination_apply(
    body: dict,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer))],
):
    """批量下发联动设定（操作员在联动弹窗确认后调用）：逐项限值校验+联锁许可+审计。"""
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "items 不能为空")
    if len(items) > 20:
        raise HTTPException(400, "单次联动最多 20 项")
    results = await apply_linkage(
        items, user=user.username, role=user.role,
        audit=hub.audit, check_command=hub.interlocks.check_command,
    )
    return {"ok": all(r["ok"] for r in results), "results": results}


# ---------- 用户反馈（登录可提交，服务端 5 分钟限流；查看/处理仅管理员） ----------
FEEDBACK_DIR = DATA_DIR / "feedback"
_FEEDBACK_MIN_INTERVAL = 300  # 同一用户两次提交的最小间隔（秒）
_FEEDBACK_MAX_CONTENT = 2000
_FEEDBACK_MAX_IMAGE = 5 * 1024 * 1024


def _feedback_image(feedback_id: str) -> Path:
    return FEEDBACK_DIR / f"{feedback_id}.png"


@router.post("/feedback")
async def submit_feedback(
    user: Annotated[UserInfo, Depends(current_user)],
    content: str = Form(...),
    email: str = Form(""),
    page_url: str = Form(""),
    screenshot: UploadFile | None = File(None),
):
    content = content.strip()
    if not content:
        raise HTTPException(400, "请填写问题或建议")
    if len(content) > _FEEDBACK_MAX_CONTENT:
        raise HTTPException(400, f"内容不能超过 {_FEEDBACK_MAX_CONTENT} 字")
    last = await store.last_feedback_at(user.username)
    if last:
        try:
            elapsed = (local_now() - datetime.fromisoformat(last)).total_seconds()
        except ValueError:
            elapsed = _FEEDBACK_MIN_INTERVAL
        if elapsed < _FEEDBACK_MIN_INTERVAL:
            remain = int(_FEEDBACK_MIN_INTERVAL - elapsed)
            raise HTTPException(
                429, f"提交太频繁，请 {remain // 60} 分 {remain % 60} 秒后再试"
            )
    row = await store.create_feedback(
        {
            "username": user.username,
            "role": str(user.role),
            "content": content,
            "email": email.strip()[:200],
            "page_url": page_url.strip()[:500],
        }
    )
    if screenshot is not None and screenshot.filename:
        if (screenshot.content_type or "") not in ("image/png", "image/jpeg", "image/webp"):
            await store.delete_feedback(row["id"])
            raise HTTPException(400, "截图仅支持 PNG / JPEG / WebP 图片")
        data = await screenshot.read()
        if len(data) > _FEEDBACK_MAX_IMAGE:
            await store.delete_feedback(row["id"])
            raise HTTPException(400, "截图不能超过 5MB")
        try:
            from PIL import Image

            img = Image.open(io.BytesIO(data))
            img.load()
            img.thumbnail((1920, 1920))
            FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
            img.save(_feedback_image(row["id"]), format="PNG")
        except ImportError:
            if screenshot.content_type != "image/png":
                await store.delete_feedback(row["id"])
                raise HTTPException(400, "当前环境截图仅支持 PNG")
            FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
            _feedback_image(row["id"]).write_bytes(data)
        except Exception as exc:
            await store.delete_feedback(row["id"])
            raise HTTPException(400, "截图不是有效的图片文件") from exc
        row["has_screenshot"] = 1
        await store.mark_feedback_screenshot(row["id"])
    await hub.audit.add(user.username, user.role, "提交反馈", content[:60], None)
    logger.info("用户反馈: %s (%s) %s", user.username, row["id"], content[:40])
    return {"ok": True, "id": row["id"], "created_at": row["created_at"]}


@router.get("/feedback")
async def list_feedbacks(
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
    status: str = "",
):
    return await store.list_feedbacks(status or None)


@router.get("/feedback/{feedback_id}/screenshot")
async def feedback_screenshot(
    feedback_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    path = _feedback_image(feedback_id)
    if not path.exists():
        raise HTTPException(404, "截图不存在")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.put("/feedback/{feedback_id}")
async def update_feedback(
    feedback_id: str,
    body: dict,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    status = str(body.get("status") or "")
    if status not in ("未处理", "处理中", "已处理"):
        raise HTTPException(400, "状态无效")
    if not await store.set_feedback_status(feedback_id, status):
        raise HTTPException(404, "反馈不存在")
    return {"ok": True}


@router.delete("/feedback/{feedback_id}")
async def delete_feedback(
    feedback_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    if not await store.delete_feedback(feedback_id):
        raise HTTPException(404, "反馈不存在")
    path = _feedback_image(feedback_id)
    if path.exists():
        path.unlink()
    return {"ok": True}


# ---------- 排程计划（登录可读；客户仅见关联本人项目/订单的条目；写操作维护员+） ----------

def _parse_dt(value: str, field: str) -> str:
    """校验 ISO 日期时间字符串（datetime-local 的 YYYY-MM-DDTHH:MM 也可），原样返回。"""
    try:
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(400, f"{field} 不是合法的日期时间: {value}") from exc
    return value


async def _schedule_visible(schedule: dict, user: UserInfo) -> bool:
    """排程可见性：非客户不限；客户仅见其关联项目/订单归属本人的条目。"""
    if not _is_customer(user):
        return True
    if schedule.get("project_id"):
        project = await store.get_project(schedule["project_id"])
        if project and project["customer_username"] == user.username:
            return True
    if schedule.get("order_id"):
        order = await store.get_order(schedule["order_id"])
        if order and order["customer_username"] == user.username:
            return True
    return False


async def _validate_schedule_links(project_id: str | None, order_id: str | None, experiment_id: str | None) -> None:
    if project_id and await store.get_project(project_id) is None:
        raise HTTPException(400, "关联项目不存在")
    if order_id and await store.get_order(order_id) is None:
        raise HTTPException(400, "关联订单不存在")
    if experiment_id:
        try:
            hub.experiments.get(experiment_id)
        except KeyError as exc:
            raise HTTPException(400, "关联实验不存在") from exc


@router.get("/schedules")
async def list_schedules(
    user: Annotated[UserInfo, Depends(current_user)],
    from_at: str | None = Query(default=None, alias="from", description="start_at 下界（ISO）"),
    to_at: str | None = Query(default=None, alias="to", description="start_at 上界（ISO）"),
):
    items = await store.list_schedules(from_at=from_at, to_at=to_at)
    if _is_customer(user):
        items = [s for s in items if await _schedule_visible(s, user)]
    return items


# 大屏公示状态映射：内部状态 → 公示文案；已取消不上屏
_SCHEDULE_DISPLAY_STATUS = {"计划中": "等待中", "已确认": "准备中", "进行中": "试验中", "已完成": "已完成"}


@router.get("/schedules/display")
async def schedules_display(
    user: Annotated[UserInfo, Depends(current_user)],
    days: int = Query(default=1, ge=1, le=14, description="含今天在内的天数"),
    privacy: int = Query(default=1, ge=0, le=1, description="1=客户等候区（去标识化）；0=控制室（完整）"),
):
    """排程展示大屏数据源。privacy=1 时服务端只下发排队号/日期/时间窗/公示状态/资源，
    不返回任何可溯源字段（标题、项目/订单/实验关联、创建人、备注一律不出服务端）。
    排队号按各天 start_at 排序生成（A01、A02…，每天重新编号）。客户角色一律 403。"""
    if _is_customer(user):
        raise HTTPException(403, "客户角色无权访问排程公示接口")
    today = local_now().date()
    from_at = f"{today.isoformat()}T00:00:00"
    to_at = f"{(today + timedelta(days=days - 1)).isoformat()}T23:59:59"
    rows = await store.list_schedules(from_at=from_at, to_at=to_at)
    rows = [r for r in rows if r["status"] in _SCHEDULE_DISPLAY_STATUS]
    items: list[dict[str, Any]] = []
    counters: dict[str, int] = {}
    for r in rows:
        day = r["start_at"][:10]
        counters[day] = counters.get(day, 0) + 1
        item: dict[str, Any] = {
            "queue_no": f"A{counters[day]:02d}",
            "date": day,
            "start_at": r["start_at"],
            "end_at": r["end_at"],
            "status": _SCHEDULE_DISPLAY_STATUS[r["status"]],
            "resource": r["resource"],
        }
        if not privacy:
            project = await store.get_project(r["project_id"]) if r.get("project_id") else None
            order = await store.get_order(r["order_id"]) if r.get("order_id") else None
            item.update(
                {
                    "id": r["id"],
                    "title": r["title"],
                    "project_id": r.get("project_id"),
                    "order_id": r.get("order_id"),
                    "experiment_id": r.get("experiment_id"),
                    "project_name": f"{project['project_no']} · {project['name']}" if project else None,
                    "order_name": f"{order['order_no']} · {order['title']}" if order else None,
                    "raw_status": r["status"],
                    "created_by": r["created_by"],
                }
            )
        items.append(item)
    return {
        "privacy": privacy,
        "days": days,
        "generated_at": local_now().isoformat(timespec="seconds"),
        "items": items,
    }


@router.post("/schedules")
async def create_schedule(
    body: ScheduleIn,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    start_at = _parse_dt(body.start_at, "start_at")
    end_at = _parse_dt(body.end_at, "end_at")
    if start_at >= end_at:
        raise HTTPException(400, "开始时间必须早于结束时间")
    await _validate_schedule_links(body.project_id, body.order_id, body.experiment_id)
    row = await store.create_schedule({**body.model_dump(), "created_by": user.username})
    await hub.audit.add(user.username, user.role, "创建排程", f"{row['title']}（{row['resource']} {row['start_at']}~{row['end_at']}）", None)
    logger.info("排程创建: %s（%s）by %s", row["title"], row["id"], user.username)
    return row


@router.put("/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    body: ScheduleUpdate,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    current = await store.get_schedule(schedule_id)
    if current is None:
        raise HTTPException(404, "排程不存在")
    data = body.model_dump(exclude_none=True)
    # 关联字段传空字符串表示清除（置 NULL）
    for key in ("project_id", "order_id", "experiment_id"):
        if data.get(key) == "":
            data[key] = None
    start_at = _parse_dt(data.get("start_at") or current["start_at"], "start_at")
    end_at = _parse_dt(data.get("end_at") or current["end_at"], "end_at")
    if start_at >= end_at:
        raise HTTPException(400, "开始时间必须早于结束时间")
    await _validate_schedule_links(data.get("project_id"), data.get("order_id"), data.get("experiment_id"))
    if data:
        await store.update_schedule(schedule_id, data)
        await hub.audit.add(user.username, user.role, "更新排程", f"{schedule_id}: {data}", None)
        logger.info("排程更新: %s by %s → %s", schedule_id, user.username, data)
    return await store.get_schedule(schedule_id)


@router.delete("/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    schedule = await store.get_schedule(schedule_id)
    if not schedule:
        raise HTTPException(404, "排程不存在")
    await store.delete_schedule(schedule_id)
    await hub.audit.add(user.username, user.role, "删除排程", f"{schedule['title']}（{schedule['start_at']}）", None)
    logger.info("排程删除: %s（%s）by %s", schedule["title"], schedule_id, user.username)
    return {"ok": True}


@router.get("/overview")
async def overview(user: Annotated[UserInfo, Depends(current_user)]):
    return await hub.overview()


@router.get("/contracts")
async def list_contracts(user: Annotated[UserInfo, Depends(current_user)]):
    return [contract_as_dict(c) for c in CONTRACTS.values()]


@router.get("/contracts/{subsystem_id}")
async def get_contract(subsystem_id: SubsystemId, user: Annotated[UserInfo, Depends(current_user)]):
    return contract_as_dict(CONTRACTS[subsystem_id])


@router.get("/subsystems")
async def list_subsystems(user: Annotated[UserInfo, Depends(current_user)]):
    out = []
    for ad in registry.all():
        st = await ad.read_status()
        meta = registry.meta(ad.subsystem_id)
        data = st.model_dump(mode="json")
        data["endpoint"] = meta.get("endpoint", "")
        data["protocol"] = meta.get("protocol", "")
        data["contract"] = contract_as_dict(ad.contract)
        out.append(data)
    return out


@router.get("/subsystems/{subsystem_id}")
async def get_subsystem(subsystem_id: SubsystemId, user: Annotated[UserInfo, Depends(current_user)]):
    st = await registry.get(subsystem_id).read_status()
    meta = registry.meta(subsystem_id)
    data = st.model_dump(mode="json")
    data["endpoint"] = meta.get("endpoint", "")
    data["protocol"] = meta.get("protocol", "")
    data["contract"] = contract_as_dict(CONTRACTS[subsystem_id])
    return data


@router.post("/subsystems/{subsystem_id}/mode")
async def switch_mode(
    subsystem_id: SubsystemId,
    mode: ConnMode,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    old = registry.get(subsystem_id)
    try:
        await old.disconnect()
    except Exception:  # noqa: BLE001
        logger.warning("切换模式前断开 %s 失败", subsystem_id.value, exc_info=True)
    ad = registry.switch_mode(subsystem_id, mode)
    try:
        await ad.connect()
        msg = f"已切换为 {mode.value} 并连接成功"
    except Exception as exc:  # noqa: BLE001
        logger.warning("切换 %s 为 %s 后连接失败: %s", subsystem_id.value, mode.value, exc)
        msg = f"已切换为 {mode.value}，连接未成功: {exc}"
    await hub.audit.add(
        user.username,
        user.role,
        "切换接入模式",
        f"{subsystem_id.value} → {mode.value}; {msg}",
        subsystem_id.value,
    )
    logger.info("接入模式切换: %s → %s by %s", subsystem_id.value, mode.value, user.username)
    return {"ok": True, "message": msg, "status": (await ad.read_status()).model_dump(mode="json")}


@router.post("/subsystems/{subsystem_id}/connectivity-test")
async def connectivity_test(
    subsystem_id: SubsystemId,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer, Role.operator))],
):
    report = await registry.get(subsystem_id).connectivity_test()
    await hub.audit.add(
        user.username,
        user.role,
        "连通性测试",
        f"{subsystem_id.value} {'通过' if report.passed else '失败'}",
        subsystem_id.value,
    )
    return report


@router.post("/connectivity-test/all")
async def connectivity_test_all(
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer, Role.operator))],
):
    reports = []
    for ad in registry.all():
        reports.append(await ad.connectivity_test())
    passed = sum(1 for r in reports if r.passed)
    return {
        "passed": passed,
        "total": len(reports),
        "all_ok": passed == len(reports),
        "reports": [r.model_dump(mode="json") for r in reports],
    }


@router.post("/commands")
async def send_command(
    body: CommandRequest,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return await hub.execute_command(body, user.username, user.role)


# ---------- 客户数据隔离：客户仅能访问归属本人订单的实验 / run / 报告 ----------

def _is_customer(user: UserInfo) -> bool:
    return user.role == Role.customer.value


async def _assert_experiment_visible(exp_id: str, user: UserInfo) -> None:
    """客户仅可访问绑定到本人订单的实验；其余角色不限。"""
    if not _is_customer(user):
        return
    try:
        exp = hub.experiments.get(exp_id)
    except KeyError as exc:
        raise HTTPException(404, "实验不存在") from exc
    order_id = getattr(exp, "order_id", None)
    if not order_id:
        raise HTTPException(403, "无权访问该实验")
    order = await store.get_order(order_id)
    if not order or order["customer_username"] != user.username:
        raise HTTPException(403, "无权访问该实验")


async def _assert_run_visible(run: dict, user: UserInfo) -> None:
    """客户仅可访问归属本人订单实验的 run（无实验归属的矩阵 run 不对客户开放）。"""
    if not _is_customer(user):
        return
    exp_id = run.get("experiment_id")
    if not exp_id:
        raise HTTPException(403, "无权访问该 run")
    await _assert_experiment_visible(exp_id, user)


async def _report_visible(report: dict, user: UserInfo) -> bool:
    """报告可见性：本人创建，或其关联实验归属本人订单。"""
    if not _is_customer(user):
        return True
    if report.get("created_by") == user.username:
        return True
    exp_id = report.get("experiment_id")
    if not exp_id:
        return False
    try:
        exp = hub.experiments.get(exp_id)
    except KeyError:
        return False
    order_id = getattr(exp, "order_id", None)
    if not order_id:
        return False
    order = await store.get_order(order_id)
    return bool(order and order["customer_username"] == user.username)


@router.get("/experiments")
async def list_experiments(
    user: Annotated[UserInfo, Depends(current_user)],
    order_id: str | None = Query(default=None, description="按关联订单过滤"),
):
    items = hub.experiments.list()
    if order_id:
        items = [e for e in items if e.order_id == order_id]
    if _is_customer(user):
        own = {o["id"] for o in await store.list_orders(customer_username=user.username)}
        items = [e for e in items if getattr(e, "order_id", None) in own]
    return items


@router.post("/experiments")
async def create_experiment(
    body: ExperimentCreate,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    if body.order_id and await store.get_order(body.order_id) is None:
        raise HTTPException(400, "关联订单不存在")
    return await hub.experiments.create(body, user.username, user.role)


@router.get("/experiments/{exp_id}")
async def get_experiment(exp_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    await _assert_experiment_visible(exp_id, user)
    try:
        return hub.experiments.get(exp_id)
    except KeyError as exc:
        raise HTTPException(404, "实验不存在") from exc


@router.post("/experiments/{exp_id}/phase")
async def set_phase(
    exp_id: str,
    phase: ExperimentPhase,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    exp = await hub.experiments.set_phase(exp_id, phase, user.username, user.role)
    if phase == ExperimentPhase.aborted:
        # 联动中止正在执行的实验流水线（采集 run 标记 aborted）
        hub.request_abort(exp_id)
    return exp


@router.post("/experiments/{exp_id}/run")
async def run_experiment(
    exp_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return await hub.run_experiment_pipeline(exp_id, user.username, user.role)


# ---------- 实验数据：runs / samples / summary ----------

@router.get("/experiments/{exp_id}/runs")
async def list_experiment_runs(exp_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    """某实验的采集 run 列表（含配置快照与状态）。"""
    await _assert_experiment_visible(exp_id, user)
    return await store.list_runs(experiment_id=exp_id)


@router.get("/runs/{run_id}")
async def get_run(run_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    run = await store.get_run(run_id)
    if not run:
        raise HTTPException(404, "run 不存在")
    await _assert_run_visible(run, user)
    return run


@router.get("/runs/{run_id}/samples")
async def get_run_samples(
    run_id: str,
    user: Annotated[UserInfo, Depends(current_user)],
    channels: str | None = Query(default=None, description="通道组过滤，逗号分隔：balance,pressure,acoustic,env"),
    downsample: int = Query(default=1, ge=1, le=10000, description="降采样步长，每 N 条取 1 条"),
):
    run = await store.get_run(run_id)
    if not run:
        raise HTTPException(404, "run 不存在")
    await _assert_run_visible(run, user)
    groups = [g.strip() for g in channels.split(",") if g.strip()] if channels else None
    samples = await store.get_run_samples(run_id, channels=groups, downsample=downsample)
    return {"run_id": run_id, "count": len(samples), "samples": samples}


@router.get("/runs/{run_id}/summary")
async def get_run_summary(run_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    """run 统计摘要：各通道 均值/最大/最小/标准差 + Cd/Cl 气动力系数换算。"""
    run = await store.get_run(run_id)
    if not run:
        raise HTTPException(404, "run 不存在")
    await _assert_run_visible(run, user)
    samples = await store.get_run_samples(run_id)
    return compute_run_summary(run, samples)


# ---------- 试验矩阵 ----------

@router.get("/matrices")
async def list_matrices(user: Annotated[UserInfo, Depends(current_user)]):
    items = await store.list_matrices()
    # 附带执行状态（取自 RuntimeHub 执行上下文；无执行记录为 idle）。仅增字段，保持兼容。
    for m in items:
        m["exec_status"] = hub.matrix_status(m["id"]).get("status", "idle")
    return items


@router.post("/matrices")
async def create_matrix(
    body: MatrixCreate,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return await hub.create_matrix(body, user.username, user.role)


@router.get("/matrices/{matrix_id}")
async def get_matrix(matrix_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    m = await store.get_matrix(matrix_id)
    if not m:
        raise HTTPException(404, "矩阵不存在")
    return m


@router.put("/matrices/{matrix_id}")
async def update_matrix(
    matrix_id: str,
    body: MatrixUpdate,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return await hub.update_matrix(matrix_id, body, user.username, user.role)


@router.delete("/matrices/{matrix_id}")
async def delete_matrix(
    matrix_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    await hub.delete_matrix(matrix_id, user.username, user.role)
    return {"ok": True}


@router.post("/matrices/{matrix_id}/run")
async def run_matrix(
    matrix_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
    body: MatrixRunRequest | None = None,
):
    """按工况表异步执行矩阵；body.experiment_id 可选（run 关联到实验）。"""
    experiment_id = body.experiment_id if body else None
    return await hub.start_matrix(matrix_id, user.username, user.role, experiment_id)


@router.post("/matrices/{matrix_id}/pause")
async def pause_matrix(
    matrix_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return hub.matrix_control(matrix_id, "pause", user.username, user.role)


@router.post("/matrices/{matrix_id}/resume")
async def resume_matrix(
    matrix_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return hub.matrix_control(matrix_id, "resume", user.username, user.role)


@router.post("/matrices/{matrix_id}/abort")
async def abort_matrix(
    matrix_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    return hub.matrix_control(matrix_id, "abort", user.username, user.role)


@router.get("/matrices/{matrix_id}/status")
async def matrix_status(matrix_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    """矩阵执行状态：状态机、进度 x/N、当前工况、估计剩余时间。"""
    return hub.matrix_status(matrix_id)


# ---------- 风速程控（阶梯剖面） ----------

@router.get("/profiles")
async def list_profiles(user: Annotated[UserInfo, Depends(current_user)]):
    items = await store.list_profiles()
    for p in items:
        p["exec_status"] = hub.profile_exec_status(p["id"])
    return items


@router.post("/profiles")
async def create_profile(
    body: ProfileIn,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    row = {
        "id": uuid.uuid4().hex[:10],
        "name": body.name,
        "steps": [s.model_dump() for s in body.steps],
        "created_by": user.username,
        "created_at": local_now().isoformat(timespec="seconds"),
    }
    await store.save_profile(row)
    await hub.audit.add(user.username, user.role, "创建程控剖面", f"{row['name']}（{len(row['steps'])} 步）", None)
    logger.info("程控剖面创建: %s（%s）by %s", row["name"], row["id"], user.username)
    return row


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: str,
    body: ProfileUpdate,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    p = await store.get_profile(profile_id)
    if not p:
        raise HTTPException(404, "程控剖面不存在")
    if hub.profile_exec_status(profile_id) == "running":
        raise HTTPException(409, "该剖面正在执行，禁止修改")
    data = body.model_dump(exclude_none=True)
    if "steps" in data:
        data["steps"] = [s if isinstance(s, dict) else s.model_dump() for s in data["steps"]]
    if data:
        p.update(data)
        await store.save_profile(p)
        await hub.audit.add(user.username, user.role, "修改程控剖面", f"{p['name']}（{len(p['steps'])} 步）", None)
        logger.info("程控剖面修改: %s（%s）by %s", p["name"], profile_id, user.username)
    return p


@router.delete("/profiles/{profile_id}")
async def delete_profile(
    profile_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    if hub.profile_exec_status(profile_id) == "running":
        raise HTTPException(409, "该剖面正在执行，禁止删除")
    p = await store.get_profile(profile_id)
    if not p:
        raise HTTPException(404, "程控剖面不存在")
    await store.delete_profile(profile_id)
    await hub.audit.add(user.username, user.role, "删除程控剖面", p["name"], None)
    logger.info("程控剖面删除: %s（%s）by %s", p["name"], profile_id, user.username)
    return {"ok": True}


@router.post("/profiles/{profile_id}/start")
async def start_profile(
    profile_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    """启动阶梯剖面自动执行（后台任务）；与实验流水线/矩阵互斥。"""
    return await hub.start_profile(profile_id, user.username, user.role)


@router.post("/profiles/stop")
async def stop_profile(
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    """中止当前执行中的风速程控。"""
    return hub.stop_profile(user.username, user.role)


@router.get("/profiles/status/current")
async def profile_status_current(user: Annotated[UserInfo, Depends(current_user)]):
    """当前程控执行状态（running 时详情，空闲返回 state=idle）。"""
    return hub.profile_status() or {"state": "idle"}


# ---------- 设备台账（一机一档） ----------

MAINTENANCE_TYPES = ("保养", "维修", "巡检", "校准")


class MaintenanceIn(BaseModel):
    type: str = Field(min_length=1, max_length=16)
    content: str = Field(min_length=1, max_length=500)


@router.get("/equipment")
async def equipment_list(user: Annotated[UserInfo, Depends(current_user)]):
    """12 子系统一机一档：实时状态 + 今日/累计运行时长 + 未确认告警数 + 最近维护时间。"""
    return await hub.equipment_list()


@router.get("/equipment/{subsystem_id}/maintenance")
async def list_maintenance(
    subsystem_id: SubsystemId,
    user: Annotated[UserInfo, Depends(current_user)],
    limit: int = Query(default=100, ge=1, le=500),
):
    return await store.list_maintenance(subsystem_id.value, limit)


@router.post("/equipment/{subsystem_id}/maintenance")
async def add_maintenance(
    subsystem_id: SubsystemId,
    body: MaintenanceIn,
    user: Annotated[UserInfo, Depends(require_roles(Role.maintainer))],
):
    if body.type not in MAINTENANCE_TYPES:
        raise HTTPException(400, f"维护类型须为: {'/'.join(MAINTENANCE_TYPES)}")
    entry = await store.add_maintenance(
        {
            "subsystem_id": subsystem_id.value,
            "type": body.type,
            "content": body.content,
            "operator": user.display_name or user.username,
        }
    )
    await hub.audit.add(user.username, user.role, "维护记录", f"{subsystem_id.value} {body.type}: {body.content[:60]}", subsystem_id.value)
    logger.info("维护记录新增: %s %s by %s", subsystem_id.value, body.type, user.username)
    return entry


@router.get("/audit")
async def list_audit(user: Annotated[UserInfo, Depends(current_user)], limit: int = 100):
    return hub.audit.list(limit)


@router.get("/history")
async def telemetry_history(user: Annotated[UserInfo, Depends(current_user)], limit: int = 300):
    return await store.history(limit)


# 轻量遥测历史（子系统页趋势区）：单次查询测点数上限，防滥用
TELEMETRY_HISTORY_MAX_KEYS = 20


@router.get("/telemetry/history")
async def telemetry_point_history(
    user: Annotated[UserInfo, Depends(current_user)],
    keys: str = Query(..., description="逗号分隔测点键：宽表键（rrs.fx）或裸键（fx，自动匹配唯一宽表测点）"),
    minutes: int = Query(default=30, ge=1, le=1440, description="回看分钟数"),
    limit: int = Query(default=500, ge=1, le=5000, description="单序列返回点数上限（超出等间隔降采样）"),
):
    """按点位查最近 N 分钟历史：{series: {宽表键: [{t, v}, ...]}}，数据源 telemetry_wide（1Hz）。"""
    requested = [k.strip() for k in keys.split(",") if k.strip()]
    if not requested:
        raise HTTPException(422, "参数 keys 不能为空")
    if len(requested) > TELEMETRY_HISTORY_MAX_KEYS:
        raise HTTPException(422, f"单次最多查询 {TELEMETRY_HISTORY_MAX_KEYS} 个测点")
    resolved: dict[str, str] = {}  # 请求键 → 宽表键
    for k in requested:
        if k in WIDE_POINT_KEYS:
            resolved[k] = k
            continue
        matches = sorted(wk for wk in WIDE_POINT_KEYS if wk.endswith(f".{k}"))
        if len(matches) == 1:
            resolved[k] = matches[0]
        elif not matches:
            raise HTTPException(422, f"测点无历史记录或不存在: {k}")
        else:
            raise HTTPException(422, f"测点键 {k} 不唯一，请使用子系统前缀: {', '.join(matches)}")

    now = local_now()
    rows = await store.query_wide((now - timedelta(minutes=minutes)).isoformat(), now.isoformat())
    wanted = sorted(set(resolved.values()))
    series: dict[str, list[dict[str, Any]]] = {wk: [] for wk in wanted}
    for ts, values in rows:
        for wk in wanted:
            v = values.get(wk)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                series[wk].append({"t": ts, "v": round(float(v), 4)})
    for wk, pts in series.items():
        if len(pts) > limit:
            step = len(pts) / limit
            series[wk] = [pts[int(i * step)] for i in range(limit)]
    return {"minutes": minutes, "keys": resolved, "series": series}


# ---------- 历史数据查询 / 统计汇总（数据中心） ----------

# 相对时间参数：-15m / -1h / -7d / -300s
_REL_TIME_RE = re.compile(r"^-\s*(\d+)\s*([smhd])$")
_REL_UNIT_SEC = {"s": 1, "m": 60, "h": 3600, "d": 86400}
# 单次查询的时间窗 / 测点数 / 单测点返回点数上限
HISTORY_MAX_WINDOW_DAYS = 7
HISTORY_MAX_POINTS_PER_QUERY = 12
HISTORY_MAX_SERIES_POINTS = 5000


def _parse_time_param(text: str | None, default: datetime, name: str) -> datetime:
    """解析时间参数：ISO 本地时间或相对时间（-15m/-1h/-7d）。"""
    if not text or not text.strip():
        return default
    text = text.strip()
    m = _REL_TIME_RE.match(text)
    if m:
        return local_now() - timedelta(seconds=int(m.group(1)) * _REL_UNIT_SEC[m.group(2)])
    try:
        return datetime.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(422, f"参数 {name} 时间格式无效（支持 ISO 或相对时间如 -1h）") from exc


@router.get("/history/query")
async def history_query(
    user: Annotated[UserInfo, Depends(current_user)],
    points: str = Query(..., description="逗号分隔测点键，如 main_fan.wind_speed,rrs.fx"),
    from_: str | None = Query(default=None, alias="from", description="起始时间：ISO 或相对时间（-15m/-1h/-7d），默认 -1h"),
    to: str | None = Query(default=None, description="截止时间：ISO 或相对时间，默认当前"),
    bucket_sec: int = Query(default=10, ge=1, le=3600, description="聚合桶秒数"),
    agg: Literal["avg", "min", "max"] = Query(default="avg", description="桶内聚合方式"),
):
    """宽表历史查询：按 bucket 聚合多测点时间序列（数据源 telemetry_wide，1Hz）。"""
    keys: list[str] = []
    for k in points.split(","):
        k = k.strip()
        if k and k not in keys:
            keys.append(k)
    if not keys:
        raise HTTPException(422, "参数 points 不能为空")
    if len(keys) > HISTORY_MAX_POINTS_PER_QUERY:
        raise HTTPException(422, f"单次最多查询 {HISTORY_MAX_POINTS_PER_QUERY} 个测点")
    bad = [k for k in keys if k not in WIDE_POINT_KEYS]
    if bad:
        raise HTTPException(
            422,
            f"测点无历史记录或不存在: {', '.join(bad)}；可查询测点: {', '.join(sorted(WIDE_POINT_KEYS))}",
        )

    now = local_now()
    dt_to = _parse_time_param(to, now, "to")
    dt_from = _parse_time_param(from_, dt_to - timedelta(hours=1), "from")
    if dt_from >= dt_to:
        raise HTTPException(422, "起始时间必须早于截止时间")
    window_sec = (dt_to - dt_from).total_seconds()
    if window_sec > HISTORY_MAX_WINDOW_DAYS * 86400:
        raise HTTPException(422, f"时间窗不能超过 {HISTORY_MAX_WINDOW_DAYS} 天")

    # 单测点返回点数上限保护：超出自动加大 bucket
    bucket = int(bucket_sec)
    if window_sec / bucket > HISTORY_MAX_SERIES_POINTS:
        bucket = min(3600, math.ceil(window_sec / HISTORY_MAX_SERIES_POINTS))

    rows = await store.query_wide(dt_from.isoformat(), dt_to.isoformat())
    meta = {f"{e['subsystem']}.{e['point']}": e for e in all_point_meta()}

    # 桶聚合：bucket 序号 → {key: [values]}
    buckets: dict[int, dict[str, list[float]]] = {}
    for ts, values in rows:
        try:
            t = datetime.fromisoformat(ts)
        except ValueError:
            continue
        b = int((t - dt_from).total_seconds() // bucket)
        slot = buckets.setdefault(b, {})
        for k in keys:
            v = values.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                slot.setdefault(k, []).append(float(v))

    def _agg(vals: list[float]) -> float:
        if agg == "min":
            return min(vals)
        if agg == "max":
            return max(vals)
        return sum(vals) / len(vals)

    series = []
    for k in keys:
        pts = [
            [(dt_from + timedelta(seconds=b * bucket)).isoformat(timespec="seconds"), round(_agg(buckets[b][k]), 4)]
            for b in sorted(buckets)
            if k in buckets[b] and buckets[b][k]
        ]
        m = meta.get(k, {})
        series.append({"key": k, "name": m.get("name", k), "unit": m.get("unit", ""), "points": pts})

    logger.info(
        "历史查询 by %s: %d 测点 %s ~ %s bucket=%ds agg=%s rows=%d",
        user.username, len(keys), dt_from.isoformat(timespec="seconds"),
        dt_to.isoformat(timespec="seconds"), bucket, agg, len(rows),
    )
    return {
        "from": dt_from.isoformat(timespec="seconds"),
        "to": dt_to.isoformat(timespec="seconds"),
        "bucket_sec": bucket,
        "agg": agg,
        "raw_rows": len(rows),
        "points": series,
    }


@router.get("/stats/overview")
async def stats_overview(
    user: Annotated[UserInfo, Depends(current_user)],
    days: int = Query(default=7, ge=1, le=90, description="统计窗口天数"),
):
    """运行统计汇总：实验/矩阵/run/告警/审计操作量（数据中心统计分析页）。"""
    data = await store.stats_overview(days)
    logger.info("统计汇总 by %s: days=%d 实验=%d run=%d 告警=%d",
                user.username, days, data["experiments"]["total"], data["runs"]["total"], data["alerts"]["total"])
    return data


@router.get("/reports")
async def list_reports(user: Annotated[UserInfo, Depends(current_user)]):
    reports = await store.list_reports()
    if _is_customer(user):
        visible = []
        for r in reports:
            if await _report_visible(r, user):
                visible.append(r)
        return visible
    return reports


@router.get("/reports/{report_id}")
async def get_report(report_id: str, user: Annotated[UserInfo, Depends(current_user)]):
    report = await store.get_report(report_id)
    if not report:
        raise HTTPException(404, "报告不存在")
    if not await _report_visible(report, user):
        raise HTTPException(403, "无权访问该报告")
    return report


@router.post("/reports")
async def create_report(
    body: ReportCreate,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin, Role.customer))],
):
    snap = await hub.snapshot()
    experiment = None
    runs_data = None
    if body.experiment_id:
        await _assert_experiment_visible(body.experiment_id, user)
        try:
            experiment = hub.experiments.get(body.experiment_id).model_dump(mode="json")
        except KeyError as exc:
            raise HTTPException(404, "实验不存在") from exc
        # 纳入该实验的采集 runs：摘要 + 配置快照 + 图表采样
        runs = await store.list_runs(experiment_id=body.experiment_id, limit=20)
        runs_data = []
        for run in runs:
            samples = await store.get_run_samples(run["id"])
            runs_data.append(
                {
                    "run": run,
                    "summary": compute_run_summary(run, samples),
                    "samples": samples,
                }
            )
    report = await build_report_html(
        title=body.title,
        experiment=experiment,
        overview=snap["overview"],
        subsystems=snap["subsystems"],
        user=user.display_name,
        runs_data=runs_data,
    )
    await hub.audit.add(user.username, user.role, "生成报告", report["title"], None)
    return {"id": report["id"], "title": report["title"], "created_at": report["created_at"]}


@router.get("/ai/alerts")
async def ai_alerts(
    user: Annotated[UserInfo, Depends(current_user)],
    limit: int = Query(default=50, ge=1, le=500),
    severity: Literal["info", "warning", "alarm", "critical"] | None = None,
    active: bool | None = None,
    acked: bool | None = None,
):
    return await store.list_ai_alerts(limit, severity=severity, active=active, acked=acked)


@router.get("/ai/alerts/summary")
async def ai_alert_summary(user: Annotated[UserInfo, Depends(current_user)]):
    """各级别未确认且未恢复的告警计数（前端报警横幅用）。"""
    return await store.ai_alert_summary()


@router.post("/ai/inspect")
async def ai_inspect(
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    ov = await hub.overview()
    alerts = await run_ai_inspection(hub.safety, ov.wind_speed)
    hub.latest_ai_alerts = alerts
    await hub.audit.add(user.username, user.role, "AI巡检", f"发现 {len(alerts)} 条", None)
    return {"count": len(alerts), "alerts": alerts}


@router.post("/ai/alerts/ack_all")
async def ack_all_alerts(
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    n = await store.ack_all_ai_alerts(user.username)
    await hub.audit.add(user.username, user.role, "一键确认巡检告警", f"{n} 条", None)
    logger.info("告警一键确认: %d 条 by %s", n, user.username)
    return {"ok": True, "count": n}


@router.post("/ai/alerts/{alert_id}/ack")
async def ack_alert(
    alert_id: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.operator, Role.maintainer, Role.admin))],
):
    ok = await store.ack_ai_alert(alert_id, user.username)
    if not ok:
        raise HTTPException(404, "告警不存在")
    await hub.audit.add(user.username, user.role, "确认巡检告警", alert_id, None)
    logger.info("告警确认: %s by %s", alert_id, user.username)
    return {"ok": True}


@router.post("/ai/ask")
async def ai_ask(body: NlAsk, user: Annotated[UserInfo, Depends(current_user)]):
    snap = await hub.snapshot()
    result = await nl_query(body.question, snap["overview"], snap["subsystems"])
    await hub.audit.add(user.username, user.role, "自然语言查询", body.question[:80], None)
    return result


@router.get("/twin")
async def twin(user: Annotated[UserInfo, Depends(current_user)]):
    snap = await hub.snapshot()
    return await twin_snapshot(snap["overview"]["wind_speed"], snap["subsystems"])


@router.get("/twin/health")
async def twin_health(user: Annotated[UserInfo, Depends(current_user)]):
    """健康基线：每个受监控测点的 当前值/基线/z-score/健康度/状态 + 子系统聚合。"""
    return health_svc.report()


@router.post("/twin/health/{subsystem_id}/reset")
async def twin_health_reset(
    subsystem_id: SubsystemId,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    """重置某子系统的健康基线（内存 + 落库记录），重置后重新进入 learning。"""
    if subsystem_id.value not in {s["id"] for s in health_svc.report()["subsystems"]}:
        raise HTTPException(404, "该子系统无受监控测点")
    removed = await health_svc.reset(subsystem_id.value)
    await hub.audit.add(user.username, user.role, "重置健康基线", subsystem_id.value, subsystem_id.value)
    logger.info("健康基线重置: %s by %s", subsystem_id.value, user.username)
    return {"ok": True, "subsystem": subsystem_id.value, "removed": removed}


# ---------- 开放数据接口（IT/OT 融合，只读，不含控制面信息） ----------

@router.get("/open/points")
async def open_points(user: Annotated[UserInfo, Depends(current_user)]):
    """全量测点语义元数据（外部系统发现用）；logged=true 表示该测点有宽表历史可查询。"""
    points = all_point_meta()
    for p in points:
        p["logged"] = f"{p['subsystem']}.{p['point']}" in WIDE_POINT_KEYS
    return {
        "ts": local_now().isoformat(timespec="seconds"),
        "count": len(points),
        "points": points,
    }


@router.get("/open/latest")
async def open_latest(user: Annotated[UserInfo, Depends(current_user)]):
    """全部测点当前值快照（轻量，可外部轮询）。"""
    ts = local_now().isoformat(timespec="seconds")
    points = []
    for ad in registry.all():
        try:
            st = await ad.read_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning("开放接口读取 %s 失败: %s", ad.subsystem_id.value, exc)
            continue
        for p in st.points:
            points.append(
                {
                    "subsystem": st.id.value,
                    "subsystem_name": st.name,
                    "point": p.key,
                    "name": p.label,
                    "value": p.value,
                    "unit": p.unit,
                    "quality": p.quality,
                }
            )
    return {"ts": ts, "count": len(points), "points": points}


@router.get("/settings")
async def get_settings(user: Annotated[UserInfo, Depends(current_user)]):
    data = dict(hub.live_settings)
    # 兼容旧字段名
    data["ai_inspection_enabled"] = bool(data.get("ai_inspect_enabled", True))
    # MQTT 可选依赖提示：False 时需安装 paho-mqtt 才能启用发布通道
    data["mqtt_available"] = mqtt_pub.available()
    return data


@router.put("/settings")
async def put_settings(
    body: SettingsPatch,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    data = body.model_dump(exclude_none=True)
    # 旧字段名归一
    if "ai_inspection_enabled" in data:
        data["ai_inspect_enabled"] = data.pop("ai_inspection_enabled")
    force_changed = (
        "force_simulation" in data
        and bool(data["force_simulation"]) != bool(hub.live_settings.get("force_simulation", True))
    )
    for k, v in data.items():
        await store.set_setting(k, v)
    await hub.refresh_settings()
    if force_changed:
        await hub.apply_force_simulation(bool(data["force_simulation"]))
    await hub.audit.add(user.username, user.role, "更新设置", str(data), None)
    logger.info("设置更新 by %s: %s", user.username, data)
    return await get_settings(user)


# ---------- 系统：存储 / 清理 ----------

@router.get("/system/storage")
async def system_storage(user: Annotated[UserInfo, Depends(current_user)]):
    return await store.storage_stats()


@router.post("/system/cleanup")
async def system_cleanup(
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    removed = await store.apply_retention(
        int(hub.live_settings.get("history_retention_days", 30)),
        int(hub.live_settings.get("audit_retention_days", 180)),
        int(hub.live_settings.get("alert_retention_count", 5000)),
    )
    await hub.audit.add(user.username, user.role, "手动清理", str(removed), None)
    logger.info("手动清理 by %s: %s", user.username, removed)
    return {"ok": True, "removed": removed}


# ---------- 系统：备份 / 恢复 ----------

@router.post("/system/backup")
async def system_backup(
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    info = await backup_svc.create_backup()
    await hub.audit.add(user.username, user.role, "创建备份", info["name"], None)
    return info


@router.get("/system/backups")
async def system_backups(user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))]):
    return backup_svc.list_backups()


@router.get("/system/backups/{name}/download")
async def system_backup_download(
    name: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin, Role.maintainer))],
):
    try:
        path = backup_svc.get_backup_path(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "备份不存在") from exc
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@router.post("/system/backups/{name}/restore")
async def system_backup_restore(
    name: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    try:
        result = await backup_svc.restore_backup(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "备份不存在") from exc
    await hub.audit.add(user.username, user.role, "恢复备份", name, None)
    return {"ok": True, **result}


@router.delete("/system/backups/{name}")
async def system_backup_delete(
    name: str,
    user: Annotated[UserInfo, Depends(require_roles(Role.admin))],
):
    try:
        backup_svc.delete_backup(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "备份不存在") from exc
    await hub.audit.add(user.username, user.role, "删除备份", name, None)
    return {"ok": True}


# ---------- 系统：网络 / 信息 ----------

@router.get("/system/network")
async def system_network(user: Annotated[UserInfo, Depends(current_user)]):
    base = f"http://{settings.host}:{settings.port}"
    return {
        "host": settings.host,
        "port": settings.port,
        "api_base": f"{base}/api",
        "ws_telemetry": f"ws://{settings.host}:{settings.port}/api/ws/telemetry",
        "cors_origins": settings.cors_origin_list,
        "docs": f"{base}/docs",
    }


@router.get("/system/info")
async def system_info(user: Annotated[UserInfo, Depends(current_user)]):
    ads = registry.all()
    sim_n = sum(1 for a in ads if a.mode == ConnMode.simulation)
    started = hub.started_at
    uptime = (local_now() - started).total_seconds() if started else 0
    return {
        "app_name": settings.app_name,
        "version": settings.version,
        "app_version": settings.app_version,
        "started_at": started.isoformat(timespec="seconds") if started else None,
        "uptime_seconds": int(uptime),
        "python_version": platform.python_version(),
        "simulation_count": sim_n,
        "real_count": len(ads) - sim_n,
        "force_simulation": bool(hub.live_settings.get("force_simulation", True)),
    }


@router.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    token = ws.query_params.get("token")
    if not token:
        await ws.close(code=4401)
        return
    try:
        decode_token(token)
    except HTTPException:
        await ws.close(code=4401)
        return
    await ws.accept()
    q = hub.subscribe()
    try:
        await ws.send_json(await hub.snapshot())
        while True:
            get_task = asyncio.create_task(q.get())
            recv_task = asyncio.create_task(ws.receive_text())
            done, pending = await asyncio.wait(
                {get_task, recv_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
            if get_task in done:
                await ws.send_json(get_task.result())
            if recv_task in done:
                try:
                    _ = recv_task.result()
                except WebSocketDisconnect:
                    break
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("遥测 WebSocket 异常")
    finally:
        hub.unsubscribe(q)
