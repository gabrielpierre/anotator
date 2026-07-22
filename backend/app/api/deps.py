from collections.abc import Generator

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Project, ProjectMember, User
from app.services.security import ensure_default_admin, load_user_for_token


def db_session() -> Generator[Session, None, None]:
    yield from get_db()


def current_user(
    request: Request,
    db: Session = Depends(db_session),
) -> User:
    settings = get_settings()
    if getattr(request.state, "internal_api_key_authenticated", False):
        try:
            user = db.scalar(
                select(User).where(User.role == "admin", User.status == "active").order_by(User.created_at)
            )
        except OperationalError:
            return User(
                id="internal-api-key",
                name="Internal API Key",
                email="internal-api-key@local",
                role="admin",
                status="active",
                password_hash="",
            )
        if user is None:
            user = ensure_default_admin(
                db,
                email=settings.default_admin_email,
                password=settings.default_admin_password,
                name=settings.default_admin_name,
            )
        if user is not None:
            return user

    token = _bearer_token(request.headers.get("authorization")) or request.query_params.get("session_token")
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    user = load_user_for_token(db, token)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


def require_project_access(db: Session, user: User, project_id: str) -> Project:
    project = db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))
    if project is None or project.status != "active":
        raise HTTPException(status_code=404, detail="Project not found")
    if user.role == "admin":
        return project
    membership = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == user.id)
    )
    if membership is None:
        raise HTTPException(status_code=403, detail="Project access denied")
    return project


def _bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token.strip()
