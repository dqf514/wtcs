import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import DEFAULT_JWT_SECRET, settings
from app.core.logging import setup_logging
from app.services.runtime import hub
from app.services.store import store

setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.jwt_secret == DEFAULT_JWT_SECRET:
        logger.warning(
            "JWT 密钥为默认值，存在安全风险！请设置环境变量 WTCS_SECRET_KEY 后再上线。"
        )
    logger.info("WTCS 启动中：%s v%s", settings.app_name, settings.version)
    await store.init()
    from app.core.auth import ensure_default_users

    await ensure_default_users()
    await hub.start()
    yield
    await hub.stop()
    await store.close()
    logger.info("WTCS 已关闭")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="合肥汽车风洞 WTCS：建设期全仿真 Web 服务，子系统上线仅做接口对接与连通性测试。",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")


@app.get("/")
async def root():
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "message": "请打开前端开发服务器或访问 /docs 查看 API",
    }
