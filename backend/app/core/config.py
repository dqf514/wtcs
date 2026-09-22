from pathlib import Path

from pydantic_settings import BaseSettings

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
BACKUP_DIR = DATA_DIR / "backups"

DEFAULT_JWT_SECRET = "wtcs-dev-secret-change-in-production"


class Settings(BaseSettings):
    app_name: str = "合肥汽车风洞 WTCS"
    app_version: str = "0.1.0"
    version: str = "2.0.0"
    debug: bool = True
    # 建设期默认仿真；真机上线改环境变量 WTCS_FORCE_SIMULATION=false 并改 yaml
    force_simulation: bool = True
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_expire_hours: int = 12
    database_url: str = f"sqlite+aiosqlite:///{DATA_DIR / 'wtcs.db'}"
    telemetry_hz: float = 10.0
    timezone: str = "Asia/Shanghai"
    # 服务监听信息（供 /api/system/network 只读展示；实际监听由 uvicorn 启动参数决定）
    host: str = "127.0.0.1"
    port: int = 8000
    # CORS 允许来源，逗号分隔
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    class Config:
        env_prefix = "WTCS_"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
