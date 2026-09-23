"""联锁矩阵：可配置的安全联锁规则引擎。

三类规则：
- alarm     报警：condition 为真 = 违规 → 产生分级告警（dedupe_key=interlock:<id>，恢复自动关闭）
- block     许可/拦截：condition 是必须成立的许可条件（guard），
            对 target_subsystem.target_command 下发时 guard 不成立 → 拒绝执行
- auto_stop 自动停车：condition 为真 = 违规 → 告警 + 自动对 target_subsystem 下发 target_command（默认 stop）

表达式：安全 AST 求值，变量形如 `main_fan.wind_speed`（子系统.测点），
支持 and/or/not、比较、加减乘除、括号、abs()。求值失败对 block 视为不许可（fail-safe），
对 alarm/auto_stop 视为不触发，并在真值表标记 error。
"""
from __future__ import annotations

import ast
import logging
import time
import uuid
from typing import Any

from app.models.schemas import SubsystemId, local_now
from app.services.store import store

logger = logging.getLogger(__name__)

KINDS = ("alarm", "block", "auto_stop")
SEVERITIES = ("info", "warning", "alarm", "critical")

ALLOWED_FUNCS = {"abs": abs, "min": min, "max": max}


class ExprError(ValueError):
    pass


def _check_node(node: ast.AST) -> None:
    """白名单校验 AST 节点，杜绝任意代码执行。"""
    allowed = (
        ast.Expression, ast.BoolOp, ast.BinOp, ast.UnaryOp, ast.Compare,
        ast.And, ast.Or, ast.Not, ast.USub, ast.UAdd,
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod,
        ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
        ast.Name, ast.Attribute, ast.Constant, ast.Call, ast.Load,
    )
    for n in ast.walk(node):
        if not isinstance(n, allowed):
            raise ExprError(f"不允许的语法：{type(n).__name__}")
        if isinstance(n, ast.Call):
            if not (isinstance(n.func, ast.Name) and n.func.id in ALLOWED_FUNCS):
                raise ExprError("仅允许 abs/min/max 函数")
        if isinstance(n, ast.Attribute) and n.attr.startswith("_"):
            raise ExprError("不允许访问下划线属性")
        if isinstance(n, ast.Name) and n.id.startswith("_"):
            raise ExprError("不允许下划线变量")


def compile_expr(expr: str) -> ast.Expression:
    """编译并校验表达式；非法时抛 ExprError（供 API 返回 400）。"""
    expr = (expr or "").strip()
    if not expr:
        raise ExprError("表达式不能为空")
    if len(expr) > 500:
        raise ExprError("表达式过长")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as exc:
        raise ExprError(f"语法错误：{exc.msg}") from exc
    _check_node(tree)
    return tree


def eval_expr(tree: ast.Expression, values: dict[str, dict[str, Any]]) -> Any:
    """在测点值上下文 {subsystem_id: {point_key: value}} 中求值。"""

    def ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float, bool)):
                raise ExprError("仅支持数字/布尔常量")
            return node.value
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            sid, key = node.value.id, node.attr
            v = values.get(sid, {}).get(key)
            if v is None:
                raise ExprError(f"测点无值：{sid}.{key}")
            return v
        if isinstance(node, ast.Name):
            raise ExprError(f"未知变量：{node.id}（应为 子系统.测点，如 main_fan.wind_speed）")
        if isinstance(node, ast.BoolOp):
            vals = [bool(ev(x)) for x in node.values]
            return all(vals) if isinstance(node.op, ast.And) else any(vals)
        if isinstance(node, ast.UnaryOp):
            v = ev(node.operand)
            return (not bool(v)) if isinstance(node.op, ast.Not) else (-v if isinstance(node.op, ast.USub) else +v)
        if isinstance(node, ast.BinOp):
            a, b = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Add):
                return a + b
            if isinstance(node.op, ast.Sub):
                return a - b
            if isinstance(node.op, ast.Mult):
                return a * b
            if isinstance(node.op, ast.Div):
                return a / b
            return a % b
        if isinstance(node, ast.Compare):
            left = ev(node.left)
            for op, comp in zip(node.ops, node.comparators):
                right = ev(comp)
                ok = (
                    left == right if isinstance(op, ast.Eq)
                    else left != right if isinstance(op, ast.NotEq)
                    else left < right if isinstance(op, ast.Lt)
                    else left <= right if isinstance(op, ast.LtE)
                    else left > right if isinstance(op, ast.Gt)
                    else left >= right
                )
                if not ok:
                    return False
                left = right
            return True
        if isinstance(node, ast.Call):
            return ALLOWED_FUNCS[node.func.id](*[ev(a) for a in node.args])
        raise ExprError(f"不支持的表达式节点：{type(node).__name__}")

    return ev(tree)


def validate_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """校验并规范化一条联锁规则；非法抛 ExprError。"""
    name = str(rule.get("name") or "").strip()
    if not name:
        raise ExprError("规则名称不能为空")
    kind = rule.get("kind")
    if kind not in KINDS:
        raise ExprError(f"规则类型须为 {'/'.join(KINDS)}")
    condition = str(rule.get("condition") or "").strip()
    compile_expr(condition)  # 仅校验语法
    severity = rule.get("severity") or "alarm"
    if severity not in SEVERITIES:
        raise ExprError(f"级别须为 {'/'.join(SEVERITIES)}")
    target_sub = str(rule.get("target_subsystem") or "").strip()
    target_cmd = str(rule.get("target_command") or "").strip()
    if kind in ("block", "auto_stop"):
        if not target_sub:
            raise ExprError("拦截/自动停车规则必须指定目标子系统")
        try:
            SubsystemId(target_sub)
        except ValueError as exc:
            raise ExprError(f"未知目标子系统：{target_sub}") from exc
    if kind == "block" and not target_cmd:
        raise ExprError("拦截规则必须指定目标指令（如 start，或 * 表示全部）")
    if kind == "auto_stop" and not target_cmd:
        target_cmd = "stop"
    return {
        "name": name,
        "kind": kind,
        "enabled": 1 if rule.get("enabled", 1) else 0,
        "condition": condition,
        "severity": severity,
        "target_subsystem": target_sub,
        "target_command": target_cmd,
        "message": str(rule.get("message") or "").strip(),
    }


# 内置默认规则（种子；builtin=1，用户可改可删）
DEFAULT_RULES: list[dict[str, Any]] = [
    {
        "id": "il_belt_follow",
        "name": "路面速度跟随联锁",
        "kind": "alarm",
        "enabled": 1,
        "condition": "main_fan.wind_speed > 30 and rrs.belt_speed < main_fan.wind_speed * 0.8",
        "severity": "warning",
        "target_subsystem": "",
        "target_command": "",
        "message": "有风工况下路面速度未跟随风速（低于 80%），请启动滚动路面或降风速",
    },
    {
        "id": "il_fan_start_perm",
        "name": "主风机启动许可",
        "kind": "block",
        "enabled": 1,
        "condition": "cooling_water.running and compressed_air.running and purge_air.running and exhaust.running",
        "severity": "alarm",
        "target_subsystem": "main_fan",
        "target_command": "start",
        "message": "辅机未全部运行（冷却水/压缩空气/吹扫风/尾气抽排），禁止启动主风机——请使用一键开车",
    },
    {
        "id": "il_belt_start_perm",
        "name": "路面启动许可",
        "kind": "block",
        "enabled": 1,
        "condition": "main_fan.wind_speed < 5 or rrs.belt_speed >= main_fan.wind_speed * 0.5",
        "severity": "alarm",
        "target_subsystem": "rrs",
        "target_command": "start",
        "message": "高风速下禁止冷启动路面（需先跟随至风速 50% 以上）",
    },
    {
        "id": "il_wind_overstop",
        "name": "风速极限自动停车",
        "kind": "auto_stop",
        "enabled": 1,
        "condition": "main_fan.wind_speed > 118",
        "severity": "critical",
        "target_subsystem": "main_fan",
        "target_command": "stop",
        "message": "风速接近设计极限（>118 m/s），联锁自动停主风机",
    },
]


async def seed_interlocks() -> None:
    """启动时把内置规则写入库（已存在则跳过，不覆盖用户修改）。"""
    existing = {r["id"] for r in await store.list_interlocks()}
    for r in DEFAULT_RULES:
        if r["id"] not in existing:
            await store.upsert_interlock(r["id"], **{k: v for k, v in r.items() if k != "id"}, builtin=True, updated_by="system")
            logger.info("内置联锁规则已入库: %s", r["id"])


class InterlockEngine:
    """联锁求值与执行：每遥测周期求值一次，迁移沿触发动作。"""

    def __init__(self, audit: Any, dispatch: Any) -> None:
        self._audit = audit
        # dispatch(subsystem_id, command, params) —— 由 hub 注入，用于 auto_stop
        self._dispatch = dispatch
        self._prev: dict[str, bool] = {}       # rule_id -> 上一周期违规态
        self._errors: dict[str, str] = {}      # rule_id -> 求值错误
        self._values: dict[str, dict[str, Any]] = {}
        self.status: list[dict[str, Any]] = []  # 真值表快照（遥测推送）
        self._compiled: dict[str, tuple[str, ast.Expression]] = {}  # id -> (condition, tree) 缓存

    def _tree(self, rule: dict[str, Any]) -> ast.Expression:
        key = rule["id"]
        cond = rule["condition"]
        cached = self._compiled.get(key)
        if cached and cached[0] == cond:
            return cached[1]
        tree = compile_expr(cond)
        self._compiled[key] = (cond, tree)
        return tree

    def check_command(self, subsystem_id: str, command: str) -> str | None:
        """指令许可检查：返回 None 放行，否则返回拦截原因（含规则名）。"""
        for st in self.status:
            if st["kind"] != "block" or not st["enabled"]:
                continue
            if st["target_subsystem"] != subsystem_id:
                continue
            if st["target_command"] not in (command, "*"):
                continue
            if not st["pass"]:
                return f"联锁拦截「{st['name']}」：{st['message'] or '许可条件不成立'}"
        return None

    async def evaluate(self, values: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        """以最新测点值求值全部启用规则，处理违规迁移沿（告警/自动停车）。"""
        self._values = values
        rules = await store.list_interlocks()
        now = local_now().isoformat(timespec="seconds")
        status: list[dict[str, Any]] = []
        for rule in rules:
            rid = rule["id"]
            violated = False
            err = ""
            if rule["enabled"]:
                try:
                    violated = bool(eval_expr(self._tree(rule), values))
                    self._errors.pop(rid, None)
                except Exception as exc:  # noqa: BLE001
                    err = str(exc)
                    self._errors[rid] = err
            is_block = rule["kind"] == "block"
            # block：condition 是许可条件，pass=许可成立；alarm/auto_stop：pass=未违规
            passed = (not violated) if not is_block else violated
            if is_block and err:
                passed = False  # fail-safe：求值失败视为不许可
            prev = self._prev.get(rid, False)
            status.append({
                "id": rid,
                "name": rule["name"],
                "kind": rule["kind"],
                "enabled": bool(rule["enabled"]),
                "condition": rule["condition"],
                "severity": rule["severity"],
                "target_subsystem": rule["target_subsystem"],
                "target_command": rule["target_command"],
                "message": rule["message"],
                "violated": violated,
                "pass": passed,
                "error": err,
                "last_triggered": rule.get("last_triggered") or "",
                "trigger_count": int(rule.get("trigger_count") or 0),
            })
            # 迁移沿：仅 alarm/auto_stop 在 未违规→违规 时动作
            if rule["enabled"] and not err and violated and not prev and not is_block:
                await self._on_trip(rule, now)
            self._prev[rid] = violated
        self.status = status
        return status

    async def _on_trip(self, rule: dict[str, Any], now: str) -> None:
        rid = rule["id"]
        msg = rule["message"] or f"联锁触发：{rule['name']}"
        await store.activate_interlock_alert({
            "id": uuid.uuid4().hex[:12],
            "level": rule["severity"],
            "severity": rule["severity"],
            "dedupe_key": f"interlock:{rid}",
            "subsystem_id": rule["target_subsystem"] or "safety",
            "subsystem_name": "联锁矩阵",
            "message": msg,
            "ts": now,
            "source": "联锁矩阵",
            "active": True,
            "count": 1,
        })
        await store.mark_interlock_triggered(rid, now)
        await self._audit.add("system", "系统", "联锁触发", f"「{rule['name']}」{msg}", rule["target_subsystem"] or None)
        logger.warning("联锁触发: %s (%s) — %s", rule["name"], rid, msg)
        if rule["kind"] == "auto_stop":
            t0 = time.monotonic()
            try:
                result = await self._dispatch(rule["target_subsystem"], rule["target_command"] or "stop", {})
                await self._audit.add(
                    "system", "系统", "联锁自动执行",
                    f"「{rule['name']}」→ {rule['target_subsystem']}.{rule['target_command'] or 'stop'}：{result}（{time.monotonic()-t0:.2f}s）",
                    rule["target_subsystem"],
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("联锁自动执行失败: %s", rid)
                await self._audit.add("system", "系统", "联锁自动执行失败", f"「{rule['name']}」{exc}", rule["target_subsystem"])

    def forget(self, rule_id: str) -> None:
        """删除规则后清理引擎内缓存态。"""
        self._prev.pop(rule_id, None)
        self._errors.pop(rule_id, None)
        self._compiled.pop(rule_id, None)
        self.status = [st for st in self.status if st["id"] != rule_id]

    async def clear_resolved(self) -> None:
        """把当前未违规的联锁告警置为已恢复（sync_ai_alerts 不接管 interlock: 域）。"""
        resolved = [
            st["id"] for st in self.status
            if st["enabled"] and not st["violated"] and not st["error"] and st["kind"] != "block"
        ]
        if resolved:
            await store.resolve_interlock_alerts([f"interlock:{rid}" for rid in resolved])
