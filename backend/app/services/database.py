"""数据库配置管理：支持 SQLite（默认）/ PostgreSQL / MySQL，管理界面可切换。"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

SUPPORTED_ENGINES = ("sqlite", "postgresql", "mysql")

DEFAULT_SQLITE_PATH = str(DATA_DIR / "wtcs.db")


class DatabaseConfig(BaseModel):
    engine: str = "sqlite"
    host: str = ""
    port: int = 5432
    username: str = ""
    password: str = ""
    database: str = ""
    path: str = DEFAULT_SQLITE_PATH
    pool_size: int = 5
    ssl: bool = False
    options: str = ""

    def display_url(self) -> str:
        if self.engine == "sqlite":
            return f"sqlite:///{self.path}"
        port = self.port or (5432 if self.engine == "postgresql" else 3306)
        return f"{self.engine}://{self.username}@{self.host}:{port}/{self.database}"

    def sqlalchemy_url(self) -> str:
        if self.engine == "sqlite":
            return f"sqlite+aiosqlite:///{self.path}"
        port = self.port or (5432 if self.engine == "postgresql" else 3306)
        pwd = f":{self.password}" if self.password else ""
        return f"{self.engine}+asyncpg://{self.username}{pwd}@{self.host}:{port}/{self.database}"


class DatabaseManager:
    """数据库配置生命周期：加载 / 保存 / 测试连接 / 切换。"""

    def __init__(self) -> None:
        self._config: DatabaseConfig = DatabaseConfig()
        self._lock = asyncio.Lock()

    @property
    def config(self) -> DatabaseConfig:
        return self._config

    async def load_from_store(self) -> None:
        from app.services.store import store

        raw = await store.get_setting("_db_config")
        if raw and isinstance(raw, dict):
            try:
                self._config = DatabaseConfig.model_validate(raw)
            except Exception:
                logger.exception("数据库配置解析失败，使用默认值")
                self._config = DatabaseConfig()
        else:
            self._config = DatabaseConfig()

    async def save_to_store(self) -> None:
        from app.services.store import store

        await store.set_setting("_db_config", self._config.model_dump())

    async def test_connection(self, cfg: DatabaseConfig | None = None) -> dict[str, Any]:
        target = cfg or self._config
        if target.engine == "sqlite":
            return await self._test_sqlite(target)
        if target.engine == "postgresql":
            return await self._test_postgresql(target)
        if target.engine == "mysql":
            return await self._test_mysql(target)
        return {"ok": False, "error": f"不支持的数据库引擎: {target.engine}"}

    async def _test_sqlite(self, cfg: DatabaseConfig) -> dict[str, Any]:
        try:
            import aiosqlite

            path = Path(cfg.path)
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = await aiosqlite.connect(str(path))
            try:
                cursor = await conn.execute("SELECT 1")
                await cursor.fetchone()
                cursor2 = await conn.execute("PRAGMA journal_mode")
                mode = (await cursor2.fetchone())[0]
                return {
                    "ok": True,
                    "engine": "sqlite",
                    "path": str(path),
                    "journal_mode": mode,
                    "message": f"SQLite 连接成功（WAL={mode}）",
                }
            finally:
                await conn.close()
        except Exception as exc:
            return {"ok": False, "error": f"SQLite 连接失败: {exc}"}

    async def _test_postgresql(self, cfg: DatabaseConfig) -> dict[str, Any]:
        try:
            import asyncpg  # type: ignore[import-untyped]
        except ImportError:
            return {"ok": False, "error": "未安装 asyncpg，请 pip install asyncpg"}
        try:
            conn = await asyncpg.connect(
                host=cfg.host,
                port=cfg.port or 5432,
                user=cfg.username,
                password=cfg.password,
                database=cfg.database,
                timeout=5,
                ssl="prefer" if cfg.ssl else False,
            )
            try:
                ver = await conn.fetchval("SELECT version()")
                return {
                    "ok": True,
                    "engine": "postgresql",
                    "version": ver,
                    "message": f"PostgreSQL 连接成功: {ver[:60]}",
                }
            finally:
                await conn.close()
        except Exception as exc:
            return {"ok": False, "error": f"PostgreSQL 连接失败: {exc}"}

    async def _test_mysql(self, cfg: DatabaseConfig) -> dict[str, Any]:
        try:
            import aiomysql  # type: ignore[import-untyped]
        except ImportError:
            return {"ok": False, "error": "未安装 aiomysql，请 pip install aiomysql"}
        try:
            conn = await aiomysql.connect(
                host=cfg.host,
                port=cfg.port or 3306,
                user=cfg.username,
                password=cfg.password,
                db=cfg.database,
                connect_timeout=5,
                ssl=cfg.ssl,
            )
            try:
                async with conn.cursor() as cur:
                    await cur.execute("SELECT VERSION()")
                    row = await cur.fetchone()
                    ver = row[0] if row else "unknown"
                return {
                    "ok": True,
                    "engine": "mysql",
                    "version": ver,
                    "message": f"MySQL 连接成功: {ver}",
                }
            finally:
                conn.close()
        except Exception as exc:
            return {"ok": False, "error": f"MySQL 连接失败: {exc}"}

    async def apply_config(self, cfg: DatabaseConfig) -> dict[str, Any]:
        """保存配置并重新初始化 store（仅 SQLite 支持热切换；远端库保存配置待驱动实现）。"""
        async with self._lock:
            test = await self.test_connection(cfg)
            if not test["ok"]:
                return test
            self._config = cfg
            await self.save_to_store()
            if cfg.engine == "sqlite":
                from app.services.store import store

                await store.reconfigure(Path(cfg.path))
                logger.info("数据库已切换至 SQLite: %s", cfg.path)
            else:
                logger.info("数据库配置已保存: %s（远端引擎驱动待上线时激活）", cfg.display_url())
            return {"ok": True, "message": "数据库配置已生效", "config": cfg.model_dump()}

    async def export_sqlite_data(self) -> dict[str, Any]:
        """导出当前 SQLite 全部数据为 JSON（供迁移到远端库时使用）。"""
        from app.services.store import store, TABLES

        c = store._require()
        data: dict[str, list[dict[str, Any]]] = {}
        for table in TABLES:
            try:
                cursor = await c.execute(f"SELECT * FROM {table}")
                rows = await cursor.fetchall()
                data[table] = [dict(r) for r in rows]
            except Exception:
                logger.warning("导出表 %s 失败", table)
                data[table] = []
        return {
            "engine": "sqlite",
            "path": str(store.path),
            "tables": {k: len(v) for k, v in data.items()},
            "data": data,
        }


db_manager = DatabaseManager()
