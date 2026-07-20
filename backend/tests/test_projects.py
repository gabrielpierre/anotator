import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.v1.projects import create_project, update_project
from app.core.config import Settings
from app.core.database import Base
from app.models import AuditEvent, Project, Task
from app.schemas import DatasetReleaseCreate, ProjectCreate, ProjectUpdate
from app.services.releases import prepare_dataset_release


def session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_create_project_persists_storage_policy_and_audit() -> None:
    factory = session_factory()

    with factory() as db:
        project = create_project(
            ProjectCreate(
                name="Rodovia 2026",
                storage_path=r"D:\datasets\rodovia-2026",
                storage_quota_gb=40,
            ),
            db,
        )

        stored = db.scalar(select(Project).where(Project.id == project.id))
        audit = db.scalar(select(AuditEvent).where(AuditEvent.action == "project_created"))

        assert stored is not None
        assert stored.external_id == "rodovia-2026"
        assert stored.raw["storage"]["path"] == r"D:\datasets\rodovia-2026"
        assert stored.raw["storage"]["quota_gb"] == 40
        assert stored.raw["storage"]["quota_bytes"] == 40 * 1024**3
        assert stored.raw["storage"]["enforce_quota"] is True
        assert audit is not None


def test_create_project_rejects_duplicate_external_id() -> None:
    factory = session_factory()

    with factory() as db:
        payload = ProjectCreate(
            name="Projeto A",
            external_id="custom-id",
            storage_path=r"D:\datasets\a",
            storage_quota_gb=30,
        )
        create_project(payload, db)

        with pytest.raises(HTTPException) as exc_info:
            create_project(payload, db)

        assert exc_info.value.status_code == 409


def test_update_project_persists_storage_path_and_quota() -> None:
    factory = session_factory()

    with factory() as db:
        project = create_project(
            ProjectCreate(
                name="Projeto A",
                storage_path="/datasets/a",
                storage_quota_gb=30,
            ),
            db,
        )

        updated = update_project(
            project.id,
            ProjectUpdate(
                storage_path="/datasets/b",
                storage_quota_gb=60,
            ),
            db,
        )
        audit = db.scalar(select(AuditEvent).where(AuditEvent.action == "project_updated"))

        assert updated.raw["storage"]["path"] == "/datasets/b"
        assert updated.raw["storage"]["quota_gb"] == 60
        assert updated.raw["storage"]["quota_bytes"] == 60 * 1024**3
        assert audit is not None
        assert audit.payload["storage_path"] == "/datasets/b"


def test_dataset_release_respects_single_project_storage_quota() -> None:
    factory = session_factory()

    with factory() as db:
        project = create_project(
            ProjectCreate(
                name="Projeto com quota",
                storage_path=r"D:\datasets\quota",
                storage_quota_gb=1,
            ),
            db,
        )
        db.add(Task(external_id="21", project_external_id=project.external_id, name="task-big", status="annotation", size=500))
        db.commit()

        with pytest.raises(ValueError, match="storage quota"):
            prepare_dataset_release(
                db,
                payload=DatasetReleaseCreate(name="release_big", project_id=project.id, task_external_ids=["21"]),
                settings=Settings(),
            )
