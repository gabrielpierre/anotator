from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import InferenceSuggestion, JobRecord, Task
from app.schemas import InferenceRunCreate, InferenceSuggestionRead, JobRead
from app.services.jobs import attach_celery_task, create_job
from app.tasks import inference_run_task

router = APIRouter()


@router.post("", response_model=JobRead)
def queue_inference_run(payload: InferenceRunCreate, db: Session = Depends(db_session)) -> JobRecord:
    if payload.apply_mode == "replace" and not payload.confirm_replace:
        raise HTTPException(status_code=409, detail="Replacing suggestions requires confirm_replace=true")
    task = db.scalar(select(Task).where(Task.external_id == payload.task_external_id))
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    job = create_job(
        db,
        kind="inference",
        name=f"Inference {payload.model_id} on task {payload.task_external_id}",
        detail="Queued auto-annotation inference.",
        task_external_id=payload.task_external_id,
        raw={
            "operation": "inference_run",
            "task_external_id": payload.task_external_id,
            "model_id": payload.model_id,
            "model_version": payload.model_version,
            "model_family": payload.model_family,
            "payload": payload.model_dump(mode="json"),
        },
    )
    task_result = inference_run_task.delay(job.id)
    return attach_celery_task(db, job.id, task_result.id)


@router.get("/suggestions", response_model=list[InferenceSuggestionRead])
def list_suggestions(
    task_external_id: str | None = None,
    frame: int | None = Query(default=None, ge=0),
    model_id: str | None = None,
    status: str = "proposed",
    db: Session = Depends(db_session),
) -> list[InferenceSuggestion]:
    query = select(InferenceSuggestion)
    if task_external_id:
        query = query.where(InferenceSuggestion.task_external_id == task_external_id)
    if frame is not None:
        query = query.where(InferenceSuggestion.frame == frame)
    if model_id:
        query = query.where(InferenceSuggestion.model_id == model_id)
    if status:
        query = query.where(InferenceSuggestion.status == status)
    return list(db.scalars(query.order_by(InferenceSuggestion.created_at.desc())).all())


@router.delete("/suggestions", response_model=dict)
def delete_suggestions(
    task_external_id: str,
    model_id: str | None = None,
    frame: int | None = Query(default=None, ge=0),
    db: Session = Depends(db_session),
) -> dict:
    query = delete(InferenceSuggestion).where(
        InferenceSuggestion.task_external_id == task_external_id,
        InferenceSuggestion.status == "proposed",
    )
    if model_id:
        query = query.where(InferenceSuggestion.model_id == model_id)
    if frame is not None:
        query = query.where(InferenceSuggestion.frame == frame)
    result = db.execute(query)
    db.commit()
    return {"deleted": result.rowcount or 0}
