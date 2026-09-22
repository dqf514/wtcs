"""数据库备份 / 恢复。备份目录固定为 backend/data/backups，文件名严格校验防路径穿越。"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.config import BACKUP_DIR
from app.models.schemas import local_now
from app.services.store import store

logger = logging.getLogger(__name__)

_NAME_RE = re.compile(r"^wtcs-\d{8}-\d{6}\.db$")


def _validate_name(name: str) -> Path:
    """校验备份文件名，返回 backups 目录内的安全路径；非法即抛 ValueError。"""
    if not _NAME_RE.match(name):
        raise ValueError(f"非法备份文件名: {name}")
    path = (BACKUP_DIR / name).resolve()
    if path.parent != BACKUP_DIR.resolve():
        raise ValueError(f"非法备份路径: {name}")
    return path


async def create_backup() -> dict[str, Any]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"wtcs-{local_now().strftime('%Y%m%d-%H%M%S')}.db"
    path = BACKUP_DIR / name
    await store.backup_to(path)
    size = path.stat().st_size
    logger.info("数据库备份完成: %s（%d 字节）", name, size)
    return {"name": name, "size_bytes": size, "created_at": local_now().isoformat(timespec="seconds")}


def list_backups() -> list[dict[str, Any]]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for p in sorted(BACKUP_DIR.glob("wtcs-*.db"), reverse=True):
        if not _NAME_RE.match(p.name):
            continue
        stat = p.stat()
        items.append(
            {
                "name": p.name,
                "size_bytes": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            }
        )
    return items


def get_backup_path(name: str) -> Path:
    path = _validate_name(name)
    if not path.exists():
        raise FileNotFoundError(name)
    return path


async def restore_backup(name: str) -> dict[str, Any]:
    """恢复：先把当前库备份一份，再用指定备份替换。"""
    path = get_backup_path(name)
    safety = await create_backup()
    await store.replace_with(path)
    logger.warning("数据库已从备份 %s 恢复；恢复前自动备份为 %s", name, safety["name"])
    return {"restored": name, "safety_backup": safety["name"]}


def delete_backup(name: str) -> None:
    path = get_backup_path(name)
    path.unlink()
    logger.info("删除备份: %s", name)
