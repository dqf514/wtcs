"""MQTT 遥测发布通道（可选，IT/OT 融合准备）。

- paho-mqtt 为可选依赖：未安装时本模块优雅降级——开启 mqtt_enabled 仅记录
  警告日志，不影响服务运行；
- 开启后按 1Hz 抽稀发布全部测点 JSON 到 `<mqtt_topic_prefix>/<subsystem>/<point>`；
- 运行期修改 mqtt_host/mqtt_port/mqtt_topic_prefix 自动重连。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable

from app.adapters.registry import registry
from app.models.schemas import local_now

logger = logging.getLogger(__name__)

try:
    import paho.mqtt.client as mqtt
except ImportError:  # 可选依赖，未安装时降级
    mqtt = None  # type: ignore[assignment]

PUBLISH_INTERVAL_SEC = 1.0  # 10Hz 快照抽稀到 1Hz 发布


def available() -> bool:
    return mqtt is not None


async def run(settings_getter: Callable[[], dict[str, Any]]) -> None:
    """发布主循环（由 RuntimeHub 托管为后台任务，可取消）。"""
    client: Any = None
    cfg_sig: tuple | None = None
    warned_missing = False
    last_pub = 0.0
    try:
        while True:
            cfg = settings_getter()
            enabled = bool(cfg.get("mqtt_enabled", False))
            if not enabled:
                if client is not None:
                    try:
                        client.loop_stop()
                        client.disconnect()
                    except Exception:  # noqa: BLE001
                        logger.warning("MQTT 断开失败", exc_info=True)
                    client, cfg_sig = None, None
                    logger.info("MQTT 发布通道已停用")
                await asyncio.sleep(2.0)
                continue

            if mqtt is None:
                if not warned_missing:
                    logger.warning(
                        "MQTT 已启用，但未安装可选依赖 paho-mqtt，发布通道不生效；"
                        "请执行 pip install paho-mqtt 后重试"
                    )
                    warned_missing = True
                await asyncio.sleep(5.0)
                continue
            warned_missing = False

            host = str(cfg.get("mqtt_host", "127.0.0.1"))
            port = int(cfg.get("mqtt_port", 1883))
            prefix = str(cfg.get("mqtt_topic_prefix", "wtcs")).strip("/") or "wtcs"
            sig = (host, port, prefix)
            if client is None or sig != cfg_sig:
                if client is not None:
                    try:
                        client.loop_stop()
                        client.disconnect()
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    client = mqtt.Client(client_id=f"wtcs-{int(time.time())}")
                    client.connect_async(host, port, keepalive=30)
                    client.loop_start()
                    cfg_sig = sig
                    logger.info("MQTT 发布通道连接中: %s:%d，前缀 %s", host, port, prefix)
                except Exception:  # noqa: BLE001
                    logger.exception("MQTT 客户端创建失败")
                    client = None
                    await asyncio.sleep(10.0)
                    continue

            if time.monotonic() - last_pub >= PUBLISH_INTERVAL_SEC:
                try:
                    await _publish_once(client, prefix)
                    last_pub = time.monotonic()
                except Exception:  # noqa: BLE001
                    logger.warning("MQTT 发布失败，将在下个周期重试", exc_info=True)
            await asyncio.sleep(0.5)
    finally:
        if client is not None:
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:  # noqa: BLE001
                pass


async def _publish_once(client: Any, prefix: str) -> None:
    """发布一帧全量测点快照：topic=<prefix>/<subsystem>/<point>，retained JSON。"""
    ts = local_now().isoformat(timespec="seconds")
    for ad in registry.all():
        try:
            st = await ad.read_status()
        except Exception:  # noqa: BLE001
            logger.warning("MQTT 发布读取 %s 失败", ad.subsystem_id.value, exc_info=True)
            continue
        sid = ad.subsystem_id.value
        for p in st.points:
            payload = json.dumps(
                {"value": p.value, "unit": p.unit, "ts": ts}, ensure_ascii=False
            )
            client.publish(f"{prefix}/{sid}/{p.key}", payload, qos=0, retain=True)
