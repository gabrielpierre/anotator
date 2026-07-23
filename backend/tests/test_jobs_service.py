from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import AuditEvent, DatasetRelease, JobRecord, TrainingRun, utcnow
from app.services import jobs as jobs_service
from app.services.jobs import cancel_job, create_job, succeed_job, update_job_progress


def test_job_lifecycle_records_progress_completion_and_audit() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        job = create_job(db, kind="release", name="Build release", detail="Queued")
        update_job_progress(db, job.id, 42, detail="Exporting")
        done = succeed_job(db, job.id, detail="Ready")

        assert done.status == "succeeded"
        assert done.progress == 100
        assert done.detail == "Ready"
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "job_queued")) is not None
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "job_succeeded")) is not None


def test_cancel_job_marks_non_final_job_and_linked_release() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with session_factory() as db:
        release = DatasetRelease(name="release_cancel", status="building", immutable=True)
        db.add(release)
        db.commit()
        db.refresh(release)
        job = create_job(
            db,
            kind="release",
            name="Build release_cancel",
            raw={"dataset_release_id": release.id},
        )

        canceled = cancel_job(db, job.id)
        db.refresh(release)

        assert canceled.status == "canceled"
        assert canceled.finished_at is not None
        assert release.status == "canceled"
        assert release.snapshot["error"] == "Release job canceled"
        assert db.scalar(select(JobRecord).where(JobRecord.id == job.id)) is not None
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "job_canceled")) is not None


def test_fail_stale_active_jobs_marks_linked_training_failed(monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(jobs_service, "get_settings", lambda: SimpleNamespace(job_stale_after_seconds=10))

    with session_factory() as db:
        release = DatasetRelease(name="release_train", status="ready", immutable=True)
        db.add(release)
        db.flush()
        run = TrainingRun(
            dataset_release_id=release.id,
            model_family="detection",
            base_model="yolo11n.pt",
            status="running",
            progress=20,
            metrics={"stage": "training"},
        )
        db.add(run)
        db.flush()
        job = create_job(
            db,
            kind="training",
            name="Train yolo11n",
            raw={"training_run_id": run.id},
        )
        job.status = "running"
        job.progress = 20
        job.updated_at = utcnow() - timedelta(seconds=60)
        db.add(job)
        db.commit()

        stale_jobs = jobs_service.fail_stale_active_jobs(db)
        db.refresh(job)
        db.refresh(run)

        assert [stale.id for stale in stale_jobs] == [job.id]
        assert job.status == "failed"
        assert run.status == "failed"
        assert run.progress == 20
        assert run.metrics["status"] == "failed"
        assert "sem heartbeat" in run.metrics["error"]
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "job_failed_stale")) is not None
