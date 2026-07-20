import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.v1.training import create_training_run
from app.core.config import Settings
from app.core.database import Base
from app.models import AnnotationRecord, AuditEvent, CvatLabel, DatasetRelease, JobRecord, Task, TrainingRun
from app.schemas import DatasetReleaseCreate, TrainingRunCreate
from app.services.artifacts import ArtifactStore
from app.services.cvat_client import CvatBinaryResponse
from app.services.releases import create_dataset_release


class FakeReleaseCvatClient:
    def __init__(self) -> None:
        self.export_calls: list[dict] = []

    def create_task_dataset_export(
        self,
        task_id: str,
        *,
        export_format: str,
        filename: str,
        save_images: bool,
    ) -> dict:
        self.export_calls.append(
            {
                "task_id": task_id,
                "format": export_format,
                "filename": filename,
                "save_images": save_images,
            }
        )
        return {"rq_id": "rq-1"}

    def retrieve_request(self, request_id: str) -> dict:
        assert request_id == "rq-1"
        return {"status": "finished", "result_url": "/api/exports/release.zip"}

    def get_url_bytes(self, url_or_path: str) -> CvatBinaryResponse:
        assert url_or_path == "/api/exports/release.zip"
        return CvatBinaryResponse(b"zip-bytes", "application/zip")

    def list_quality_reports(self, *, task_id: str | None = None) -> list[dict]:
        return [{"id": 1, "task_id": task_id, "summary": {"accuracy": 0.98}}]

    def retrieve_quality_report_data(self, report_id: int) -> dict:
        assert report_id == 1
        return {"conflicts": 0, "accuracy": 0.98}


class FakeArtifactStore(ArtifactStore):
    def __init__(self) -> None:
        self.objects: list[dict] = []

    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        self.objects.append({"key": key, "content": content, "content_type": content_type})
        return f"s3://bucket/{key}"


def test_dataset_release_exports_cvat_artifacts_and_records_qa_snapshot() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    client = FakeReleaseCvatClient()
    artifact_store = FakeArtifactStore()

    with session_factory() as db:
        db.add(
            Task(
                external_id="21",
                name="camera-01",
                status="completed",
                size=3,
                labels=[{"id": 11, "name": "truck"}],
            )
        )
        db.add(
            CvatLabel(
                external_id="task:21:label:11",
                name="truck",
                task_external_id="21",
                raw={"id": 11, "name": "truck"},
            )
        )
        db.add(
            JobRecord(
                external_id="cvat:99",
                kind="cvat_job",
                status="completed",
                progress=1,
                name="Ground truth job",
                task_external_id="21",
                raw={"id": 99, "type": "ground_truth", "stage": "acceptance", "state": "completed"},
            )
        )
        db.add(
            AnnotationRecord(
                external_id="cvat_job:99:shape:501",
                cvat_job_id="99",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="501",
                frame=0,
                label_id=11,
                label_name="truck",
                shape_type="rectangle",
                source="manual",
                points=[10, 20, 110, 120],
                raw={"id": 501},
            )
        )
        db.commit()

        release = create_dataset_release(
            db,
            payload=DatasetReleaseCreate(name="release_001", task_external_ids=["21"]),
            settings=Settings(),
            client=client,  # type: ignore[arg-type]
            artifact_store=artifact_store,
        )

        assert release.status == "ready"
        assert release.immutable is True
        assert release.artifact_uri is not None
        assert release.artifact_uri.startswith("s3://bucket/dataset-releases/")
        assert release.snapshot["counts"] == {
            "tasks": 1,
            "jobs": 1,
            "labels": 1,
            "annotations": 1,
            "images": 3,
        }
        assert release.snapshot["artifacts"][0]["size_bytes"] == len(b"zip-bytes")
        assert release.snapshot["qa"]["ground_truth_jobs"][0]["configured"] is True
        assert release.snapshot["qa"]["quality_reports"][0]["data"]["accuracy"] == 0.98
        assert client.export_calls == [
            {
                "task_id": "21",
                "format": "CVAT for images 1.1",
                "filename": "release_001_task_21.zip",
                "save_images": True,
            }
        ]
        assert artifact_store.objects[0]["content"] == b"zip-bytes"
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "dataset_release_ready")) is not None


def test_training_requires_ready_immutable_release_with_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeAsyncResult:
        id = "celery-training-1"

    monkeypatch.setattr(
        "app.api.v1.training.training_run_task.delay",
        lambda job_id: FakeAsyncResult(),
    )
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        db.add(DatasetRelease(name="failed_release", status="failed", immutable=True))
        ready_release = DatasetRelease(
            name="ready_release",
            status="ready",
            artifact_uri="s3://bucket/dataset-releases/ready.zip",
            immutable=True,
        )
        db.add(ready_release)
        db.commit()
        db.refresh(ready_release)

        failed_release = db.scalar(select(DatasetRelease).where(DatasetRelease.name == "failed_release"))
        assert failed_release is not None
        with pytest.raises(HTTPException) as exc_info:
            create_training_run(
                TrainingRunCreate(dataset_release_id=failed_release.id, base_model="yolo11n.pt"),
                db,
            )
        assert exc_info.value.status_code == 409

        run = create_training_run(
            TrainingRunCreate(dataset_release_id=ready_release.id, base_model="yolo11n.pt"),
            db,
        )

        assert run.status == "queued"
        assert db.scalar(select(TrainingRun).where(TrainingRun.id == run.id)) is not None
        assert db.scalar(select(JobRecord).where(JobRecord.kind == "training")) is not None
