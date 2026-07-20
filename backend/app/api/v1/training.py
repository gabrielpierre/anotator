import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.core.database import SessionLocal
from app.models import AuditEvent, DatasetRelease, TrainingRun
from app.schemas import TrainingRunCreate, TrainingRunRead
from app.services.jobs import attach_celery_task, create_job
from app.tasks import training_run_task

router = APIRouter()


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
    run_config = {
        **payload.config,
        "epochs": payload.epochs,
        "image_size": payload.image_size,
        "batch_size": payload.batch_size,
        "device": payload.device,
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
