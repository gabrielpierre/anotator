import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.celery_app import celery_app
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import ArtifactRecord, AuditEvent, DatasetRelease, JobRecord, ModelVersion, TrainingRun, User, utcnow
from app.schemas import TrainingRunCreate, TrainingRunRead
from app.services.artifacts import S3ArtifactStore, parse_s3_uri
from app.services.jobs import attach_celery_task, cancel_job, create_job
from app.services.training import ensure_training_device_available, normalize_training_device
from app.tasks import training_run_task

router = APIRouter()
FINAL_RUN_STATUSES = {"succeeded", "failed", "canceled"}
ACTIVE_JOB_STATUSES = {"queued", "running", "paused"}


@router.get("", response_model=list[TrainingRunRead])
def list_training_runs(db: Session = Depends(db_session)) -> list[TrainingRun]:
    return list(db.scalars(select(TrainingRun).order_by(TrainingRun.created_at.desc())).all())


@router.get("/{run_id}", response_model=TrainingRunRead)
def get_training_run(run_id: str, db: Session = Depends(db_session)) -> TrainingRun:
    run = db.get(TrainingRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Training run not found")
    return run


@router.post("", response_model=TrainingRunRead)
def create_training_run(
    payload: TrainingRunCreate,
    db: Session = Depends(db_session),
) -> TrainingRun:
    release = db.get(DatasetRelease, payload.dataset_release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="Dataset release not found")
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
    run_config = {
        **payload.config,
        "epochs": payload.epochs,
        "image_size": payload.image_size,
        "batch_size": payload.batch_size,
        "device": device,
        "workers": payload.workers,
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
    job = create_job(
        db,
        kind="training",
        name=f"Training {payload.base_model}",
        detail=f"Dataset release {release.name}",
        raw={"operation": "training_run", "training_run_id": run.id},
    )
    db.add(
        AuditEvent(
            actor="system",
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
    run = _require_training_run(db, run_id)
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
    run = _require_training_run(db, run_id)
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
    run = _require_training_run(db, run_id)
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
async def training_events(run_id: str, db: Session = Depends(db_session)) -> StreamingResponse:
    run = db.get(TrainingRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Training run not found")

    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as event_db:
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
