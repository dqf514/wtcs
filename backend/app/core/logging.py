"""全局日志配置：控制台 + 轮转文件。"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from app.core.config import DATA_DIR

LOG_DIR = DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "wtcs.log"

_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"

_initialized = False


def setup_logging(level: int = logging.INFO) -> None:
    """初始化 logging，幂等。控制台 + 轮转文件（10MB x 5）。"""
    global _initialized
    if _initialized:
        return
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(level)

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(console)

    file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(file_handler)

    _initialized = True
    logging.getLogger(__name__).info("日志系统初始化完成，文件: %s", LOG_FILE)
