from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect

from app.api.v1.router import api_router
from app.core.auth import require_internal_api_key
from app.core.config import get_settings
from app.core.database import SessionLocal, engine
from app.services.security import ensure_default_admin


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if inspect(engine).has_table("users"):
        with SessionLocal() as db:
            ensure_default_admin(
                db,
                email=settings.default_admin_email,
                password=settings.default_admin_password,
                name=settings.default_admin_name,
            )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Anotator CVAT Backend",
        version="0.1.0",
        description="Backend for CVAT orchestration, review, releases, training and pipelines.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def internal_api_key_middleware(request, call_next):
        return await require_internal_api_key(request, call_next, settings)

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
