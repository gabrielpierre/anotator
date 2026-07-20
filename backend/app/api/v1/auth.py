from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.config import get_settings
from app.models import AuditEvent, User
from app.schemas import AuthLogin, AuthSessionRead, UserRead
from app.services.security import issue_session, normalize_email, revoke_session, verify_password

router = APIRouter()


@router.post("/login", response_model=AuthSessionRead)
def login(payload: AuthLogin, db: Session = Depends(db_session)) -> AuthSessionRead:
    user = db.scalar(select(User).where(User.email == normalize_email(payload.email)))
    if user is None or user.status != "active" or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token, session = issue_session(db, user, ttl_hours=get_settings().session_ttl_hours)
    return AuthSessionRead(token=token, expires_at=session.expires_at, user=UserRead.model_validate(user))


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(current_user)) -> User:
    return user


@router.post("/logout")
def logout(request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)) -> dict[str, bool]:
    token = _bearer_token(request.headers.get("authorization"))
    if token:
        revoke_session(db, token)
    db.add(AuditEvent(actor=user.email, action="auth_logout", target=user.id))
    db.commit()
    return {"ok": True}


def _bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token.strip()
