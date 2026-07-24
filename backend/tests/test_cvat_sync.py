from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import (
    AnnotationRecord,
    CvatLabel,
    JobRecord,
    Project,
    Task,
    TaskDataMeta,
    TaskPreview,
)
from app.services.sync import CvatSyncService


class FakeCvatClient:
    def list_projects(self) -> list[dict]:
        return [
            {
                "id": 7,
                "name": "Rodovias",
                "status": "active",
                "labels": [{"id": 10, "name": "car", "color": "#2f80ed"}],
            }
        ]

    def list_tasks(self) -> list[dict]:
        return [
            {
                "id": 21,
                "name": "camera-01",
                "project_id": 7,
                "status": "annotation",
                "size": 2,
                "labels": [{"id": 11, "name": "truck", "color": "#27ae60"}],
            }
        ]

    def retrieve_task(self, task_id: str) -> dict:
        assert task_id == "21"
        return {
            "id": 21,
            "name": "camera-01",
            "project_id": 7,
            "status": "annotation",
            "size": 3,
            "labels": [{"id": 11, "name": "truck", "color": "#27ae60"}],
        }

    def retrieve_task_data_meta(self, task_id: str) -> dict:
        assert task_id == "21"
        return {
            "size": 3,
            "chunk_size": 2,
            "frames": [{"name": "frame_000001.jpg", "width": 1280, "height": 720}],
            "deleted_frames": [],
        }

    def list_jobs(self) -> list[dict]:
        return [{"id": 99, "task_id": 21, "state": "completed", "stage": "acceptance"}]

    def retrieve_job_annotations(self, job_id: str) -> dict:
        assert job_id == "99"
        return {
            "version": 3,
            "tags": [],
            "shapes": [
                {
                    "id": 501,
                    "type": "rectangle",
                    "frame": 0,
                    "label_id": 11,
                    "source": "manual",
                    "points": [10, 20, 110, 120],
                    "attributes": [],
                }
            ],
            "tracks": [],
        }


class DirectImportCvatClient:
    """A task criada sem projeto CVAT ainda pertence a um projeto local."""

    def list_projects(self) -> list[dict]:
        return []

    def list_tasks(self) -> list[dict]:
        return [{"id": 42, "name": "Lote importado", "status": "annotation", "size": 1}]

    def retrieve_task(self, task_id: str) -> dict:
        assert task_id == "42"
        return {"id": 42, "name": "Lote importado", "status": "annotation", "size": 1}

    def retrieve_task_data_meta(self, task_id: str) -> dict:
        assert task_id == "42"
        return {"size": 1, "frames": [{"name": "imagem.jpg", "width": 100, "height": 100}]}

    def list_jobs(self) -> list[dict]:
        return []


def test_cvat_sync_is_idempotent_for_core_read_models() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        service = CvatSyncService(db, FakeCvatClient())  # type: ignore[arg-type]
        result = service.sync_all()
        service = CvatSyncService(db, FakeCvatClient())  # type: ignore[arg-type]
        second_result = service.sync_all()

        assert result.errors == []
        assert second_result.errors == []
        assert result.projects_synced == 1
        assert result.tasks_synced == 1
        assert result.jobs_synced == 1
        assert result.annotations_synced == 1
        assert result.labels_synced == 2
        assert result.data_meta_synced == 1
        assert result.previews_synced == 1

        assert db.scalar(select(func.count(Project.id))) == 1
        assert db.scalar(select(func.count(Task.id))) == 1
        assert db.scalar(select(func.count(CvatLabel.id))) == 2
        assert db.scalar(select(func.count(TaskDataMeta.id))) == 1
        assert db.scalar(select(func.count(TaskPreview.id))) == 1
        assert db.scalar(
            select(func.count(JobRecord.id)).where(JobRecord.kind == "cvat_job")
        ) == 1
        assert db.scalar(select(func.count(AnnotationRecord.id))) == 1

        task = db.scalar(select(Task).where(Task.external_id == "21"))
        assert task is not None
        assert task.size == 3
        assert task.preview_url == "/api/v1/tasks/21/preview"

        annotation = db.scalar(select(AnnotationRecord))
        assert annotation is not None
        assert annotation.external_id == "cvat_job:99:shape:501"
        assert annotation.label_name == "truck"


def test_cvat_sync_preserves_local_project_for_standalone_imported_task() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        project = Project(external_id="local-project", name="Projeto local")
        task = Task(
            external_id="42",
            project_external_id="local-project",
            name="Lote importado",
        )
        db.add_all([project, task])
        db.commit()

        CvatSyncService(db, DirectImportCvatClient()).sync_all()  # type: ignore[arg-type]

        synced_task = db.scalar(select(Task).where(Task.external_id == "42"))
        assert synced_task is not None
        assert synced_task.project_external_id == "local-project"


def test_cvat_sync_recovers_standalone_task_project_from_import_job() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        project = Project(external_id="local-project", name="Projeto local")
        db.add(project)
        db.flush()
        db.add(
            JobRecord(
                kind="import",
                status="failed",
                progress=80,
                name="Import CVAT task Lote importado",
                raw={
                    "payload": {"project_id": project.id},
                    "import_batches": [{"cvat_task_id": "42"}],
                },
            )
        )
        db.commit()

        CvatSyncService(db, DirectImportCvatClient()).sync_all()  # type: ignore[arg-type]

        synced_task = db.scalar(select(Task).where(Task.external_id == "42"))
        assert synced_task is not None
        assert synced_task.project_external_id == "local-project"
