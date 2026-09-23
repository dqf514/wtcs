from __future__ import annotations

import logging
from datetime import timedelta
from typing import Annotated

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.core.config import settings
from app.models.schemas import Role, TokenResponse, UserInfo, local_now
from app.services.store import store

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

# 角色等级：customer < operator < maintainer < admin
ROLE_ORDER = {
    Role.customer: 0,
    Role.operator: 1,
    Role.maintainer: 2,
    Role.admin: 3,
}

DEFAULT_PASSWORD = "wtcs123"

# 建设期内置账号（首次启动写入 users 表，密码 bcrypt 哈希；上线后接 LDAP/AD）
DEFAULT_USERS = {
    "operator": {"display_name": "值班操作员", "role": Role.operator},
    "maintainer": {"display_name": "维护工程师", "role": Role.maintainer},
    "admin": {"display_name": "系统管理员", "role": Role.admin},
    "customer": {"display_name": "客户参观", "role": Role.customer},
}

# 内置账号演示档案（幂等回填：仅在该字段为空时补充，不覆盖已有值）
DEFAULT_USER_PROFILES = {
    "operator": {
        "company": "合肥汽车风洞",
        "department": "运维部",
        "position": "值班工程师",
        "phone": "13900000001",
        "email": "operator@wtcs.local",
    },
    "maintainer": {
        "company": "合肥汽车风洞",
        "department": "运维部",
        "position": "维护工程师",
        "phone": "13900000002",
        "email": "maintainer@wtcs.local",
    },
    "admin": {
        "company": "合肥汽车风洞",
        "department": "综合管理部",
        "position": "系统管理员",
        "phone": "13900000003",
        "email": "admin@wtcs.local",
    },
    "customer": {
        "company": "示例汽车科技",
        "position": "试验主管",
    },
}

# 内置角色权限矩阵（首次启动播种 roles 表；已存在则跳过，不覆盖管理员的后续调整）
DEFAULT_ROLES: dict[str, dict] = {
    Role.customer.value: {"level": 0, "pages": ["portal", "dashboard", "screen"]},
    Role.operator.value: {"level": 1, "pages": ["dashboard", "subsystems", "experiments", "data", "insight", "screen", "schedule", "equipment", "interlocks", "commands"]},
    Role.maintainer.value: {"level": 2, "pages": ["dashboard", "subsystems", "experiments", "data", "insight", "screen", "orders", "projects", "customers", "schedule", "settings", "equipment", "interlocks", "commands"]},
    Role.admin.value: {"level": 3, "pages": ["portal", "dashboard", "subsystems", "experiments", "data", "insight", "screen", "orders", "projects", "customers", "schedule", "settings", "equipment", "interlocks", "commands"]},
}


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


async def ensure_default_users() -> None:
    """首次启动把默认账号迁移为哈希存储（已存在则跳过，不覆盖用户改过的密码）。"""
    for username, meta in DEFAULT_USERS.items():
        if await store.get_user(username) is None:
            await store.upsert_user(
                username,
                hash_password(DEFAULT_PASSWORD),
                meta["display_name"],
                meta["role"].value,
            )
            logger.info("初始化默认账号: %s（%s）", username, meta["role"].value)
    # 演示档案幂等回填：只补空字段，不覆盖管理员/用户已填写的值
    for username, profile in DEFAULT_USER_PROFILES.items():
        row = await store.get_user(username)
        if row is None:
            continue
        patch = {k: v for k, v in profile.items() if not row.get(k)}
        if patch:
            await store.update_user(username, **patch)
            logger.info("回填演示档案: %s → %s", username, sorted(patch))
    # 播种内置角色权限矩阵（已存在则跳过，不覆盖管理员在页面上的调整）
    for name, meta in DEFAULT_ROLES.items():
        if await store.get_role(name) is None:
            await store.upsert_role(name, meta["level"], meta["pages"], builtin=True)
            logger.info("初始化内置角色: %s（level=%d）", name, meta["level"])
    # 一次性迁移：老库内置角色 pages 缺失的新页面 key 追加（缺失才加，不动其他页面项）
    for name, meta in DEFAULT_ROLES.items():
        row = await store.get_role(name)
        if row is None or not row["builtin"]:
            continue
        missing = [p for p in meta["pages"] if p not in row["pages"]]
        if missing:
            await store.upsert_role(name, row["level"], [*row["pages"], *missing], builtin=True)
            logger.info("内置角色 %s 追加页面权限: %s", name, missing)


async def role_pages(role_name: str) -> list[str]:
    """某角色的页面权限列表：优先 roles 表；找不到时回退内置默认，再退化为空集。"""
    row = await store.get_role(role_name)
    if row is not None:
        return row["pages"]
    return list(DEFAULT_ROLES.get(role_name, {}).get("pages", []))


async def role_level(role_name: str) -> int:
    """某角色的等级：优先 roles 表，回退 ROLE_ORDER，未知角色按 0。"""
    row = await store.get_role(role_name)
    if row is not None:
        return int(row["level"])
    return {r.value: lv for r, lv in ROLE_ORDER.items()}.get(role_name, 0)


async def authenticate(username: str, password: str) -> TokenResponse:
    row = await store.get_user(username)
    if not row or not verify_password(password, row["password_hash"]):
        logger.warning("登录失败: username=%s", username)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    if not row.get("enabled", 1):
        logger.warning("停用账号登录被拒: %s", username)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号已停用，请联系管理员")
    role_value = row["role"]
    expire = local_now() + timedelta(hours=settings.jwt_expire_hours)
    token = jwt.encode(
        {"sub": username, "role": role_value, "exp": expire.timestamp()},
        settings.jwt_secret,
        algorithm="HS256",
    )
    info = UserInfo(username=username, display_name=row["display_name"], role=role_value)
    logger.info("登录成功: %s（%s）", username, role_value)
    return TokenResponse(access_token=token, user=info)


async def change_password(username: str, old_password: str, new_password: str) -> None:
    row = await store.get_user(username)
    if not row or not verify_password(old_password, row["password_hash"]):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="原密码错误")
    await store.set_user_password(username, hash_password(new_password))
    logger.info("用户 %s 修改密码", username)


def decode_token(token: str) -> UserInfo:
    """解析 JWT；失败抛 401。HTTP 与 WebSocket 共用。

    role 直接取 token 内的角色名字符串（支持自定义角色）；
    HTTP 侧的 current_user 会再以库中记录为准回查。
    """
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="令牌无效或已过期") from exc
    username = payload.get("sub")
    role_value = payload.get("role")
    if not username or not role_value:
        raise HTTPException(status_code=401, detail="无效令牌")
    display_name = next(
        (m["display_name"] for u, m in DEFAULT_USERS.items() if u == username), username
    )
    return UserInfo(username=username, display_name=display_name, role=str(role_value))


async def current_user(
    cred: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> UserInfo:
    if cred is None:
        raise HTTPException(status_code=401, detail="未携带访问令牌")
    info = decode_token(cred.credentials)
    # 每次请求回查用户表：账号被删除/停用立即 401，角色/display_name 以库中为准即时生效
    row = await store.get_user(info.username)
    if row is None or not row.get("enabled", 1):
        raise HTTPException(status_code=401, detail="账号不存在或已停用")
    return UserInfo(username=row["username"], display_name=row["display_name"], role=row["role"])


def require_roles(*roles: Role):
    async def _dep(user: Annotated[UserInfo, Depends(current_user)]) -> UserInfo:
        if user.role not in roles and user.role != Role.admin:
            raise HTTPException(status_code=403, detail="权限不足")
        return user

    return _dep


def require_page(page: str):
    """页面权限即模块写权限：角色矩阵里勾选该页面的角色可读写此模块。

    用于项目/订单/客户这类业务模块——勾选页面不再只是"只读可见"，
    同时授予新建/编辑（删除仍由更高级别角色把关）。管理员永远放行。
    """

    async def _dep(user: Annotated[UserInfo, Depends(current_user)]) -> UserInfo:
        if user.role == Role.admin.value or page in await role_pages(user.role):
            return user
        raise HTTPException(status_code=403, detail="权限不足")

    return _dep
