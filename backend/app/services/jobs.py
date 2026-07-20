from collections.abc import Callable
from typing import Any

from celery import Celery
from sqlalchemy.orm import Session

from app.models import AuditEvent, DatasetRelease, JobRecord, PipelineRun, TrainingRun, utcnow

FINAL_JOB_STATUSES = {"succeeded", "failed", "canceled"}
ACTIVE_JOB_STATUSES = {"queued", "running", "paused"}


class JobCanceled(RuntimeError):
    pass


def create_job(
    db: Session,
    *,
    kind: str,
    name: str,
    detail: str | None = None,
    task_external_id: str | None = None,
    raw: dict[str, Any] | None = None,
) -> JobRecord:
    job = JobRecord(
        kind=kind,
        status="queued",
        progress=0,
        name=name,
        detail=detail,
        task_external_id=task_external_id,
        raw=raw or {},
    )
    db.add(job)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="job_queued",
            target=job.id,
            payload={"kind": kind, "name": name, "detail": detail, "raw": job.raw},
        )
    )
    db.commit()
    db.refresh(job)
    return job


def attach_celery_task(db: Session, job_id: str, celery_task_id: str) -> JobRecord:
    job = require_job(db, job_id)
    job.external_id = f"celery:{celery_task_id}"
    job.raw = {**(job.raw or {}), "celery_task_id": celery_task_id}
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def mark_job_running(db: Session, job_id: str, detail: str | None = None) -> JobRecord:
    job = require_job(db, job_id)
    if job.status == "canceled":
        raise JobCanceled(f"Job {job_id} was canceled before start")
    job.status = "running"
    job.progress = max(job.progress, 1)
    job.detail = detail or job.detail
    job.started_at = job.started_at or utcnow()
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def update_job_progress(
    db: Session,
    job_id: str,
    progress: float,
    *,
    detail: str | None = None,
    metrics: dict[str, Any] | None = None,
) -> JobRecord:
    job = require_job(db, job_id)
    if job.status == "canceled":
        raise JobCanceled(f"Job {job_id} was canceled")
    job.status = "running"
    job.progress = min(99, max(0, progress))
    job.detail = detail or job.detail
    if metrics:
        job.resource_metrics = {**(job.resource_metrics or {}), **metrics}
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def succeed_job(
    db: Session,
    job_id: str,
    *,
    detail: str | None = None,
    raw_update: dict[str, Any] | None = None,
) -> JobRecord:
    job = require_job(db, job_id)
    if job.status == "canceled":
        raise JobCanceled(f"Job {job_id} was canceled")
    job.status = "succeeded"
    job.progress = 100
    job.detail = detail or job.detail
    job.finished_at = utcnow()
    if raw_update:
        job.raw = {**(job.raw or {}), **raw_update}
    db.add(job)
    db.add(
        AuditEvent(
            actor="system",
            action="job_succeeded",
            target=job.id,
            payload={"kind": job.kind, "raw": job.raw},
        )
    )
    db.commit()
    db.refresh(job)
    return job


def fail_job(
    db: Session,
    job_id: str,
    *,
    reason: str,
    raw_update: dict[str, Any] | None = None,
) -> JobRecord:
    job = require_job(db, job_id)
    if job.status == "canceled":
        return job
    job.status = "failed"
    job.detail = reason
    job.finished_at = utcnow()
    if raw_update:
        job.raw = {**(job.raw or {}), **raw_update}
    db.add(job)
    db.add(
        AuditEvent(
            actor="system",
            action="job_failed",
            target=job.id,
            reason=reason,
            payload={"kind": job.kind, "raw": job.raw},
        )
    )
    db.commit()
    db.refresh(job)
    return job


def cancel_job(
    db: Session,
    job_id: str,
    *,
    celery_app: Celery | None = None,
    reason: str = "Canceled by user",
) -> JobRecord:
    job = require_job(db, job_id)
    if job.status in FINAL_JOB_STATUSES:
        return job

    celery_task_id = (job.raw or {}).get("celery_task_id")
    if celery_app is not None and celery_task_id:
        celery_app.control.revoke(str(celery_task_id), terminate=True)

    job.status = "canceled"
    job.detail = reason
    job.finished_at = utcnow()
    db.add(job)
    _cancel_linked_resource(db, job)
    db.add(
        AuditEvent(
            actor="local-user",
            action="job_canceled",
            target=job.id,
            reason=reason,
            payload={"kind": job.kind, "raw": job.raw},
        )
    )
    db.commit()
    db.refresh(job)
    return job


def ensure_not_canceled(db: Session, job_id: str) -> None:
    job = require_job(db, job_id)
    if job.status == "canceled":
        raise JobCanceled(f"Job {job_id} was canceled")


def progress_callback(db: Session, job_id: str) -> Callable[[float, str | None], None]:
    def _callback(progress: float, detail: str | None = None) -> None:
        update_job_progress(db, job_id, progress, detail=detail)

    return _callback


def require_job(db: Session, job_id: str) -> JobRecord:
    job = db.get(JobRecord, job_id)
    if job is None:
        raise LookupError(f"Job {job_id} not found")
    return job


def _cancel_linked_resource(db: Session, job: JobRecord) -> None:
    raw = job.raw or {}
    release_id = raw.get("dataset_release_id")
    if release_id:
        release = db.get(DatasetRelease, str(release_id))
        if release is not None and release.status not in {"ready", "failed", "canceled"}:
            release.status = "canceled"
            release.snapshot = {**(release.snapshot or {}), "error": "Release job canceled"}
            db.add(release)

    training_run_id = raw.get("training_run_id")
    if training_run_id:
        run = db.get(TrainingRun, str(training_run_id))
        if run is not None and run.status not in FINAL_JOB_STATUSES:
            run.status = "canceled"
            run.progress = job.progress
            db.add(run)

    pipeline_run_id = raw.get("pipeline_run_id")
    if pipeline_run_id:
        run = db.get(PipelineRun, str(pipeline_run_id))
        if run is not None and run.status not in FINAL_JOB_STATUSES:
            run.status = "canceled"
            run.progress = job.progress
            db.add(run)
            derived_release_id = (run.lineage or {}).get("derived_release_id")
            if derived_release_id:
                release = db.get(DatasetRelease, str(derived_release_id))
                if release is not None and release.status not in {"ready", "failed", "canceled"}:
                    release.status = "canceled"
                    release.snapshot = {**(release.snapshot or {}), "error": "Pipeline job canceled"}
                    db.add(release)
