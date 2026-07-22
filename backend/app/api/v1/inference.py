from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import (
    project_for_task,
    project_payload,
    require_model_access,
    require_suggestion_access,
    require_task_access,
    visible_task_external_ids,
)
from app.models import InferenceSuggestion, JobRecord, ModelVersion, Task, User
from app.schemas import InferenceRunCreate, InferenceSuggestionRead, InferenceSuggestionStatusUpdate, JobRead
from app.services.jobs import attach_celery_task, create_job
from app.tasks import inference_run_task

router = APIRouter()


@router.post("", response_model=JobRead)
def queue_inference_run(
    payload: InferenceRunCreate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> JobRecord:
    if payload.apply_mode == "replace" and not payload.confirm_replace:
        raise HTTPException(status_code=409, detail="Replacing suggestions requires confirm_replace=true")
    task = require_task_access(db, user, payload.task_external_id)
    if db.get(ModelVersion, payload.model_id) is not None:
        require_model_access(db, user, payload.model_id)
    existing = _existing_deduped_job(db, payload)
    if existing is not None:
        return existing
    task_project = project_for_task(db, task)
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
            **project_payload(task_project),
        },
    )
    task_result = inference_run_task.delay(job.id)
    return attach_celery_task(db, job.id, task_result.id)


def _existing_deduped_job(db: Session, payload: InferenceRunCreate) -> JobRecord | None:
    if not payload.dedupe_key:
        return None
    jobs = db.scalars(
        select(JobRecord)
        .where(
            JobRecord.kind == "inference",
            JobRecord.task_external_id == payload.task_external_id,
            JobRecord.status.in_(["queued", "running", "paused", "succeeded"]),
        )
        .order_by(JobRecord.updated_at.desc())
        .limit(80)
    ).all()
    for job in jobs:
        raw = job.raw if isinstance(job.raw, dict) else {}
        raw_payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        if raw_payload.get("dedupe_key") == payload.dedupe_key:
            return job
    return None


@router.get("/suggestions", response_model=list[InferenceSuggestionRead])
def list_suggestions(
    task_external_id: str | None = None,
    project_external_id: str | None = Query(default=None, max_length=64),
    frame: int | None = Query(default=None, ge=0),
    model_id: str | None = None,
    status: str = "proposed",
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[InferenceSuggestion]:
    query = select(InferenceSuggestion)
    if task_external_id:
        task = require_task_access(db, user, task_external_id)
        task_external_id = task.external_id
        query = query.where(InferenceSuggestion.task_external_id == task_external_id)
    elif project_external_id:
        task_ids = visible_task_external_ids(db, user, project_external_id)
        if not task_ids:
            return []
        query = query.where(InferenceSuggestion.task_external_id.in_(task_ids))
    elif user.role != "admin":
        task_ids = visible_task_external_ids(db, user)
        if not task_ids:
            return []
        query = query.where(InferenceSuggestion.task_external_id.in_(task_ids))
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
    user: User = Depends(current_user),
) -> dict:
    task = require_task_access(db, user, task_external_id)
    query = delete(InferenceSuggestion).where(
        InferenceSuggestion.task_external_id == task.external_id,
        InferenceSuggestion.status == "proposed",
    )
    if model_id:
        query = query.where(InferenceSuggestion.model_id == model_id)
    if frame is not None:
        query = query.where(InferenceSuggestion.frame == frame)
    result = db.execute(query)
    db.commit()
    return {"deleted": result.rowcount or 0}


@router.patch("/suggestions/{suggestion_id}/status", response_model=InferenceSuggestionRead)
def update_suggestion_status(
    suggestion_id: str,
    payload: InferenceSuggestionStatusUpdate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> InferenceSuggestion:
    suggestion = require_suggestion_access(db, user, suggestion_id)
    suggestion.status = payload.status
    suggestion.raw = {**(suggestion.raw or {}), "decision": payload.status}
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)
    return suggestion
