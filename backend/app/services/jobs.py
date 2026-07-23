import os
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from celery import Celery
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import AuditEvent, DatasetRelease, JobRecord, PipelineRun, TrainingRun, utcnow
from app.services.json_safety import sanitize_json_dict

FINAL_JOB_STATUSES = {"succeeded", "failed", "canceled"}
ACTIVE_JOB_STATUSES = {"queued", "running", "paused"}
STALE_JOB_KINDS_EXCLUDED = {"cvat_job"}


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
    raw_payload = sanitize_json_dict(raw)
    job = JobRecord(
        kind=kind,
        status="queued",
        progress=0,
        name=name,
        detail=detail,
        task_external_id=task_external_id,
        raw=raw_payload,
    )
    db.add(job)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="job_queued",
            target=job.id,
            payload=sanitize_json_dict({"kind": kind, "name": name, "detail": detail, "raw": job.raw}),
        )
    )
    db.commit()
    db.refresh(job)
    return job


def attach_celery_task(db: Session, job_id: str, celery_task_id: str) -> JobRecord:
    job = require_job(db, job_id)
    job.external_id = f"celery:{celery_task_id}"
    job.raw = sanitize_json_dict({**(job.raw or {}), "celery_task_id": celery_task_id})
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
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
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
    job.raw = sanitize_json_dict({**(job.raw or {}), "progress_at": utcnow().isoformat()})
    if metrics:
        job.resource_metrics = sanitize_json_dict({**(job.resource_metrics or {}), **metrics})
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def heartbeat_job(
    db: Session,
    job_id: str,
    *,
    raw_update: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
) -> JobRecord:
    job = require_job(db, job_id)
    if job.status in FINAL_JOB_STATUSES:
        return job
    now = utcnow()
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict({**(job.resource_metrics or {}), **(metrics or {})}))
    job.raw = sanitize_json_dict({
        **(job.raw or {}),
        **(raw_update or {}),
        "heartbeat_at": now.isoformat(),
    })
    job.updated_at = now
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
        job.raw = sanitize_json_dict({**(job.raw or {}), **raw_update})
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
    db.add(job)
    db.add(
        AuditEvent(
            actor="system",
            action="job_succeeded",
            target=job.id,
            payload=sanitize_json_dict({"kind": job.kind, "raw": job.raw}),
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
        job.raw = sanitize_json_dict({**(job.raw or {}), **raw_update})
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
    db.add(job)
    db.add(
        AuditEvent(
            actor="system",
            action="job_failed",
            target=job.id,
            reason=reason,
            payload=sanitize_json_dict({"kind": job.kind, "raw": job.raw}),
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
    job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
    db.add(job)
    _cancel_linked_resource(db, job)
    db.add(
        AuditEvent(
            actor="local-user",
            action="job_canceled",
            target=job.id,
            reason=reason,
            payload=sanitize_json_dict({"kind": job.kind, "raw": job.raw}),
        )
    )
    db.commit()
    db.refresh(job)
    return job


def fail_stale_active_jobs(db: Session) -> list[JobRecord]:
    stale_after_seconds = get_settings().job_stale_after_seconds
    if stale_after_seconds <= 0:
        return []

    threshold = utcnow() - timedelta(seconds=stale_after_seconds)
    stale_jobs = list(
        db.scalars(
            select(JobRecord).where(
                JobRecord.status == "running",
                JobRecord.kind.notin_(STALE_JOB_KINDS_EXCLUDED),
                JobRecord.updated_at < threshold,
            )
        ).all()
    )
    if not stale_jobs:
        return []

    reason = (
        f"Job sem heartbeat por mais de {stale_after_seconds} segundos. "
        "O processo de worker pode ter sido interrompido."
    )
    for job in stale_jobs:
        job.status = "failed"
        job.detail = reason
        job.finished_at = utcnow()
        job.raw = sanitize_json_dict({**(job.raw or {}), "stale": True, "stale_after_seconds": stale_after_seconds})
        job.resource_metrics = _with_resource_snapshot(sanitize_json_dict(job.resource_metrics or {}))
        db.add(job)
        _fail_linked_resource(db, job, reason)
        db.add(
            AuditEvent(
                actor="system",
                action="job_failed_stale",
                target=job.id,
                reason=reason,
                payload=sanitize_json_dict({"kind": job.kind, "raw": job.raw}),
            )
        )
    db.commit()
    for job in stale_jobs:
        db.refresh(job)
    return stale_jobs


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
            release.snapshot = sanitize_json_dict({**(release.snapshot or {}), "error": "Release job canceled"})
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
                    release.snapshot = sanitize_json_dict(
                        {**(release.snapshot or {}), "error": "Pipeline job canceled"}
                    )
                    db.add(release)


def _fail_linked_resource(db: Session, job: JobRecord, reason: str) -> None:
    raw = job.raw or {}
    release_id = raw.get("dataset_release_id")
    if release_id:
        release = db.get(DatasetRelease, str(release_id))
        if release is not None and release.status not in {"ready", "failed", "canceled"}:
            release.status = "failed"
            release.snapshot = sanitize_json_dict({**(release.snapshot or {}), "error": reason})
            db.add(release)

    training_run_id = raw.get("training_run_id")
    if training_run_id:
        run = db.get(TrainingRun, str(training_run_id))
        if run is not None and run.status not in FINAL_JOB_STATUSES:
            run.status = "failed"
            run.progress = job.progress
            run.metrics = sanitize_json_dict({**(run.metrics or {}), "status": "failed", "error": reason})
            db.add(run)

    pipeline_run_id = raw.get("pipeline_run_id")
    if pipeline_run_id:
        run = db.get(PipelineRun, str(pipeline_run_id))
        if run is not None and run.status not in FINAL_JOB_STATUSES:
            run.status = "failed"
            run.progress = job.progress
            run.lineage = sanitize_json_dict({**(run.lineage or {}), "error": reason})
            db.add(run)
            derived_release_id = (run.lineage or {}).get("derived_release_id")
            if derived_release_id:
                release = db.get(DatasetRelease, str(derived_release_id))
                if release is not None and release.status not in {"ready", "failed", "canceled"}:
                    release.status = "failed"
                    release.snapshot = sanitize_json_dict({**(release.snapshot or {}), "error": reason})
                    db.add(release)


def _with_resource_snapshot(metrics: dict[str, Any]) -> dict[str, Any]:
    snapshots = metrics.get("snapshots") if isinstance(metrics.get("snapshots"), list) else []
    snapshot = {
        "timestamp": utcnow().isoformat(),
        "cpu_count": os.cpu_count() or 1,
        "memory": _memory_snapshot(),
        "gpu": {"available": False, "provider": None},
    }
    return sanitize_json_dict({**metrics, "snapshots": [*snapshots[-99:], snapshot], "latest": snapshot})


def _memory_snapshot() -> dict[str, int]:
    try:
        values: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                amount = value.strip().split(" ")[0]
                if key == "MemTotal":
                    values["total_bytes"] = int(amount) * 1024
                if key == "MemAvailable":
                    values["available_bytes"] = int(amount) * 1024
        return values
    except OSError:
        return {}
