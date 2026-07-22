import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import (
    AnnotationRecord,
    AuditEvent,
    CvatLabel,
    DatasetRelease,
    DerivedAsset,
    InferenceSuggestion,
    JobRecord,
    PipelineRun,
    Task,
    TaskDataMeta,
    TaskPreview,
)
from app.services.tasks import ActiveTaskJobsError, build_task_delete_impact, delete_task_with_dependencies


class FakeCvatClient:
    def __init__(self) -> None:
        self.deleted_tasks: list[str] = []

    def delete_task(self, task_id: str) -> dict:
        self.deleted_tasks.append(str(task_id))
        return {}


def _session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_task_delete_impact_and_delete_preserves_immutable_history() -> None:
    session_factory = _session_factory()
    client = FakeCvatClient()

    with session_factory() as db:
        task = Task(external_id="21", name="Lote 20/07/2026", status="annotation", size=9)
        db.add(task)
        db.add(TaskDataMeta(task_external_id="21", frame_count=9))
        db.add(TaskPreview(task_external_id="21", url="/api/v1/tasks/21/preview"))
        db.add(CvatLabel(external_id="task:21:label:1", name="torre", task_external_id="21"))
        db.add(
            AnnotationRecord(
                external_id="manual:21:0:shape-1",
                cvat_job_id="100",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="shape-1",
                frame=0,
                label_name="torre",
                shape_type="rectangle",
                points=[1, 2, 3, 4],
            )
        )
        db.add(
            InferenceSuggestion(
                external_id="suggestion:21:0:1",
                task_external_id="21",
                frame=0,
                model_id="m1",
                model_version="v1",
                model_family="detection",
                label_name="torre",
                points=[1, 2, 3, 4],
            )
        )
        db.add(
            JobRecord(
                kind="cvat_job",
                status="succeeded",
                progress=100,
                name="CVAT job 100",
                task_external_id="21",
            )
        )
        db.add(
            JobRecord(
                kind="import",
                status="succeeded",
                progress=100,
                name="Import CVAT task Lote 20/07/2026",
                raw={"cvat_task_id": "21", "payload": {"name": "Lote 20/07/2026"}},
            )
        )
        release = DatasetRelease(
            name="release_001",
            status="ready",
            task_external_ids=["21"],
            artifact_uri="s3://bucket/release.zip",
        )
        db.add(release)
        pipeline = PipelineRun(
            name="Dataset derivado",
            status="succeeded",
            progress=100,
            definition={"task_external_ids": ["21"]},
        )
        db.add(pipeline)
        db.flush()
        db.add(
            DerivedAsset(
                external_id="asset:21:0:shape-1",
                pipeline_run_id=pipeline.id,
                dataset_release_id=release.id,
                source_task_external_id="21",
                source_annotation_id="manual:21:0:shape-1",
                frame=0,
                label_name="torre",
            )
        )
        db.commit()

        impact = build_task_delete_impact(db, task)

        assert impact.image_count == 9
        assert impact.annotations == 1
        assert impact.inference_suggestions == 1
        assert impact.labels == 1
        assert impact.cvat_jobs == 1
        assert impact.dataset_releases == 1
        assert impact.derived_assets == 1
        assert impact.pipeline_runs == 1
        assert impact.blocking is False

        result = delete_task_with_dependencies(
            db,
            task=task,
            actor_email="admin@cvat.plus",
            client=client,
        )

        assert client.deleted_tasks == ["21"]
        assert result.deleted["annotations"] == 1
        assert result.deleted["inference_suggestions"] == 1
        assert result.deleted["labels"] == 1
        assert result.deleted["task_data_meta"] == 1
        assert result.deleted["task_previews"] == 1
        assert result.deleted["cvat_jobs"] == 1
        assert result.deleted["jobs"] == 2
        assert result.preserved == {"dataset_releases": 1, "derived_assets": 1, "pipeline_runs": 1}

        assert db.scalar(select(Task).where(Task.external_id == "21")) is None
        assert db.scalar(select(AnnotationRecord)) is None
        assert db.scalar(select(InferenceSuggestion)) is None
        assert db.scalar(select(CvatLabel)) is None
        assert db.scalar(select(TaskDataMeta)) is None
        assert db.scalar(select(TaskPreview)) is None
        assert db.scalar(select(JobRecord)) is None
        assert db.scalar(select(DatasetRelease)) is not None
        assert db.scalar(select(DerivedAsset)) is not None
        event = db.scalar(select(AuditEvent).where(AuditEvent.action == "task_deleted"))
        assert event is not None
        assert event.actor == "admin@cvat.plus"


def test_task_delete_is_blocked_by_active_related_job() -> None:
    session_factory = _session_factory()
    client = FakeCvatClient()

    with session_factory() as db:
        task = Task(external_id="21", name="Lote 20/07/2026", status="annotation", size=9)
        db.add(task)
        db.add(
            JobRecord(
                kind="release",
                status="running",
                progress=30,
                name="Release em andamento",
                raw={"payload": {"task_external_ids": ["21"]}},
            )
        )
        db.commit()

        impact = build_task_delete_impact(db, task)

        assert impact.blocking is True
        assert impact.active_jobs[0].name == "Release em andamento"

        with pytest.raises(ActiveTaskJobsError):
            delete_task_with_dependencies(
                db,
                task=task,
                actor_email="admin@cvat.plus",
                client=client,
            )

        assert client.deleted_tasks == []
        assert db.scalar(select(Task).where(Task.external_id == "21")) is not None
