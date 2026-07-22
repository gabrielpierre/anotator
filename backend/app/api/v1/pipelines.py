from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import (
    filter_visible_pipelines,
    project_for_pipeline,
    project_for_release,
    project_payload,
    project_values,
    require_pipeline_access,
    require_release_access,
    require_task_access,
)
from app.models import AuditEvent, PipelineDefinition, PipelineRun, Project, User
from app.schemas import PipelineRunCreate, PipelineRunRead
from app.services.jobs import attach_celery_task, create_job
from app.services.pipelines import DEFAULT_PIPELINE_GRAPH
from app.tasks import pipeline_run_task

router = APIRouter()


@router.get("", response_model=list[PipelineRunRead])
def list_pipeline_runs(
    project_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[PipelineRun]:
    runs = list(db.scalars(select(PipelineRun).order_by(PipelineRun.created_at.desc())).all())
    if project_id:
        project = require_project_access(db, user, project_id)
        runs = [run for run in runs if project_values(project_for_pipeline(db, run)) & project_values(project)]
    return filter_visible_pipelines(db, user, runs)


@router.get("/{run_id}", response_model=PipelineRunRead)
def get_pipeline_run(
    run_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> PipelineRun:
    return require_pipeline_access(db, user, run_id)


@router.post("", response_model=PipelineRunRead)
def create_pipeline_run(
    payload: PipelineRunCreate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> PipelineRun:
    project = _resolve_pipeline_project(db, user, payload)
    definition = _definition_payload(db, payload)
    definition = {**definition, **project_payload(project)}
    lineage = {
        **payload.lineage,
        "source_release_id": payload.source_release_id,
        "target_release_name": payload.target_release_name,
        **project_payload(project),
    }
    run = PipelineRun(name=payload.name, definition=definition, lineage=lineage, status="queued", progress=0)
    db.add(run)
    db.flush()
    job = create_job(
        db,
        kind="pipeline",
        name=run.name,
        detail="Pipeline queued.",
        raw={"operation": "pipeline_run", "pipeline_run_id": run.id, "lineage": lineage, **project_payload(project)},
    )
    db.add(
        AuditEvent(
            actor=user.email,
            action="pipeline_run_created",
            target=run.id,
            payload={
                "name": run.name,
                "definition_id": payload.definition_id,
                "source_release_id": payload.source_release_id,
                "target_release_name": payload.target_release_name,
                "lineage": lineage,
                **project_payload(project),
            },
        )
    )
    db.commit()
    task = pipeline_run_task.delay(job.id)
    attach_celery_task(db, job.id, task.id)
    db.refresh(run)
    return run


def _resolve_pipeline_project(db: Session, user: User, payload: PipelineRunCreate) -> Project:
    project = require_project_access(db, user, payload.project_id) if payload.project_id else None
    if payload.source_release_id:
        release = require_release_access(db, user, payload.source_release_id)
        release_project = project_for_release(db, release)
        if release_project is None:
            raise HTTPException(status_code=400, detail="Source release has no project ownership")
        if project is not None and release_project.id != project.id:
            raise HTTPException(status_code=400, detail="Source release does not belong to selected project")
        project = release_project
    for task_external_id in payload.task_external_ids:
        task = require_task_access(db, user, task_external_id)
        task_project = require_project_access(db, user, task.project_external_id) if task.project_external_id else None
        if task_project is None:
            raise HTTPException(status_code=400, detail="Source task has no project ownership")
        if project is not None and task_project.id != project.id:
            raise HTTPException(status_code=400, detail="Pipeline cannot mix tasks from different projects")
        project = task_project
    if project is None:
        raise HTTPException(status_code=400, detail="Pipeline requires project_id, source_release_id or task_external_ids")
    if not payload.source_release_id and not payload.task_external_ids:
        raise HTTPException(status_code=400, detail="Pipeline requires source_release_id or task_external_ids")
    return project


def _definition_payload(db: Session, payload: PipelineRunCreate) -> dict:
    stored = db.get(PipelineDefinition, payload.definition_id) if payload.definition_id else None
    graph = stored.graph if stored is not None else {}
    config = stored.config if stored is not None else {}
    definition = {
        **DEFAULT_PIPELINE_GRAPH,
        **graph,
        **config,
        **payload.definition,
    }
    if payload.definition_id:
        definition["definition_id"] = payload.definition_id
    if stored is not None:
        definition["definition_name"] = stored.name
        definition["definition_version"] = stored.version
    if payload.source_release_id:
        definition["source_release_id"] = payload.source_release_id
    if payload.project_id:
        definition["project_id"] = payload.project_id
    if payload.target_release_name:
        definition["target_release_name"] = payload.target_release_name
    if payload.task_external_ids:
        definition["task_external_ids"] = payload.task_external_ids
    if payload.sample_policy:
        definition["sample_policy"] = payload.sample_policy
    return definition
