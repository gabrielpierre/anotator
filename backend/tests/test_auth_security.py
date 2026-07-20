import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.users import create_user, update_user
from app.core.database import Base
from app.schemas import UserCreate, UserUpdate
from app.services.security import (
    ensure_default_admin,
    issue_session,
    load_user_for_token,
    revoke_session,
    verify_password,
)


def test_db_backed_opaque_session_lifecycle() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        user = ensure_default_admin(
            db,
            email="admin@example.com",
            password="secret123",
            name="Admin",
        )

        assert user is not None
        assert verify_password("secret123", user.password_hash)

        token, session = issue_session(db, user, ttl_hours=1)

        assert token
        assert session.token_hash != token
        assert load_user_for_token(db, token).id == user.id  # type: ignore[union-attr]

        assert revoke_session(db, token) is True
        assert load_user_for_token(db, token) is None


def test_annotator_can_change_own_password_but_not_role() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        admin = ensure_default_admin(
            db,
            email="admin@example.com",
            password="secret123",
            name="Admin",
        )
        assert admin is not None
        annotator = create_user(
            UserCreate(
                name="Ana",
                email="ana@example.com",
                password="initial123",
                role="anotador",
            ),
            db,
            admin,
        )

        updated = update_user(
            annotator.id,
            UserUpdate(current_password="initial123", password="next123"),
            db,
            annotator,
        )

        assert verify_password("next123", updated.password_hash)

        with pytest.raises(HTTPException) as exc_info:
            update_user(
                annotator.id,
                UserUpdate(role="admin"),
                db,
                annotator,
            )

        assert exc_info.value.status_code == 403
