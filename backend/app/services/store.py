"""SQLite 持久化（aiosqlite 异步）：实验、审计、报告、设置、用户、时序采样、巡检告警。"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import aiosqlite

from app.core.config import DATA_DIR
from app.models.schemas import local_now

logger = logging.getLogger(__name__)

DB_PATH = DATA_DIR / "wtcs.db"

# 遥测采样硬上限（行数），低频批量裁剪
TELEMETRY_MAX_ROWS = 20000
# 每插入多少次采样执行一次裁剪
SAMPLE_PRUNE_EVERY = 60
# 巡检告警表默认上限
ALERT_DEFAULT_MAX_ROWS = 5000

# 宽表遥测落库点集（telemetry_wide，1Hz）：关键 float 测点。
# 与健康监控点（health.MONITORED_POINTS）保持一致，另补充路面速度/偏航/目标风速，
# 供 GET /api/history/query 历史查询与数据中心分析使用。
WIDE_POINTS: dict[str, tuple[str, ...]] = {
    "main_fan": ("wind_speed", "target_speed", "frequency", "power"),
    "cooling_water": ("supply_temp", "return_temp", "flow", "pressure"),
    "rrs": ("fx", "fy", "fz", "mx", "my", "mz", "belt_speed", "yaw"),
    "boundary_layer": ("suction_flow", "inverter_hz", "static_pressure"),
    "purge_air": ("temp", "humidity"),
    "compressed_air": ("pressure",),
    "acoustic": ("spl",),
}
# 可查询测点键全集（"main_fan.wind_speed" 形式）
WIDE_POINT_KEYS: frozenset[str] = frozenset(
    f"{sid}.{p}" for sid, keys in WIDE_POINTS.items() for p in keys
)

TABLES = (
    "experiments",
    "audit_log",
    "reports",
    "settings",
    "telemetry_samples",
    "telemetry_wide",
    "ai_alerts",
    "users",
    "experiment_runs",
    "run_samples",
    "test_matrices",
    "health_baselines",
    "roles",
    "orders",
    "projects",
    "schedules",
    "speed_profiles",
    "maintenance_logs",
    "equipment_runtime",
)


class Store:
    def __init__(self, path: Path = DB_PATH) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()
        self._sample_counter = 0

    async def init(self) -> None:
        """打开连接、开启 WAL、建表与列迁移。服务启动时调用一次。"""
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS experiments (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                ts TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                experiment_id TEXT,
                title TEXT,
                html TEXT,
                created_at TEXT NOT NULL,
                created_by TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS telemetry_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                wind_speed REAL,
                temperature REAL,
                safety TEXT,
                payload TEXT
            );
            CREATE TABLE IF NOT EXISTS telemetry_wide (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                "values" TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_telemetry_wide_ts ON telemetry_wide(ts);
            CREATE TABLE IF NOT EXISTS ai_alerts (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                ts TEXT NOT NULL,
                acked INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS experiment_runs (
                id TEXT PRIMARY KEY,
                experiment_id TEXT,
                matrix_id TEXT,
                row_index INTEGER DEFAULT 0,
                config TEXT NOT NULL,
                config_hash TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running',
                operator TEXT DEFAULT '',
                started_at TEXT,
                ended_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS run_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                t REAL NOT NULL,
                channels TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_run_samples_run ON run_samples(run_id);
            CREATE TABLE IF NOT EXISTS test_matrices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                scenario TEXT NOT NULL,
                conditions TEXT NOT NULL,
                on_error TEXT NOT NULL DEFAULT 'abort',
                version INTEGER NOT NULL DEFAULT 1,
                history TEXT NOT NULL DEFAULT '[]',
                created_by TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS health_baselines (
                subsystem TEXT NOT NULL,
                point TEXT NOT NULL,
                baseline_mean REAL NOT NULL DEFAULT 0,
                baseline_std REAL NOT NULL DEFAULT 0,
                sample_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (subsystem, point)
            );
            CREATE TABLE IF NOT EXISTS roles (
                name TEXT PRIMARY KEY,
                level INTEGER NOT NULL,
                pages TEXT NOT NULL,
                builtin INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY,
                code TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                contact TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                email TEXT DEFAULT '',
                address TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                username TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                order_no TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                customer_username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '待启动',
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                project_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                customer_username TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '立项',
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schedules (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT,
                order_id TEXT,
                experiment_id TEXT,
                resource TEXT NOT NULL DEFAULT '风洞洞体',
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '计划中',
                note TEXT DEFAULT '',
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_at);
            CREATE TABLE IF NOT EXISTS speed_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                steps TEXT NOT NULL,
                created_by TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS maintenance_logs (
                id TEXT PRIMARY KEY,
                subsystem_id TEXT NOT NULL,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                operator TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_maintenance_sub ON maintenance_logs(subsystem_id);
            CREATE TABLE IF NOT EXISTS equipment_runtime (
                subsystem_id TEXT PRIMARY KEY,
                total_sec REAL NOT NULL DEFAULT 0,
                day TEXT NOT NULL DEFAULT '',
                today_sec REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS feedbacks (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                page_url TEXT NOT NULL DEFAULT '',
                has_screenshot INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT '未处理',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(username, created_at);
            CREATE TABLE IF NOT EXISTS sequences (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'custom',
                steps TEXT NOT NULL,
                builtin INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS interlocks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'alarm',
                enabled INTEGER NOT NULL DEFAULT 1,
                condition TEXT NOT NULL,
                severity TEXT NOT NULL DEFAULT 'alarm',
                target_subsystem TEXT NOT NULL DEFAULT '',
                target_command TEXT NOT NULL DEFAULT '',
                message TEXT NOT NULL DEFAULT '',
                builtin INTEGER NOT NULL DEFAULT 0,
                trigger_count INTEGER NOT NULL DEFAULT 0,
                last_triggered TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                updated_by TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        await self._migrate()
        await self._conn.commit()
        logger.info("数据库初始化完成: %s", self.path)

    async def _migrate(self) -> None:
        """老库列迁移：幂等 ALTER（列已存在则跳过）。"""
        # ai_alerts 增加分级/去重/状态机字段
        await self._add_columns(
            "ai_alerts",
            {
                "severity": "TEXT DEFAULT 'info'",
                "dedupe_key": "TEXT DEFAULT ''",
                "active": "INTEGER DEFAULT 1",
                "count": "INTEGER DEFAULT 1",
                "acked_by": "TEXT DEFAULT ''",
                "acked_at": "TEXT DEFAULT ''",
                "updated_at": "TEXT DEFAULT ''",
            },
        )
        # users：启用/停用标记
        await self._add_columns("users", {"enabled": "INTEGER NOT NULL DEFAULT 1"})
        # users：档案字段（手机/邮箱/公司/部门/职位/备注）
        await self._add_columns(
            "users",
            {
                "phone": "TEXT DEFAULT ''",
                "email": "TEXT DEFAULT ''",
                "company": "TEXT DEFAULT ''",
                "department": "TEXT DEFAULT ''",
                "position": "TEXT DEFAULT ''",
                "notes": "TEXT DEFAULT ''",
            },
        )
        # experiments：订单关联（可空）
        await self._add_columns("experiments", {"order_id": "TEXT"})
        # orders：项目关联（可空）
        await self._add_columns("orders", {"project_id": "TEXT"})
        # projects/orders：客户档案关联（可空）
        await self._add_columns("projects", {"customer_id": "TEXT"})
        await self._add_columns("orders", {"customer_id": "TEXT"})
        # customers：行业 / 联系人职务
        await self._add_columns("customers", {"industry": "TEXT DEFAULT ''", "contact_title": "TEXT DEFAULT ''"})

    async def _add_columns(self, table: str, cols: dict[str, str]) -> None:
        cursor = await self._conn.execute(f"PRAGMA table_info({table})")
        existing = {row["name"] for row in await cursor.fetchall()}
        for col, ddl in cols.items():
            if col not in existing:
                await self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
                logger.info("%s 新增列: %s", table, col)

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    def _require(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Store 未初始化，请先调用 await store.init()")
        return self._conn

    # ---------- 实验 ----------

    async def save_experiment(self, exp: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO experiments(id, payload, created_at, order_id) VALUES(?,?,?,?)",
                (exp["id"], json.dumps(exp, ensure_ascii=False), exp.get("created_at", local_now().isoformat()), exp.get("order_id")),
            )
            await c.commit()

    async def list_experiments(self, order_id: str | None = None) -> list[dict[str, Any]]:
        c = self._require()
        if order_id:
            cursor = await c.execute(
                "SELECT payload FROM experiments WHERE order_id=? ORDER BY created_at DESC", (order_id,)
            )
        else:
            cursor = await c.execute("SELECT payload FROM experiments ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [json.loads(r["payload"]) for r in rows]

    async def list_experiments_by_order(self, order_id: str) -> list[dict[str, Any]]:
        """某订单关联的实验列表。"""
        return await self.list_experiments(order_id=order_id)

    async def get_experiment(self, exp_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT payload FROM experiments WHERE id=?", (exp_id,))
        row = await cursor.fetchone()
        return json.loads(row["payload"]) if row else None

    # ---------- 实验数据 run ----------

    async def create_run(self, run: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO experiment_runs"
                "(id, experiment_id, matrix_id, row_index, config, config_hash, status, operator, started_at, ended_at, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run["id"],
                    run.get("experiment_id"),
                    run.get("matrix_id"),
                    int(run.get("row_index", 0)),
                    json.dumps(run.get("config", {}), ensure_ascii=False),
                    run.get("config_hash", ""),
                    run.get("status", "running"),
                    run.get("operator", ""),
                    run.get("started_at"),
                    run.get("ended_at"),
                    run.get("created_at", local_now().isoformat()),
                ),
            )
            await c.commit()

    async def finish_run(self, run_id: str, status: str, ended_at: str | None = None) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "UPDATE experiment_runs SET status=?, ended_at=? WHERE id=?",
                (status, ended_at or local_now().isoformat(timespec="seconds"), run_id),
            )
            await c.commit()

    async def list_runs(
        self,
        experiment_id: str | None = None,
        matrix_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        c = self._require()
        sql = "SELECT * FROM experiment_runs"
        conds: list[str] = []
        params: list[Any] = []
        if experiment_id:
            conds.append("experiment_id=?")
            params.append(experiment_id)
        if matrix_id:
            conds.append("matrix_id=?")
            params.append(matrix_id)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        cursor = await c.execute(sql, params)
        rows = await cursor.fetchall()
        return [self._run_row(r) for r in rows]

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM experiment_runs WHERE id=?", (run_id,))
        row = await cursor.fetchone()
        return self._run_row(row) if row else None

    @staticmethod
    def _run_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        d["config"] = json.loads(d.get("config") or "{}")
        return d

    async def add_run_sample(self, run_id: str, t: float, channels: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO run_samples(run_id, t, channels) VALUES(?,?,?)",
                (run_id, t, json.dumps(channels, ensure_ascii=False)),
            )
            await c.commit()

    async def get_run_samples(
        self,
        run_id: str,
        channels: list[str] | None = None,
        downsample: int = 1,
    ) -> list[dict[str, Any]]:
        """读取 run 采样，按通道组过滤并按步长降采样。"""
        c = self._require()
        cursor = await c.execute(
            "SELECT id, t, channels FROM run_samples WHERE run_id=? ORDER BY id ASC",
            (run_id,),
        )
        rows = await cursor.fetchall()
        step = max(1, int(downsample))
        out: list[dict[str, Any]] = []
        for i, r in enumerate(rows):
            if i % step != 0:
                continue
            ch = json.loads(r["channels"])
            if channels:
                ch = {k: v for k, v in ch.items() if k in channels}
            out.append({"t": r["t"], "channels": ch})
        return out

    # ---------- 试验矩阵 ----------

    async def save_matrix(self, m: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO test_matrices"
                "(id, name, scenario, conditions, on_error, version, history, created_by, created_at, updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    m["id"],
                    m["name"],
                    m["scenario"],
                    json.dumps(m.get("conditions", []), ensure_ascii=False),
                    m.get("on_error", "abort"),
                    int(m.get("version", 1)),
                    json.dumps(m.get("history", []), ensure_ascii=False),
                    m.get("created_by", ""),
                    m.get("created_at", local_now().isoformat()),
                    m.get("updated_at", local_now().isoformat()),
                ),
            )
            await c.commit()

    async def list_matrices(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT * FROM test_matrices ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [self._matrix_row(r) for r in rows]

    async def get_matrix(self, matrix_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM test_matrices WHERE id=?", (matrix_id,))
        row = await cursor.fetchone()
        return self._matrix_row(row) if row else None

    async def delete_matrix(self, matrix_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM test_matrices WHERE id=?", (matrix_id,))
            await c.commit()
            return cursor.rowcount > 0

    @staticmethod
    def _matrix_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        d["conditions"] = json.loads(d.get("conditions") or "[]")
        d["history"] = json.loads(d.get("history") or "[]")
        return d

    # ---------- 审计 ----------

    async def add_audit(self, entry: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO audit_log(id, payload, ts) VALUES(?,?,?)",
                (entry["id"], json.dumps(entry, ensure_ascii=False), entry.get("ts", local_now().isoformat())),
            )
            await c.commit()

    async def list_audit(self, limit: int = 200) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT payload FROM audit_log ORDER BY ts DESC LIMIT ?", (limit,))
        rows = await cursor.fetchall()
        return [json.loads(r["payload"]) for r in rows]

    # ---------- 报告 ----------

    async def save_report(self, report: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO reports(id, experiment_id, title, html, created_at, created_by) VALUES(?,?,?,?,?,?)",
                (
                    report["id"],
                    report.get("experiment_id"),
                    report["title"],
                    report["html"],
                    report["created_at"],
                    report.get("created_by", ""),
                ),
            )
            await c.commit()

    async def list_reports(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute(
            "SELECT id, experiment_id, title, created_at, created_by FROM reports ORDER BY created_at DESC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_report(self, report_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM reports WHERE id=?", (report_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    # ---------- 设置 ----------

    async def set_setting(self, key: str, value: Any) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )
            await c.commit()

    async def get_setting(self, key: str, default: Any = None) -> Any:
        c = self._require()
        cursor = await c.execute("SELECT value FROM settings WHERE key=?", (key,))
        row = await cursor.fetchone()
        if not row:
            return default
        return json.loads(row["value"])

    async def all_settings(self) -> dict[str, Any]:
        c = self._require()
        cursor = await c.execute("SELECT key, value FROM settings")
        rows = await cursor.fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    # ---------- 用户 ----------

    async def get_user(self, username: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM users WHERE username=?", (username,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_users(self) -> list[dict[str, Any]]:
        """全部用户行（含 password_hash，由路由层裁剪后再返回前端）。"""
        c = self._require()
        cursor = await c.execute("SELECT * FROM users ORDER BY username")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def upsert_user(
        self,
        username: str,
        password_hash: str,
        display_name: str,
        role: str,
        phone: str = "",
        email: str = "",
        company: str = "",
        department: str = "",
        position: str = "",
        notes: str = "",
    ) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO users"
                "(username, password_hash, display_name, role, phone, email, company, department, position, notes)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (username, password_hash, display_name, role, phone, email, company, department, position, notes),
            )
            await c.commit()

    async def update_user(
        self,
        username: str,
        role: str | None = None,
        display_name: str | None = None,
        enabled: bool | None = None,
        phone: str | None = None,
        email: str | None = None,
        company: str | None = None,
        department: str | None = None,
        position: str | None = None,
        notes: str | None = None,
    ) -> bool:
        """更新角色/姓名/启停/档案字段（None 字段不动），返回是否有该行。"""
        sets: list[str] = []
        params: list[Any] = []
        if role is not None:
            sets.append("role=?")
            params.append(role)
        if display_name is not None:
            sets.append("display_name=?")
            params.append(display_name)
        if enabled is not None:
            sets.append("enabled=?")
            params.append(1 if enabled else 0)
        for col, val in (
            ("phone", phone),
            ("email", email),
            ("company", company),
            ("department", department),
            ("position", position),
            ("notes", notes),
        ):
            if val is not None:
                sets.append(f"{col}=?")
                params.append(val)
        if not sets:
            return await self.get_user(username) is not None
        async with self._lock:
            c = self._require()
            params.append(username)
            cursor = await c.execute(f"UPDATE users SET {', '.join(sets)} WHERE username=?", params)
            await c.commit()
            return cursor.rowcount > 0

    async def delete_user(self, username: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM users WHERE username=?", (username,))
            await c.commit()
            return cursor.rowcount > 0

    async def count_users_by_role(self, role: str) -> int:
        c = self._require()
        cursor = await c.execute("SELECT COUNT(*) AS n FROM users WHERE role=?", (role,))
        return int((await cursor.fetchone())["n"])

    async def set_user_password(self, username: str, password_hash: str) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "UPDATE users SET password_hash=? WHERE username=?", (password_hash, username)
            )
            await c.commit()

    # ---------- 角色权限矩阵 ----------

    async def get_role(self, name: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute(
            "SELECT name, level, pages, builtin FROM roles WHERE name=?", (name,)
        )
        row = await cursor.fetchone()
        return self._role_row(row) if row else None

    async def list_roles(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT name, level, pages, builtin FROM roles ORDER BY level DESC, name")
        rows = await cursor.fetchall()
        return [self._role_row(r) for r in rows]

    async def upsert_role(self, name: str, level: int, pages: list[str], builtin: bool = False) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO roles(name, level, pages, builtin) VALUES(?,?,?,?)",
                (name, int(level), json.dumps(pages, ensure_ascii=False), 1 if builtin else 0),
            )
            await c.commit()

    async def delete_role(self, name: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM roles WHERE name=?", (name,))
            await c.commit()
            return cursor.rowcount > 0

    @staticmethod
    def _role_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        d["pages"] = json.loads(d.get("pages") or "[]")
        d["builtin"] = bool(d.get("builtin"))
        return d

    # ---------- 项目 ----------

    async def create_project(self, project: dict[str, Any]) -> dict[str, Any]:
        """创建项目并返回完整行；project_no 冲突抛 sqlite3.IntegrityError。"""
        row = {
            "id": project.get("id") or uuid.uuid4().hex[:10],
            "project_no": project["project_no"],
            "name": project["name"],
            "customer_username": project["customer_username"],
            "customer_id": project.get("customer_id") or None,
            "status": project.get("status") or "立项",
            "note": project.get("note") or "",
            "created_at": project.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO projects(id, project_no, name, customer_username, customer_id, status, note, created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (
                    row["id"],
                    row["project_no"],
                    row["name"],
                    row["customer_username"],
                    row["customer_id"],
                    row["status"],
                    row["note"],
                    row["created_at"],
                ),
            )
            await c.commit()
        return row

    async def list_projects(
        self,
        customer_username: str | None = None,
        customer_id: str | None = None,
    ) -> list[dict[str, Any]]:
        c = self._require()
        sql = (
            "SELECT p.*, cu.name AS customer_name FROM projects p"
            " LEFT JOIN customers cu ON cu.id = p.customer_id"
        )
        conds: list[str] = []
        params: list[Any] = []
        if customer_username:
            conds.append("p.customer_username=?")
            params.append(customer_username)
        if customer_id:
            conds.append("p.customer_id=?")
            params.append(customer_id)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY p.created_at DESC"
        cursor = await c.execute(sql, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_project(self, project_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute(
            "SELECT p.*, cu.name AS customer_name FROM projects p"
            " LEFT JOIN customers cu ON cu.id = p.customer_id WHERE p.id=?",
            (project_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_project(self, project_id: str, fields: dict[str, Any]) -> bool:
        """按字段字典更新项目（白名单列），project_no 冲突抛 sqlite3.IntegrityError。

        customer_id 允许显式置空（None → NULL），其余字段传 None 视为不更新。
        """
        allowed = ("project_no", "name", "customer_username", "customer_id", "status", "note")
        sets: list[str] = []
        params: list[Any] = []
        for k in allowed:
            if k not in fields:
                continue
            if fields[k] is None and k != "customer_id":
                continue
            sets.append(f"{k}=?")
            params.append(fields[k])
        if not sets:
            return await self.get_project(project_id) is not None
        async with self._lock:
            c = self._require()
            params.append(project_id)
            cursor = await c.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id=?", params)
            await c.commit()
            return cursor.rowcount > 0

    async def delete_project(self, project_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM projects WHERE id=?", (project_id,))
            await c.commit()
            return cursor.rowcount > 0

    # ---------- 订单 ----------

    async def create_order(self, order: dict[str, Any]) -> dict[str, Any]:
        """创建订单并返回完整行；order_no 冲突抛 sqlite3.IntegrityError。"""
        row = {
            "id": order.get("id") or uuid.uuid4().hex[:10],
            "order_no": order["order_no"],
            "title": order["title"],
            "customer_username": order["customer_username"],
            "customer_id": order.get("customer_id") or None,
            "status": order.get("status") or "待启动",
            "note": order.get("note") or "",
            "project_id": order.get("project_id") or None,
            "created_at": order.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO orders(id, order_no, title, customer_username, customer_id, status, note, project_id, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    row["id"],
                    row["order_no"],
                    row["title"],
                    row["customer_username"],
                    row["customer_id"],
                    row["status"],
                    row["note"],
                    row["project_id"],
                    row["created_at"],
                ),
            )
            await c.commit()
        return row

    async def list_orders(
        self,
        customer_username: str | None = None,
        project_id: str | None = None,
        customer_id: str | None = None,
    ) -> list[dict[str, Any]]:
        c = self._require()
        sql = (
            "SELECT o.*, cu.name AS customer_name FROM orders o"
            " LEFT JOIN customers cu ON cu.id = o.customer_id"
        )
        conds: list[str] = []
        params: list[Any] = []
        if customer_username:
            conds.append("o.customer_username=?")
            params.append(customer_username)
        if project_id:
            conds.append("o.project_id=?")
            params.append(project_id)
        if customer_id:
            conds.append("o.customer_id=?")
            params.append(customer_id)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY o.created_at DESC"
        cursor = await c.execute(sql, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_order(self, order_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute(
            "SELECT o.*, cu.name AS customer_name FROM orders o"
            " LEFT JOIN customers cu ON cu.id = o.customer_id WHERE o.id=?",
            (order_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_order(self, order_id: str, fields: dict[str, Any]) -> bool:
        """按字段字典更新订单（白名单列），order_no 冲突抛 sqlite3.IntegrityError。

        project_id / customer_id 允许显式置空（None → NULL），其余字段传 None 视为不更新。
        """
        allowed = ("order_no", "title", "customer_username", "customer_id", "status", "note", "project_id")
        sets: list[str] = []
        params: list[Any] = []
        for k in allowed:
            if k not in fields:
                continue
            if fields[k] is None and k not in ("project_id", "customer_id"):
                continue
            sets.append(f"{k}=?")
            params.append(fields[k])
        if not sets:
            return await self.get_order(order_id) is not None
        async with self._lock:
            c = self._require()
            params.append(order_id)
            cursor = await c.execute(f"UPDATE orders SET {', '.join(sets)} WHERE id=?", params)
            await c.commit()
            return cursor.rowcount > 0

    async def delete_order(self, order_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM orders WHERE id=?", (order_id,))
            await c.commit()
            return cursor.rowcount > 0

    # ---------- 客户档案 ----------

    async def create_customer(self, customer: dict[str, Any]) -> dict[str, Any]:
        """创建客户档案并返回完整行；code 冲突抛 sqlite3.IntegrityError。"""
        row = {
            "id": customer.get("id") or uuid.uuid4().hex[:10],
            "code": customer["code"],
            "name": customer["name"],
            "contact": customer.get("contact") or "",
            "phone": customer.get("phone") or "",
            "email": customer.get("email") or "",
            "address": customer.get("address") or "",
            "notes": customer.get("notes") or "",
            "industry": customer.get("industry") or "",
            "contact_title": customer.get("contact_title") or "",
            "username": customer.get("username") or None,
            "created_at": customer.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO customers(id, code, name, contact, phone, email, address, notes, industry, contact_title, username, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row["id"],
                    row["code"],
                    row["name"],
                    row["contact"],
                    row["phone"],
                    row["email"],
                    row["address"],
                    row["notes"],
                    row["industry"],
                    row["contact_title"],
                    row["username"],
                    row["created_at"],
                ),
            )
            await c.commit()
        return row

    async def list_customers(self) -> list[dict[str, Any]]:
        """客户列表，附带名下项目数/订单数。"""
        c = self._require()
        cursor = await c.execute(
            "SELECT c.*,"
            " (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id) AS project_count,"
            " (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count"
            " FROM customers c ORDER BY c.created_at DESC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_customer(self, customer_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM customers WHERE id=?", (customer_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_customer_by_username(self, username: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM customers WHERE username=?", (username,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_customer(self, customer_id: str, fields: dict[str, Any]) -> bool:
        """按字段字典更新客户（白名单列），code 冲突抛 sqlite3.IntegrityError。

        username 允许显式置空（None → NULL），其余字段传 None 视为不更新。
        """
        allowed = ("code", "name", "contact", "phone", "email", "address", "notes", "industry", "contact_title", "username")
        sets: list[str] = []
        params: list[Any] = []
        for k in allowed:
            if k not in fields:
                continue
            if fields[k] is None and k != "username":
                continue
            sets.append(f"{k}=?")
            params.append(fields[k])
        if not sets:
            return await self.get_customer(customer_id) is not None
        async with self._lock:
            c = self._require()
            params.append(customer_id)
            cursor = await c.execute(f"UPDATE customers SET {', '.join(sets)} WHERE id=?", params)
            await c.commit()
            return cursor.rowcount > 0

    async def delete_customer(self, customer_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM customers WHERE id=?", (customer_id,))
            await c.commit()
            return cursor.rowcount > 0

    async def count_customer_refs(self, customer_id: str) -> tuple[int, int]:
        """名下项目数、订单数（删除保护用）。"""
        c = self._require()
        cursor = await c.execute("SELECT COUNT(*) AS n FROM projects WHERE customer_id=?", (customer_id,))
        projects = (await cursor.fetchone())["n"]
        cursor = await c.execute("SELECT COUNT(*) AS n FROM orders WHERE customer_id=?", (customer_id,))
        orders = (await cursor.fetchone())["n"]
        return int(projects), int(orders)

    # ---------- 用户反馈 ----------

    async def create_feedback(self, feedback: dict[str, Any]) -> dict[str, Any]:
        """创建反馈并返回完整行。截图不落库，由路由层存文件后回填 has_screenshot。"""
        row = {
            "id": feedback.get("id") or uuid.uuid4().hex[:12],
            "username": feedback["username"],
            "role": feedback.get("role") or "",
            "content": feedback["content"],
            "email": feedback.get("email") or "",
            "page_url": feedback.get("page_url") or "",
            "has_screenshot": 1 if feedback.get("has_screenshot") else 0,
            "status": "未处理",
            "created_at": feedback.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO feedbacks(id, username, role, content, email, page_url, has_screenshot, status, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    row["id"],
                    row["username"],
                    row["role"],
                    row["content"],
                    row["email"],
                    row["page_url"],
                    row["has_screenshot"],
                    row["status"],
                    row["created_at"],
                ),
            )
            await c.commit()
        return row

    async def last_feedback_at(self, username: str) -> str | None:
        """该用户最近一次反馈的 created_at（限流用），无记录返回 None。"""
        c = self._require()
        cursor = await c.execute(
            "SELECT created_at FROM feedbacks WHERE username=? ORDER BY created_at DESC LIMIT 1",
            (username,),
        )
        row = await cursor.fetchone()
        return row["created_at"] if row else None

    async def mark_feedback_screenshot(self, feedback_id: str) -> None:
        """截图已落盘后回填 has_screenshot 标记。"""
        async with self._lock:
            c = self._require()
            await c.execute("UPDATE feedbacks SET has_screenshot=1 WHERE id=?", (feedback_id,))
            await c.commit()

    async def list_feedbacks(self, status: str | None = None) -> list[dict[str, Any]]:
        """反馈列表（新的在前），可按状态过滤。"""
        c = self._require()
        if status:
            cursor = await c.execute(
                "SELECT * FROM feedbacks WHERE status=? ORDER BY created_at DESC", (status,)
            )
        else:
            cursor = await c.execute("SELECT * FROM feedbacks ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_feedback(self, feedback_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM feedbacks WHERE id=?", (feedback_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def set_feedback_status(self, feedback_id: str, status: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute(
                "UPDATE feedbacks SET status=? WHERE id=?", (status, feedback_id)
            )
            await c.commit()
            return cursor.rowcount > 0

    async def delete_feedback(self, feedback_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM feedbacks WHERE id=?", (feedback_id,))
            await c.commit()
            return cursor.rowcount > 0

    # ---------- 启停序列 ----------

    @staticmethod
    def _seq_row(r: Any) -> dict[str, Any]:
        row = dict(r)
        row["steps"] = json.loads(row["steps"])
        row["builtin"] = bool(row["builtin"])
        return row

    async def get_sequence(self, seq_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM sequences WHERE id=?", (seq_id,))
        row = await cursor.fetchone()
        return self._seq_row(row) if row else None

    async def list_sequences(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT * FROM sequences ORDER BY created_at")
        rows = await cursor.fetchall()
        return [self._seq_row(r) for r in rows]

    async def upsert_sequence(
        self,
        seq_id: str,
        name: str,
        kind: str,
        steps: list[dict[str, Any]],
        builtin: bool = False,
        updated_by: str = "",
    ) -> dict[str, Any]:
        """新建或更新序列；更新时 version 自增（配置留痕）。"""
        now = local_now().isoformat(timespec="seconds")
        async with self._lock:
            c = self._require()
            cursor = await c.execute("SELECT version, created_at FROM sequences WHERE id=?", (seq_id,))
            old = await cursor.fetchone()
            if old is None:
                await c.execute(
                    "INSERT INTO sequences(id, name, kind, steps, builtin, version, updated_by, updated_at, created_at)"
                    " VALUES(?,?,?,?,?,1,?,?,?)",
                    (seq_id, name, kind, json.dumps(steps, ensure_ascii=False), int(builtin), updated_by, now, now),
                )
            else:
                await c.execute(
                    "UPDATE sequences SET name=?, kind=?, steps=?, version=?, updated_by=?, updated_at=? WHERE id=?",
                    (name, kind, json.dumps(steps, ensure_ascii=False), int(old["version"]) + 1, updated_by, now, seq_id),
                )
            await c.commit()
        return (await self.get_sequence(seq_id)) or {}

    # ---------- 联锁矩阵 ----------

    @staticmethod
    def _interlock_row(row: Any) -> dict[str, Any]:
        d = dict(row)
        d["enabled"] = bool(d.get("enabled"))
        d["builtin"] = bool(d.get("builtin"))
        return d

    async def get_interlock(self, rule_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM interlocks WHERE id=?", (rule_id,))
        row = await cursor.fetchone()
        return self._interlock_row(row) if row else None

    async def list_interlocks(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT * FROM interlocks ORDER BY created_at")
        rows = await cursor.fetchall()
        return [self._interlock_row(r) for r in rows]

    async def upsert_interlock(
        self,
        rule_id: str,
        *,
        name: str,
        kind: str,
        enabled: int | bool,
        condition: str,
        severity: str,
        target_subsystem: str = "",
        target_command: str = "",
        message: str = "",
        builtin: bool = False,
        updated_by: str = "",
    ) -> dict[str, Any]:
        """新建或更新联锁规则；更新时 version 自增（配置留痕）。"""
        now = local_now().isoformat(timespec="seconds")
        async with self._lock:
            c = self._require()
            cursor = await c.execute("SELECT version, created_at FROM interlocks WHERE id=?", (rule_id,))
            old = await cursor.fetchone()
            if old is None:
                await c.execute(
                    "INSERT INTO interlocks(id, name, kind, enabled, condition, severity,"
                    " target_subsystem, target_command, message, builtin, version, updated_by, updated_at, created_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
                    (rule_id, name, kind, int(bool(enabled)), condition, severity,
                     target_subsystem, target_command, message, int(builtin), updated_by, now, now),
                )
            else:
                await c.execute(
                    "UPDATE interlocks SET name=?, kind=?, enabled=?, condition=?, severity=?,"
                    " target_subsystem=?, target_command=?, message=?, version=?, updated_by=?, updated_at=? WHERE id=?",
                    (name, kind, int(bool(enabled)), condition, severity,
                     target_subsystem, target_command, message,
                     int(old["version"]) + 1, updated_by, now, rule_id),
                )
            await c.commit()
        return (await self.get_interlock(rule_id)) or {}

    async def delete_interlock(self, rule_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM interlocks WHERE id=?", (rule_id,))
            await c.commit()
            return cursor.rowcount > 0

    async def mark_interlock_triggered(self, rule_id: str, ts: str) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "UPDATE interlocks SET trigger_count=trigger_count+1, last_triggered=? WHERE id=?",
                (ts, rule_id),
            )
            await c.commit()

    async def activate_interlock_alert(self, alert: dict[str, Any]) -> None:
        """联锁告警激活：同 dedupe_key 活跃则累加次数，否则插入新行。"""
        now = local_now().isoformat(timespec="seconds")
        async with self._lock:
            c = self._require()
            cursor = await c.execute(
                "SELECT id, count FROM ai_alerts WHERE dedupe_key=? AND active=1",
                (alert["dedupe_key"],),
            )
            row = await cursor.fetchone()
            if row:
                payload = dict(alert)
                payload["id"] = row["id"]
                payload["count"] = int(row["count"]) + 1
                await c.execute(
                    "UPDATE ai_alerts SET payload=?, ts=?, severity=?, count=?, updated_at=? WHERE id=?",
                    (json.dumps(payload, ensure_ascii=False), alert["ts"], alert["severity"], payload["count"], now, row["id"]),
                )
            else:
                await c.execute(
                    "INSERT OR REPLACE INTO ai_alerts"
                    "(id, payload, ts, acked, severity, dedupe_key, active, count, updated_at)"
                    " VALUES(?,?,?,0,?,?,1,1,?)",
                    (alert["id"], json.dumps(alert, ensure_ascii=False), alert["ts"],
                     alert["severity"], alert["dedupe_key"], now),
                )
            await c.commit()

    async def resolve_interlock_alerts(self, dedupe_keys: list[str]) -> None:
        """联锁告警恢复：指定 dedupe_key 的活跃告警置为已恢复。"""
        if not dedupe_keys:
            return
        now = local_now().isoformat(timespec="seconds")
        placeholders = ",".join("?" for _ in dedupe_keys)
        async with self._lock:
            c = self._require()
            await c.execute(
                f"UPDATE ai_alerts SET active=0, updated_at=? WHERE active=1 AND dedupe_key IN ({placeholders})",
                (now, *dedupe_keys),
            )
            await c.commit()

    # ---------- 排程计划 ----------

    async def create_schedule(self, schedule: dict[str, Any]) -> dict[str, Any]:
        """创建排程并返回完整行。"""
        row = {
            "id": schedule.get("id") or uuid.uuid4().hex[:10],
            "title": schedule["title"],
            "project_id": schedule.get("project_id") or None,
            "order_id": schedule.get("order_id") or None,
            "experiment_id": schedule.get("experiment_id") or None,
            "resource": schedule.get("resource") or "风洞洞体",
            "start_at": schedule["start_at"],
            "end_at": schedule["end_at"],
            "status": schedule.get("status") or "计划中",
            "note": schedule.get("note") or "",
            "created_by": schedule["created_by"],
            "created_at": schedule.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO schedules(id, title, project_id, order_id, experiment_id, resource,"
                " start_at, end_at, status, note, created_by, created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row["id"],
                    row["title"],
                    row["project_id"],
                    row["order_id"],
                    row["experiment_id"],
                    row["resource"],
                    row["start_at"],
                    row["end_at"],
                    row["status"],
                    row["note"],
                    row["created_by"],
                    row["created_at"],
                ),
            )
            await c.commit()
        return row

    async def list_schedules(
        self,
        from_at: str | None = None,
        to_at: str | None = None,
    ) -> list[dict[str, Any]]:
        """按 start_at 范围过滤（ISO 字符串比较）；from/to 均可空。"""
        c = self._require()
        sql = "SELECT * FROM schedules"
        conds: list[str] = []
        params: list[Any] = []
        if from_at:
            conds.append("start_at>=?")
            params.append(from_at)
        if to_at:
            conds.append("start_at<=?")
            params.append(to_at)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY start_at ASC"
        cursor = await c.execute(sql, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_schedule(self, schedule_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_schedule(self, schedule_id: str, fields: dict[str, Any]) -> bool:
        """按字段字典更新排程（白名单列）；关联字段允许显式置空（None → NULL）。"""
        nullable = ("project_id", "order_id", "experiment_id")
        allowed = ("title", "resource", "start_at", "end_at", "status", "note", *nullable)
        sets: list[str] = []
        params: list[Any] = []
        for k in allowed:
            if k not in fields:
                continue
            if fields[k] is None and k not in nullable:
                continue
            sets.append(f"{k}=?")
            params.append(fields[k])
        if not sets:
            return await self.get_schedule(schedule_id) is not None
        async with self._lock:
            c = self._require()
            params.append(schedule_id)
            cursor = await c.execute(f"UPDATE schedules SET {', '.join(sets)} WHERE id=?", params)
            await c.commit()
            return cursor.rowcount > 0

    async def delete_schedule(self, schedule_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
            await c.commit()
            return cursor.rowcount > 0

    # ---------- 风速程控剖面 ----------

    async def save_profile(self, p: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT OR REPLACE INTO speed_profiles(id, name, steps, created_by, created_at)"
                " VALUES(?,?,?,?,?)",
                (
                    p["id"],
                    p["name"],
                    json.dumps(p.get("steps", []), ensure_ascii=False),
                    p.get("created_by", ""),
                    p.get("created_at", local_now().isoformat()),
                ),
            )
            await c.commit()

    async def list_profiles(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT * FROM speed_profiles ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [self._profile_row(r) for r in rows]

    async def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        c = self._require()
        cursor = await c.execute("SELECT * FROM speed_profiles WHERE id=?", (profile_id,))
        row = await cursor.fetchone()
        return self._profile_row(row) if row else None

    async def delete_profile(self, profile_id: str) -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute("DELETE FROM speed_profiles WHERE id=?", (profile_id,))
            await c.commit()
            return cursor.rowcount > 0

    @staticmethod
    def _profile_row(r: Any) -> dict[str, Any]:
        d = dict(r)
        d["steps"] = json.loads(d.get("steps") or "[]")
        return d

    # ---------- 设备台账：维护记录 / 运行时长 / 告警计数 ----------

    async def add_maintenance(self, row: dict[str, Any]) -> dict[str, Any]:
        entry = {
            "id": row.get("id") or uuid.uuid4().hex[:10],
            "subsystem_id": row["subsystem_id"],
            "type": row["type"],
            "content": row["content"],
            "operator": row["operator"],
            "created_at": row.get("created_at") or local_now().isoformat(timespec="seconds"),
        }
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO maintenance_logs(id, subsystem_id, type, content, operator, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (
                    entry["id"],
                    entry["subsystem_id"],
                    entry["type"],
                    entry["content"],
                    entry["operator"],
                    entry["created_at"],
                ),
            )
            await c.commit()
        return entry

    async def list_maintenance(self, subsystem_id: str, limit: int = 100) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute(
            "SELECT * FROM maintenance_logs WHERE subsystem_id=? ORDER BY created_at DESC LIMIT ?",
            (subsystem_id, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def latest_maintenance(self) -> dict[str, str]:
        """各子系统最近一次维护时间（设备台账列表用，单查询聚合）。"""
        c = self._require()
        cursor = await c.execute(
            "SELECT subsystem_id, MAX(created_at) AS last_at FROM maintenance_logs GROUP BY subsystem_id"
        )
        rows = await cursor.fetchall()
        return {r["subsystem_id"]: r["last_at"] for r in rows}

    async def unacked_alert_counts(self) -> dict[str, int]:
        """各子系统未确认告警数（设备台账列表用）。"""
        c = self._require()
        cursor = await c.execute("SELECT payload FROM ai_alerts WHERE acked=0")
        rows = await cursor.fetchall()
        counts: Counter[str] = Counter()
        for r in rows:
            try:
                sid = json.loads(r["payload"]).get("subsystem_id")
            except Exception:  # noqa: BLE001
                sid = None
            if sid:
                counts[str(sid)] += 1
        return dict(counts)

    async def load_equipment_runtime(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute("SELECT subsystem_id, total_sec, day, today_sec FROM equipment_runtime")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def save_equipment_runtime(self, rows: list[tuple[str, float, str, float]]) -> None:
        """批量 upsert 运行时长（subsystem_id, total_sec, day, today_sec）。"""
        if not rows:
            return
        async with self._lock:
            c = self._require()
            await c.executemany(
                "INSERT OR REPLACE INTO equipment_runtime(subsystem_id, total_sec, day, today_sec)"
                " VALUES(?,?,?,?)",
                rows,
            )
            await c.commit()

    # ---------- 遥测采样 ----------

    async def add_sample(self, wind: float, temp: float, safety: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            c = self._require()
            await c.execute(
                "INSERT INTO telemetry_samples(ts, wind_speed, temperature, safety, payload) VALUES(?,?,?,?,?)",
                (local_now().isoformat(timespec="seconds"), wind, temp, safety, json.dumps(payload, ensure_ascii=False)),
            )
            self._sample_counter += 1
            if self._sample_counter % SAMPLE_PRUNE_EVERY == 0:
                # 低频批量裁剪，保留最近 TELEMETRY_MAX_ROWS 条
                await c.execute(
                    "DELETE FROM telemetry_samples WHERE id NOT IN "
                    "(SELECT id FROM telemetry_samples ORDER BY id DESC LIMIT ?)",
                    (TELEMETRY_MAX_ROWS,),
                )
            await c.commit()

    async def history(self, limit: int = 300) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute(
            "SELECT ts, wind_speed, temperature, safety FROM telemetry_samples ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        data = [dict(r) for r in rows]
        data.reverse()
        return data

    # ---------- 宽表遥测（telemetry_wide，1Hz 多测点 JSON 行） ----------

    async def add_wide_sample(self, values: dict[str, float]) -> None:
        """每秒一行写入关键测点当前值（values 键为 "subsystem.point"）。"""
        async with self._lock:
            c = self._require()
            await c.execute(
                'INSERT INTO telemetry_wide(ts, "values") VALUES(?,?)',
                (local_now().isoformat(timespec="seconds"), json.dumps(values, ensure_ascii=False)),
            )
            await c.commit()

    async def query_wide(self, ts_from: str, ts_to: str) -> list[tuple[str, dict[str, Any]]]:
        """按时间窗读取宽表行（升序），返回 [(ts, values), ...]。"""
        c = self._require()
        cursor = await c.execute(
            'SELECT ts, "values" FROM telemetry_wide WHERE ts >= ? AND ts <= ? ORDER BY ts ASC',
            (ts_from, ts_to),
        )
        rows = await cursor.fetchall()
        out: list[tuple[str, dict[str, Any]]] = []
        for r in rows:
            try:
                out.append((r["ts"], json.loads(r["values"])))
            except Exception:  # noqa: BLE001
                logger.warning("跳过无法解析的宽表行: ts=%s", r["ts"])
        return out

    # ---------- 统计汇总（数据中心统计分析页） ----------

    async def stats_overview(self, days: int) -> dict[str, Any]:
        """近 N 天运行统计：实验 / 矩阵 / run / 告警 / 审计操作量。"""
        now = local_now()
        cutoff = (now - timedelta(days=days)).isoformat()
        c = self._require()

        # 实验：按场景 / 阶段分组
        cursor = await c.execute("SELECT payload FROM experiments WHERE created_at >= ?", (cutoff,))
        exps = [json.loads(r["payload"]) for r in await cursor.fetchall()]
        exp_by_scenario: dict[str, int] = {}
        exp_by_phase: dict[str, int] = {}
        for e in exps:
            exp_by_scenario[e.get("scenario", "未知")] = exp_by_scenario.get(e.get("scenario", "未知"), 0) + 1
            exp_by_phase[e.get("phase", "未知")] = exp_by_phase.get(e.get("phase", "未知"), 0) + 1

        # 采集 run：总数 / 完成数 / 平均采集时长；矩阵工况行成功率
        cursor = await c.execute(
            "SELECT status, started_at, ended_at, matrix_id FROM experiment_runs WHERE created_at >= ?",
            (cutoff,),
        )
        runs = [dict(r) for r in await cursor.fetchall()]
        durations: list[float] = []
        matrix_rows_total = 0
        matrix_rows_completed = 0
        for r in runs:
            if r.get("matrix_id"):
                matrix_rows_total += 1
                if r["status"] == "completed":
                    matrix_rows_completed += 1
            if r["status"] == "completed" and r.get("started_at") and r.get("ended_at"):
                try:
                    dt = (datetime.fromisoformat(r["ended_at"]) - datetime.fromisoformat(r["started_at"])).total_seconds()
                    if dt >= 0:
                        durations.append(dt)
                except ValueError:
                    pass
        run_completed = sum(1 for r in runs if r["status"] == "completed")

        # 矩阵执行次数（审计动作"启动矩阵"）+ 审计操作量 top
        cursor = await c.execute("SELECT payload FROM audit_log WHERE ts >= ?", (cutoff,))
        audits = [json.loads(r["payload"]) for r in await cursor.fetchall()]
        action_counts: Counter[str] = Counter(a.get("action", "未知") for a in audits)
        matrix_executions = action_counts.get("启动矩阵", 0)

        # 告警：按 severity / 按子系统 top5 / 按天分布（补齐无告警日期）
        cursor = await c.execute("SELECT payload, ts, severity FROM ai_alerts WHERE ts >= ?", (cutoff,))
        alert_rows = await cursor.fetchall()
        by_severity = {"info": 0, "warning": 0, "alarm": 0, "critical": 0}
        by_subsystem: Counter[str] = Counter()
        by_day: Counter[str] = Counter()
        for r in alert_rows:
            sev = r["severity"] if r["severity"] in by_severity else "info"
            by_severity[sev] += 1
            day = (r["ts"] or "")[:10]
            if day:
                by_day[day] += 1
            try:
                payload = json.loads(r["payload"])
                name = payload.get("subsystem_name") or payload.get("subsystem_id") or "全局"
            except Exception:  # noqa: BLE001
                name = "全局"
            by_subsystem[name] += 1
        day_series: list[dict[str, Any]] = []
        for i in range(days - 1, -1, -1):
            d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
            day_series.append({"day": d, "count": by_day.get(d, 0)})

        return {
            "days": days,
            "from": cutoff,
            "to": now.isoformat(timespec="seconds"),
            "experiments": {
                "total": len(exps),
                "by_scenario": [{"name": k, "count": v} for k, v in sorted(exp_by_scenario.items(), key=lambda x: -x[1])],
                "by_phase": [{"name": k, "count": v} for k, v in sorted(exp_by_phase.items(), key=lambda x: -x[1])],
            },
            "runs": {
                "total": len(runs),
                "completed": run_completed,
                "avg_duration_sec": round(sum(durations) / len(durations), 1) if durations else None,
            },
            "matrices": {
                "executions": matrix_executions,
                "rows_total": matrix_rows_total,
                "rows_completed": matrix_rows_completed,
                "success_rate": round(matrix_rows_completed / matrix_rows_total, 4) if matrix_rows_total else None,
            },
            "alerts": {
                "total": len(alert_rows),
                "by_severity": by_severity,
                "by_subsystem": [{"name": k, "count": v} for k, v in by_subsystem.most_common(5)],
                "by_day": day_series,
            },
            "audit": {
                "total": len(audits),
                "top_actions": [{"action": k, "count": v} for k, v in action_counts.most_common(8)],
            },
        }

    # ---------- 巡检告警（分级 + 去重状态机） ----------

    async def sync_ai_alerts(self, alerts: list[dict[str, Any]]) -> None:
        """以本轮巡检结果同步告警表：

        - 同 dedupe_key 且未恢复(active=1)的告警：更新内容/时间/次数，不插新行；
        - 新出现的告警：插入；
        - 本轮未再出现且仍 active 的告警：自动关闭(active=0)。
        """
        now = local_now().isoformat(timespec="seconds")
        incoming_keys = {a["dedupe_key"] for a in alerts}
        async with self._lock:
            c = self._require()
            for a in alerts:
                cursor = await c.execute(
                    "SELECT id, count FROM ai_alerts WHERE dedupe_key=? AND active=1",
                    (a["dedupe_key"],),
                )
                row = await cursor.fetchone()
                if row:
                    payload = dict(a)
                    payload["id"] = row["id"]
                    payload["count"] = int(row["count"]) + 1
                    await c.execute(
                        "UPDATE ai_alerts SET payload=?, ts=?, severity=?, count=?, updated_at=? WHERE id=?",
                        (
                            json.dumps(payload, ensure_ascii=False),
                            a["ts"],
                            a["severity"],
                            payload["count"],
                            now,
                            row["id"],
                        ),
                    )
                else:
                    await c.execute(
                        "INSERT OR REPLACE INTO ai_alerts"
                        "(id, payload, ts, acked, severity, dedupe_key, active, count, updated_at)"
                        " VALUES(?,?,?,0,?,?,1,1,?)",
                        (
                            a["id"],
                            json.dumps(a, ensure_ascii=False),
                            a["ts"],
                            a["severity"],
                            a["dedupe_key"],
                            now,
                        ),
                    )
            if incoming_keys:
                placeholders = ",".join("?" for _ in incoming_keys)
                # 联锁告警（dedupe_key 以 interlock: 开头）由 InterlockEngine 自行恢复，不在巡检同步的关闭范围
                await c.execute(
                    f"UPDATE ai_alerts SET active=0, updated_at=? WHERE active=1"
                    f" AND dedupe_key NOT IN ({placeholders}) AND dedupe_key NOT LIKE 'interlock:%'",
                    (now, *incoming_keys),
                )
            else:
                await c.execute(
                    "UPDATE ai_alerts SET active=0, updated_at=? WHERE active=1 AND dedupe_key NOT LIKE 'interlock:%'", (now,)
                )
            await c.commit()

    async def list_ai_alerts(
        self,
        limit: int = 50,
        severity: str | None = None,
        active: bool | None = None,
        acked: bool | None = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT payload, acked, acked_by, acked_at, severity, active, count FROM ai_alerts"
        conds: list[str] = []
        params: list[Any] = []
        if severity:
            conds.append("severity=?")
            params.append(severity)
        if active is not None:
            conds.append("active=?")
            params.append(1 if active else 0)
        if acked is not None:
            conds.append("acked=?")
            params.append(1 if acked else 0)
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        c = self._require()
        cursor = await c.execute(sql, params)
        rows = await cursor.fetchall()
        out = []
        for r in rows:
            item = json.loads(r["payload"])
            item["acked"] = bool(r["acked"])
            item["acked_by"] = r["acked_by"]
            item["acked_at"] = r["acked_at"]
            item["severity"] = r["severity"]
            item["active"] = bool(r["active"])
            item["count"] = r["count"]
            out.append(item)
        return out

    async def ack_ai_alert(self, alert_id: str, acked_by: str = "") -> bool:
        async with self._lock:
            c = self._require()
            cursor = await c.execute(
                "UPDATE ai_alerts SET acked=1, acked_by=?, acked_at=? WHERE id=?",
                (acked_by, local_now().isoformat(timespec="seconds"), alert_id),
            )
            await c.commit()
            return cursor.rowcount > 0

    async def ack_all_ai_alerts(self, acked_by: str = "") -> int:
        """一键确认全部未确认告警（含已恢复的历史未确认），返回确认条数。"""
        async with self._lock:
            c = self._require()
            cursor = await c.execute(
                "UPDATE ai_alerts SET acked=1, acked_by=?, acked_at=? WHERE acked=0",
                (acked_by, local_now().isoformat(timespec="seconds")),
            )
            await c.commit()
            return cursor.rowcount

    async def ai_alert_summary(self) -> dict[str, int]:
        """各级别未确认且未恢复的告警计数（报警横幅用）。"""
        c = self._require()
        cursor = await c.execute(
            "SELECT severity, COUNT(*) AS n FROM ai_alerts WHERE acked=0 AND active=1 GROUP BY severity"
        )
        rows = await cursor.fetchall()
        summary = {"info": 0, "warning": 0, "alarm": 0, "critical": 0}
        for r in rows:
            if r["severity"] in summary:
                summary[r["severity"]] = r["n"]
        summary["total"] = sum(summary.values())
        return summary

    async def prune_ai_alerts(self, max_rows: int = ALERT_DEFAULT_MAX_ROWS) -> int:
        """告警表上限控制：优先裁剪最旧的已关闭记录。"""
        async with self._lock:
            c = self._require()
            cursor = await c.execute("SELECT COUNT(*) AS n FROM ai_alerts")
            total = (await cursor.fetchone())["n"]
            removed = 0
            if total > max_rows:
                excess = total - max_rows
                cur = await c.execute(
                    "DELETE FROM ai_alerts WHERE id IN "
                    "(SELECT id FROM ai_alerts WHERE active=0 ORDER BY ts ASC LIMIT ?)",
                    (excess,),
                )
                removed += cur.rowcount
                if removed < excess:
                    cur = await c.execute(
                        "DELETE FROM ai_alerts WHERE id IN "
                        "(SELECT id FROM ai_alerts ORDER BY ts ASC LIMIT ?)",
                        (excess - removed,),
                    )
                    removed += cur.rowcount
                await c.commit()
                if removed:
                    logger.info("ai_alerts 裁剪 %d 条（上限 %d）", removed, max_rows)
            return removed

    # ---------- 健康基线 ----------

    async def load_health_baselines(self) -> list[dict[str, Any]]:
        c = self._require()
        cursor = await c.execute(
            "SELECT subsystem, point, baseline_mean, baseline_std, sample_count, updated_at FROM health_baselines"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def save_health_baselines(self, rows: list[dict[str, Any]]) -> None:
        """批量 upsert 健康基线（单事务）。"""
        if not rows:
            return
        async with self._lock:
            c = self._require()
            await c.executemany(
                "INSERT OR REPLACE INTO health_baselines"
                "(subsystem, point, baseline_mean, baseline_std, sample_count, updated_at)"
                " VALUES(?,?,?,?,?,?)",
                [
                    (
                        r["subsystem"],
                        r["point"],
                        float(r["baseline_mean"]),
                        float(r["baseline_std"]),
                        int(r["sample_count"]),
                        r.get("updated_at", local_now().isoformat(timespec="seconds")),
                    )
                    for r in rows
                ],
            )
            await c.commit()

    async def delete_health_baselines(self, subsystem: str) -> int:
        async with self._lock:
            c = self._require()
            cursor = await c.execute(
                "DELETE FROM health_baselines WHERE subsystem=?", (subsystem,)
            )
            await c.commit()
            return cursor.rowcount

    # ---------- 保留策略清理 ----------

    async def apply_retention(
        self,
        history_days: int,
        audit_days: int,
        alert_max_rows: int,
    ) -> dict[str, int]:
        """按保留策略立即清理，返回各表删除行数。"""
        now = local_now()
        result = {"telemetry_samples": 0, "telemetry_wide": 0, "audit_log": 0, "ai_alerts": 0, "experiment_runs": 0, "run_samples": 0}
        async with self._lock:
            c = self._require()
            cutoff_h = (now - timedelta(days=history_days)).isoformat()
            cur = await c.execute("DELETE FROM telemetry_samples WHERE ts < ?", (cutoff_h,))
            result["telemetry_samples"] = cur.rowcount
            cur = await c.execute("DELETE FROM telemetry_wide WHERE ts < ?", (cutoff_h,))
            result["telemetry_wide"] = cur.rowcount
            cutoff_a = (now - timedelta(days=audit_days)).isoformat()
            cur = await c.execute("DELETE FROM audit_log WHERE ts < ?", (cutoff_a,))
            result["audit_log"] = cur.rowcount
            # 过期 run 及其采样一并清理（samples 行数大，按 run 归属删除）
            cur = await c.execute("DELETE FROM experiment_runs WHERE created_at < ?", (cutoff_h,))
            result["experiment_runs"] = cur.rowcount
            cur = await c.execute(
                "DELETE FROM run_samples WHERE run_id NOT IN (SELECT id FROM experiment_runs)"
            )
            result["run_samples"] = cur.rowcount
            await c.commit()
        result["ai_alerts"] = await self.prune_ai_alerts(alert_max_rows)
        logger.info("保留策略清理完成: %s", result)
        return result

    # ---------- 存储统计 ----------

    async def storage_stats(self) -> dict[str, Any]:
        c = self._require()
        tables: dict[str, int] = {}
        for t in TABLES:
            try:
                cursor = await c.execute(f"SELECT COUNT(*) AS n FROM {t}")
                tables[t] = (await cursor.fetchone())["n"]
            except Exception as exc:  # noqa: BLE001
                logger.warning("统计表 %s 行数失败: %s", t, exc)
                tables[t] = -1
        cursor = await c.execute("PRAGMA page_count")
        page_count = (await cursor.fetchone())[0]
        cursor = await c.execute("PRAGMA page_size")
        page_size = (await cursor.fetchone())[0]
        file_size = self.path.stat().st_size if self.path.exists() else 0
        wal = self.path.with_suffix(self.path.suffix + "-wal")
        wal_size = wal.stat().st_size if wal.exists() else 0
        return {
            "db_path": str(self.path),
            "db_file_bytes": file_size,
            "wal_file_bytes": wal_size,
            "estimated_bytes": page_count * page_size,
            "tables": tables,
        }

    # ---------- 备份 / 恢复 ----------

    async def backup_to(self, dest: Path) -> None:
        """使用 SQLite 在线备份 API 复制到目标文件。"""
        async with self._lock:
            src = self._require()
            target = await aiosqlite.connect(dest)
            try:
                await src.backup(target)
            finally:
                await target.close()

    async def replace_with(self, src: Path) -> None:
        """用备份文件替换当前库（先关连接再拷贝再重开，供恢复用，调用方需先自行备份）。"""
        async with self._lock:
            if self._conn is not None:
                await self._conn.close()
                self._conn = None
            shutil.copyfile(src, self.path)
            conn = await aiosqlite.connect(self.path)
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA journal_mode=WAL")
            await conn.execute("PRAGMA synchronous=NORMAL")
            self._conn = conn


store = Store()
