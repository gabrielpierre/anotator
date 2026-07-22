import asyncio
import json
import os
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session, require_project_access
from app.api.project_scope import job_matches_project, job_visible as scoped_job_visible
from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.models import JobRecord, User
from app.schemas import JobCapacityRead, JobMetricsRead, JobPriorityUpdate, JobRead
from app.services.compute import gpu_snapshot
from app.services.jobs import attach_celery_task, cancel_job, create_job, fail_stale_active_jobs

router = APIRouter()
PROCESSING_JOB_KINDS_EXCLUDED = {"cvat_job"}


@router.get("", response_model=list[JobRead])
def list_jobs(
    project_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[JobRecord]:
    return _visible_jobs(db, user, project_id=project_id)


@router.get("/events")
async def job_events(
    project_id: str | None = Query(default=None, max_length=64),
    user: User = Depends(current_user),
) -> StreamingResponse:
    viewer_id = user.id

    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as db:
                viewer = db.get(User, viewer_id)
                jobs = _visible_jobs(db, viewer, project_id=project_id) if viewer is not None else []
                payload = {"jobs": [_serialize_job(job) for job in jobs]}
            yield f"event: jobs\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/capacity", response_model=JobCapacityRead)
def job_capacity(
    project_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> JobCapacityRead:
    jobs = _visible_jobs(db, user, order=False, project_id=project_id)
    queued = sum(1 for job in jobs if job.status == "queued")
    running = sum(1 for job in jobs if job.status == "running")
    memory = _memory_snapshot()
    return JobCapacityRead(
        queued=queued,
        running=running,
        active=queued + running,
        cpu_count=os.cpu_count() or 1,
        memory_total_bytes=memory.get("total"),
        memory_available_bytes=memory.get("available"),
        gpu=gpu_snapshot(),
    )


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> JobRecord:
    job = _visible_job_or_none(db, user, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.patch("/{job_id}/priority", response_model=JobRead)
def update_job_priority(
    job_id: str,
    payload: JobPriorityUpdate,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> JobRecord:
    job = db.get(JobRecord, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job.raw = {**(job.raw or {}), "priority": payload.priority}
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/retry", response_model=JobRead)
def retry_job(
    job_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> JobRecord:
    original = db.get(JobRecord, job_id)
    if original is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if original.status not in {"failed", "canceled"}:
        raise HTTPException(status_code=409, detail="Only failed or canceled jobs can be retried")
    retry = create_job(
        db,
        kind=original.kind,
        name=f"Retry: {original.name}",
        detail="Retry queued.",
        task_external_id=original.task_external_id,
        raw={**(original.raw or {}), "retry_of_job_id": original.id},
    )
    task_id = _dispatch_retry(retry)
    if task_id:
        attach_celery_task(db, retry.id, task_id)
    db.refresh(retry)
    return retry


@router.get("/{job_id}/metrics", response_model=JobMetricsRead)
def job_metrics(
    job_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> JobMetricsRead:
    job = _visible_job_or_none(db, user, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    metrics = job.resource_metrics if isinstance(job.resource_metrics, dict) else {}
    snapshots = metrics.get("snapshots") if isinstance(metrics.get("snapshots"), list) else []
    return JobMetricsRead(job_id=job.id, metrics=metrics, snapshots=snapshots)


@router.post("/{job_id}/cancel", response_model=JobRead)
def cancel_job_endpoint(
    job_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> JobRecord:
    try:
        return cancel_job(db, job_id, celery_app=celery_app)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{job_id}/events")
async def job_detail_events(job_id: str, user: User = Depends(current_user)) -> StreamingResponse:
    viewer_id = user.id

    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as db:
                viewer = db.get(User, viewer_id)
                job = _visible_job_or_none(db, viewer, job_id) if viewer is not None else None
                if job is None:
                    yield f"event: error\ndata: {json.dumps({'detail': 'Job not found'})}\n\n"
                    return
                payload = _serialize_job(job)
            yield f"event: job\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _serialize_job(job: JobRecord) -> dict:
    return JobRead.model_validate(job).model_dump(mode="json")


def _visible_job_or_none(db: Session, user: User, job_id: str) -> JobRecord | None:
    fail_stale_active_jobs(db)
    job = db.get(JobRecord, job_id)
    if job is None or job.kind in PROCESSING_JOB_KINDS_EXCLUDED:
        return None
    if user.role == "admin":
        return job
    return job if scoped_job_visible(db, user, job) else None


def _visible_jobs(
    db: Session,
    user: User,
    order: bool = True,
    project_id: str | None = None,
) -> list[JobRecord]:
    fail_stale_active_jobs(db)
    query = select(JobRecord).where(JobRecord.kind.notin_(PROCESSING_JOB_KINDS_EXCLUDED))
    if order:
        query = query.order_by(JobRecord.updated_at.desc())
    jobs = list(db.scalars(query).all())
    project = require_project_access(db, user, project_id) if project_id else None
    if project is not None:
        jobs = [job for job in jobs if job_matches_project(db, job, project)]
    if user.role == "admin":
        return jobs
    return [job for job in jobs if scoped_job_visible(db, user, job)]


def _dispatch_retry(job: JobRecord) -> str | None:
    if job.kind == "release":
        from app.tasks import build_dataset_release_task

        return build_dataset_release_task.delay(job.id).id
    if job.kind == "training":
        from app.tasks import training_run_task

        return training_run_task.delay(job.id).id
    if job.kind == "pipeline":
        from app.tasks import pipeline_run_task

        return pipeline_run_task.delay(job.id).id
    if job.kind == "import":
        from app.tasks import import_task_job_task

        return import_task_job_task.delay(job.id).id
    if job.kind == "inference":
        from app.tasks import inference_run_task

        return inference_run_task.delay(job.id).id
    return None


def _memory_snapshot() -> dict[str, int]:
    try:
        values: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                amount = value.strip().split(" ")[0]
                if key == "MemTotal":
                    values["total"] = int(amount) * 1024
                if key == "MemAvailable":
                    values["available"] = int(amount) * 1024
        return values
    except OSError:
        return {}
