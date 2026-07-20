from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.core.config import get_settings
from app.models import DatasetRelease
from app.schemas import DatasetReleaseCreate, DatasetReleaseRead
from app.services.jobs import attach_celery_task, create_job
from app.services.releases import prepare_dataset_release
from app.tasks import build_dataset_release_task

router = APIRouter()


@router.get("", response_model=list[DatasetReleaseRead])
def list_releases(db: Session = Depends(db_session)) -> list[DatasetRelease]:
    return list(db.scalars(select(DatasetRelease).order_by(DatasetRelease.created_at.desc())).all())


@router.post("", response_model=DatasetReleaseRead)
def create_release(
    payload: DatasetReleaseCreate,
    db: Session = Depends(db_session),
) -> DatasetRelease:
    settings = get_settings()
    try:
        release = prepare_dataset_release(db, payload=payload, settings=settings)
        job = create_job(
            db,
            kind="release",
            name=f"Build dataset release {release.name}",
            detail="Queued dataset release export.",
            raw={
                "operation": "dataset_release",
                "dataset_release_id": release.id,
                "payload": payload.model_dump(mode="json"),
            },
        )
        task = build_dataset_release_task.delay(job.id)
        attach_celery_task(db, job.id, task.id)
        release.snapshot = {**(release.snapshot or {}), "backend_job_id": job.id}
        db.add(release)
        db.commit()
        db.refresh(release)
        return release
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
