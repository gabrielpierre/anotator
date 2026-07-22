from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session
from app.models import AuditEvent, User
from app.schemas import UserCreate, UserRead, UserUpdate
from app.services.security import hash_password, normalize_email, verify_password

router = APIRouter()


@router.get("", response_model=list[UserRead])
def list_users(db: Session = Depends(db_session), _: User = Depends(current_admin)) -> list[User]:
    return list(db.scalars(select(User).where(User.status == "active").order_by(User.created_at.desc())).all())


@router.post("", response_model=UserRead)
def create_user(payload: UserCreate, db: Session = Depends(db_session), actor: User = Depends(current_admin)) -> User:
    email = normalize_email(payload.email)
    existing = db.scalar(select(User).where(User.email == email))
    if existing is not None:
        if existing.status != "inactive":
            raise HTTPException(status_code=409, detail="Já existe um usuário ativo com este e-mail.")
        existing.name = payload.name.strip()
        existing.role = payload.role
        existing.status = "active"
        existing.avatar_url = payload.avatar_url
        existing.password_hash = hash_password(payload.password)
        existing.raw = {**(existing.raw or {}), "source": "api", "reactivated": True}
        db.add(existing)
        db.add(
            AuditEvent(
                actor=actor.email,
                action="user_reactivated",
                target=existing.id,
                payload={"email": existing.email, "role": existing.role},
            )
        )
        db.commit()
        db.refresh(existing)
        return existing
    user = User(
        name=payload.name.strip(),
        email=email,
        role=payload.role,
        status="active",
        avatar_url=payload.avatar_url,
        password_hash=hash_password(payload.password),
        raw={"source": "api"},
    )
    db.add(user)
    db.flush()
    db.add(
        AuditEvent(
            actor=actor.email,
            action="user_created",
            target=user.id,
            payload={"email": user.email, "role": user.role},
        )
    )
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: str,
    payload: UserUpdate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    is_admin = actor.role == "admin"
    is_self = actor.id == user.id
    if not is_admin and not is_self:
        raise HTTPException(status_code=403, detail="Cannot update another user")
    if not is_admin and (payload.role is not None or payload.status is not None):
        raise HTTPException(status_code=403, detail="Admin role required")
    changes: dict[str, object] = {}
    if payload.name is not None:
        user.name = payload.name.strip()
        changes["name"] = user.name
    if payload.email is not None:
        email = normalize_email(payload.email)
        existing = db.scalar(select(User).where(User.email == email, User.id != user.id))
        if existing is not None:
            raise HTTPException(status_code=409, detail="Já existe um usuário com este e-mail.")
        user.email = email
        changes["email"] = user.email
    if payload.role is not None:
        user.role = payload.role
        changes["role"] = user.role
    if payload.status is not None:
        user.status = payload.status
        changes["status"] = user.status
    if payload.avatar_url is not None:
        user.avatar_url = payload.avatar_url
        changes["avatar_url"] = user.avatar_url
    if payload.password is not None:
        if not is_admin:
            if not payload.current_password or not verify_password(payload.current_password, user.password_hash):
                raise HTTPException(status_code=400, detail="Current password is invalid")
        user.password_hash = hash_password(payload.password)
        changes["password_changed"] = True
    if changes:
        db.add(
            AuditEvent(
                actor=actor.email,
                action="user_updated",
                target=user.id,
                payload={"user_id": user.id, **changes},
            )
        )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", response_model=UserRead)
def deactivate_user(user_id: str, db: Session = Depends(db_session), actor: User = Depends(current_admin)) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = "inactive"
    db.add(user)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="user_deactivated",
            target=user.id,
            payload={"user_id": user.id, "email": user.email},
        )
    )
    db.commit()
    db.refresh(user)
    return user
