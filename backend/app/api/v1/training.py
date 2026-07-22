import asyncio
import json
import mimetypes
from collections.abc import AsyncIterator
from pathlib import PurePosixPath
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import (
    filter_visible_training_runs,
    project_for_release,
    project_payload,
    require_release_access,
    require_training_access,
)
from app.core.celery_app import celery_app
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import ArtifactRecord, AuditEvent, DatasetRelease, JobRecord, ModelVersion, TrainingRun, User, utcnow
from app.schemas import TrainingRunCreate, TrainingRunRead
from app.services.artifacts import S3ArtifactStore, parse_s3_uri
from app.services.jobs import attach_celery_task, cancel_job, create_job, fail_stale_active_jobs
from app.services.training import ensure_training_device_available, normalize_training_device
from app.tasks import training_run_task

router = APIRouter()
FINAL_RUN_STATUSES = {"succeeded", "failed", "canceled"}
ACTIVE_JOB_STATUSES = {"queued", "running", "paused"}


@router.get("", response_model=list[TrainingRunRead])
def list_training_runs(
    project_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[TrainingRun]:
    fail_stale_active_jobs(db)
    runs = list(db.scalars(select(TrainingRun).order_by(TrainingRun.created_at.desc())).all())
    if project_id:
        project = require_project_access(db, user, project_id)
        scoped_runs: list[TrainingRun] = []
        for run in runs:
            owner = project_for_release(db, db.get(DatasetRelease, run.dataset_release_id))
            if owner is not None and owner.id == project.id:
                scoped_runs.append(run)
        runs = scoped_runs
    return filter_visible_training_runs(db, user, runs)


@router.get("/{run_id}", response_model=TrainingRunRead)
def get_training_run(
    run_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrainingRun:
    fail_stale_active_jobs(db)
    return require_training_access(db, user, run_id)


@router.post("", response_model=TrainingRunRead)
def create_training_run(
    payload: TrainingRunCreate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrainingRun:
    fail_stale_active_jobs(db)
    release = require_release_access(db, user, payload.dataset_release_id)
    if not release.immutable or release.status != "ready" or not release.artifact_uri:
        raise HTTPException(
            status_code=409,
            detail="Training requires an immutable ready DatasetRelease with exported artifacts",
        )
    device = normalize_training_device(payload.device)
    try:
        ensure_training_device_available(device)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    settings = get_settings()
    workers = payload.workers
    if device == "cpu":
        workers = min(workers, max(0, settings.training_cpu_max_workers))
    run_config = {
        **payload.config,
        "epochs": payload.epochs,
        "image_size": payload.image_size,
        "batch_size": payload.batch_size,
        "device": device,
        "workers": workers,
        "patience": payload.patience,
        "seed": payload.seed,
    }
    run = TrainingRun(
        dataset_release_id=payload.dataset_release_id,
        model_family=payload.model_family,
        base_model=payload.base_model,
        config=run_config,
        status="queued",
        progress=0,
    )
    db.add(run)
    db.flush()
    release_project = project_for_release(db, release)
    job = create_job(
        db,
        kind="training",
        name=f"Training {payload.base_model}",
        detail=f"Dataset release {release.name}",
        raw={"operation": "training_run", "training_run_id": run.id, **project_payload(release_project)},
    )
    db.add(
        AuditEvent(
            actor=user.email,
            action="training_run_created",
            target=run.id,
            payload={"dataset_release_id": payload.dataset_release_id, "base_model": payload.base_model},
        )
    )
    db.commit()
    task = training_run_task.delay(job.id)
    attach_celery_task(db, job.id, task.id)
    db.refresh(run)
    return run


@router.post("/{run_id}/pause", response_model=TrainingRunRead)
def pause_training_run(
    run_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> TrainingRun:
    fail_stale_active_jobs(db)
    run = require_training_access(db, actor, run_id)
    if run.status in FINAL_RUN_STATUSES:
        return run

    job = _latest_training_job(db, run.id)
    if job is not None and job.status in {"queued", "running"}:
        _revoke_training_job(job)
        job.status = "paused"
        job.detail = "Training paused by user"
        job.raw = {**(job.raw or {}), "paused_at": utcnow().isoformat()}
        db.add(job)

    run.status = "paused"
    run.metrics = _with_training_log(run.metrics, "Training paused by user.", level="WARN", progress=run.progress)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="training_run_paused",
            target=run.id,
            payload={"job_id": job.id if job is not None else None},
        )
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


@router.post("/{run_id}/stop", response_model=TrainingRunRead)
def stop_training_run(
    run_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> TrainingRun:
    fail_stale_active_jobs(db)
    run = require_training_access(db, actor, run_id)
    if run.status in FINAL_RUN_STATUSES:
        return run

    job = _latest_training_job(db, run.id)
    if job is not None and job.status in ACTIVE_JOB_STATUSES:
        cancel_job(db, job.id, celery_app=celery_app, reason="Training stopped by user")
        run = _require_training_run(db, run_id)

    run.status = "canceled"
    run.metrics = _with_training_log(run.metrics, "Training stopped by user.", level="WARN", progress=run.progress)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="training_run_stopped",
            target=run.id,
            payload={"job_id": job.id if job is not None else None},
        )
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


@router.delete("/{run_id}")
def delete_training_run(
    run_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> dict[str, Any]:
    fail_stale_active_jobs(db)
    run = require_training_access(db, actor, run_id)
    jobs = _training_jobs(db, run.id)
    canceled_jobs: list[str] = []
    for job in jobs:
        if job.status in ACTIVE_JOB_STATUSES:
            cancel_job(db, job.id, celery_app=celery_app, reason="Training deleted by user")
            canceled_jobs.append(job.id)

    artifact_store = S3ArtifactStore(get_settings())
    artifact_uris = _training_artifact_uris(run)
    model_versions = db.scalars(select(ModelVersion).where(ModelVersion.training_run_id == run.id)).all()
    for model in model_versions:
        if model.artifact_uri:
            artifact_uris.add(model.artifact_uri)

    deleted_objects = 0
    artifact_errors: list[str] = []
    artifact_prefixes = _training_artifact_prefixes(run, artifact_uris)
    for prefix in artifact_prefixes:
        try:
            deleted_objects += artifact_store.delete_prefix(prefix)
        except Exception as exc:
            artifact_errors.append(f"{prefix}: {exc}")

    for uri in artifact_uris:
        if any(_uri_under_prefix(uri, prefix) for prefix in artifact_prefixes):
            continue
        try:
            artifact_store.delete(uri)
            deleted_objects += 1
        except Exception as exc:
            artifact_errors.append(f"{uri}: {exc}")

    deleted_artifact_records = 0
    for record in db.scalars(select(ArtifactRecord)).all():
        if record.uri in artifact_uris or _artifact_record_matches_run(record, run):
            db.delete(record)
            deleted_artifact_records += 1

    detached_models = 0
    for model in model_versions:
        db.delete(model)
        detached_models += 1

    db.add(
        AuditEvent(
            actor=actor.email,
            action="training_run_deleted",
            target=run.id,
            payload={
                "dataset_release_id": run.dataset_release_id,
                "mlflow_run_id": run.mlflow_run_id,
                "jobs": [job.id for job in jobs],
                "canceled_jobs": canceled_jobs,
                "deleted_models": detached_models,
                "deleted_artifact_records": deleted_artifact_records,
                "deleted_objects": deleted_objects,
                "artifact_errors": artifact_errors,
            },
        )
    )
    for job in jobs:
        db.delete(job)
    db.delete(run)
    db.commit()
    return {
        "id": run_id,
        "deleted": True,
        "canceled_jobs": canceled_jobs,
        "deleted_models": detached_models,
        "deleted_artifact_records": deleted_artifact_records,
        "deleted_objects": deleted_objects,
        "artifact_errors": artifact_errors,
    }


@router.get("/{run_id}/events")
async def training_events(
    run_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> StreamingResponse:
    fail_stale_active_jobs(db)
    require_training_access(db, user, run_id)

    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as event_db:
                fail_stale_active_jobs(event_db)
                current = event_db.get(TrainingRun, run_id)
                if current is None:
                    yield f"event: error\ndata: {json.dumps({'detail': 'Training run not found'})}\n\n"
                    return
                payload = {
                    "id": current.id,
                    "status": current.status,
                    "progress": current.progress,
                    "metrics": current.metrics,
                    "artifacts": current.artifacts,
                }
            yield f"event: snapshot\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{run_id}/artifacts/{artifact_path:path}/download")
def download_training_artifact(
    run_id: str,
    artifact_path: str,
    inline: bool = Query(default=False),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Response:
    run = require_training_access(db, user, run_id)
    artifact = _training_artifact_by_path(run, artifact_path)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Training artifact not found")
    uri = str(artifact.get("uri") or "")
    if not uri:
        raise HTTPException(status_code=404, detail="Training artifact not found")
    try:
        blob = S3ArtifactStore(get_settings()).get(uri)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Training artifact not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    name = str(artifact.get("name") or PurePosixPath(artifact_path).name or "artifact")
    media_type = blob.content_type
    if not media_type or media_type == "application/octet-stream":
        media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    disposition = "inline" if inline else "attachment"
    return Response(
        content=blob.content,
        media_type=media_type,
        headers={"Content-Disposition": f'{disposition}; filename="{name}"'},
    )


def _require_training_run(db: Session, run_id: str) -> TrainingRun:
    run = db.get(TrainingRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Training run not found")
    return run


def _latest_training_job(db: Session, run_id: str) -> JobRecord | None:
    jobs = _training_jobs(db, run_id)
    active = [job for job in jobs if job.status in ACTIVE_JOB_STATUSES]
    return active[0] if active else (jobs[0] if jobs else None)


def _training_jobs(db: Session, run_id: str) -> list[JobRecord]:
    jobs = db.scalars(
        select(JobRecord).where(JobRecord.kind == "training").order_by(JobRecord.created_at.desc())
    ).all()
    return [job for job in jobs if str((job.raw or {}).get("training_run_id")) == run_id]


def _revoke_training_job(job: JobRecord) -> None:
    celery_task_id = (job.raw or {}).get("celery_task_id")
    if celery_task_id:
        celery_app.control.revoke(str(celery_task_id), terminate=True)


def _with_training_log(
    metrics: dict[str, Any] | None,
    message: str,
    *,
    level: str,
    progress: float,
) -> dict[str, Any]:
    current = metrics if isinstance(metrics, dict) else {}
    logs = current.get("logs") if isinstance(current.get("logs"), list) else []
    return {
        **current,
        "logs": [
            *logs,
            {
                "t": utcnow().isoformat(),
                "lvl": level,
                "msg": message,
                "progress": round(float(progress), 2),
            },
        ][-500:],
    }


def _training_artifact_uris(run: TrainingRun) -> set[str]:
    uris: set[str] = set()
    for artifact in run.artifacts if isinstance(run.artifacts, list) else []:
        if isinstance(artifact, dict) and isinstance(artifact.get("uri"), str):
            uris.add(str(artifact["uri"]))
    for value in _nested_s3_uris(run.metrics):
        uris.add(value)
    return uris


def _training_artifact_by_path(run: TrainingRun, artifact_path: str) -> dict[str, Any] | None:
    normalized_path = artifact_path.strip("/")
    for artifact in run.artifacts if isinstance(run.artifacts, list) else []:
        if not isinstance(artifact, dict):
            continue
        path = str(artifact.get("path") or "").strip("/")
        name = str(artifact.get("name") or "").strip("/")
        if normalized_path and normalized_path in {path, name}:
            return artifact
    return None


def _training_artifact_prefixes(run: TrainingRun, artifact_uris: set[str]) -> set[str]:
    prefixes: set[str] = set()
    if run.mlflow_run_id:
        for uri in artifact_uris:
            try:
                bucket, key = parse_s3_uri(uri)
            except ValueError:
                continue
            marker = f"/{run.mlflow_run_id}/"
            if marker in f"/{key}":
                before, _, _ = key.partition(run.mlflow_run_id)
                prefixes.add(f"s3://{bucket}/{before}{run.mlflow_run_id}/")
    return prefixes


def _artifact_record_matches_run(record: ArtifactRecord, run: TrainingRun) -> bool:
    if record.owner_type == "training_run" and record.owner_id == run.id:
        return True
    if run.mlflow_run_id and run.mlflow_run_id in record.uri:
        return True
    return False


def _uri_under_prefix(uri: str, prefix: str) -> bool:
    try:
        bucket, key = parse_s3_uri(uri)
        prefix_bucket, prefix_key = parse_s3_uri(prefix)
    except ValueError:
        return False
    return bucket == prefix_bucket and key.startswith(prefix_key)


def _nested_s3_uris(value: Any) -> set[str]:
    uris: set[str] = set()
    if isinstance(value, str) and value.startswith("s3://"):
        uris.add(value)
    elif isinstance(value, dict):
        for child in value.values():
            uris.update(_nested_s3_uris(child))
    elif isinstance(value, list):
        for child in value:
            uris.update(_nested_s3_uris(child))
    return uris
