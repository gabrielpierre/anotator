import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditEvent, User, UserSession, utcnow

PASSWORD_ITERATIONS = 390_000
SESSION_TOKEN_BYTES = 32


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_password(password: str, *, iterations: int = PASSWORD_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = encoded.split("$", 3)
        iterations = int(raw_iterations)
        salt = bytes.fromhex(raw_salt)
        expected = bytes.fromhex(raw_digest)
    except (ValueError, TypeError):
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return secrets.compare_digest(actual, expected)


def issue_session(
    db: Session,
    user: User,
    *,
    ttl_hours: int,
    raw: dict | None = None,
) -> tuple[str, UserSession]:
    token = secrets.token_urlsafe(SESSION_TOKEN_BYTES)
    session = UserSession(
        user_id=user.id,
        token_hash=hash_session_token(token),
        expires_at=utcnow() + timedelta(hours=ttl_hours),
        last_seen_at=utcnow(),
        raw=raw or {},
    )
    db.add(session)
    db.add(
        AuditEvent(
            actor=user.email,
            action="auth_login",
            target=user.id,
            payload={"session_id": session.id},
        )
    )
    db.commit()
    db.refresh(session)
    return token, session


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def load_user_for_token(db: Session, token: str) -> User | None:
    session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_session_token(token)))
    if session is None or session.revoked_at is not None:
        return None
    if _aware(session.expires_at) <= utcnow():
        return None
    user = db.get(User, session.user_id)
    if user is None or user.status != "active":
        return None
    session.last_seen_at = utcnow()
    db.add(session)
    db.commit()
    return user


def revoke_session(db: Session, token: str) -> bool:
    session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_session_token(token)))
    if session is None or session.revoked_at is not None:
        return False
    session.revoked_at = utcnow()
    db.add(session)
    db.commit()
    return True


def ensure_default_admin(
    db: Session,
    *,
    email: str,
    password: str,
    name: str = "Administrador",
) -> User | None:
    if db.scalar(select(User.id).limit(1)) is not None:
        return None
    user = User(
        name=name,
        email=normalize_email(email),
        role="admin",
        status="active",
        password_hash=hash_password(password),
        raw={"source": "startup_seed"},
    )
    db.add(user)
    db.add(
        AuditEvent(
            actor="system",
            action="user_seeded",
            target=user.email,
            payload={"role": user.role},
        )
    )
    db.commit()
    db.refresh(user)
    return user


def _aware(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)
