import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.v1.projects import create_project, project_dashboard, update_project
from app.core.config import Settings
from app.core.database import Base
from app.models import AnnotationRecord, AuditEvent, Project, Task, User
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


def test_dashboard_class_distribution_counts_active_annotations_not_catalog_labels() -> None:
    factory = session_factory()

    with factory() as db:
        user = User(
            name="Admin",
            email="admin@example.com",
            role="admin",
            password_hash="hash",
        )
        project = Project(id="project-1", external_id="rodovia", name="Rodovia")
        db.add_all(
            [
                user,
                project,
                Task(
                    external_id="21",
                    project_external_id=project.external_id,
                    name="Lote",
                    status="annotation",
                    size=3,
                    labels=[{"name": "car"}, {"name": "truck"}, {"name": "bus"}],
                ),
                AnnotationRecord(
                    external_id="ann-1",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id="1",
                    frame=0,
                    label_name="car",
                    review_state="accepted",
                ),
                AnnotationRecord(
                    external_id="ann-2",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id="2",
                    frame=1,
                    label_name="car",
                    review_state="accepted",
                ),
                AnnotationRecord(
                    external_id="ann-3",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id="3",
                    frame=2,
                    label_name="truck",
                    review_state="pending",
                ),
                AnnotationRecord(
                    external_id="ann-4",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id="4",
                    frame=2,
                    label_name="bus",
                    review_state="needs_annotation",
                ),
            ]
        )
        db.commit()

        dashboard = project_dashboard(project.id, db, user)

        distribution = {item.name: item for item in dashboard.class_distribution}
        assert set(distribution) == {"car", "truck"}
        assert distribution["car"].count == 2
        assert distribution["car"].share == 66.67
        assert distribution["truck"].count == 1
        assert distribution["truck"].share == 33.33


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
