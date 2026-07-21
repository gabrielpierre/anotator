from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import AuditEvent, PipelineDefinition, PipelineRun
from app.schemas import PipelineRunCreate, PipelineRunRead
from app.services.jobs import attach_celery_task, create_job
from app.services.pipelines import DEFAULT_PIPELINE_GRAPH
from app.tasks import pipeline_run_task

router = APIRouter()


@router.get("", response_model=list[PipelineRunRead])
def list_pipeline_runs(db: Session = Depends(db_session)) -> list[PipelineRun]:
    return list(db.scalars(select(PipelineRun).order_by(PipelineRun.created_at.desc())).all())


@router.get("/{run_id}", response_model=PipelineRunRead)
def get_pipeline_run(run_id: str, db: Session = Depends(db_session)) -> PipelineRun:
    run = db.get(PipelineRun, run_id)
    if run is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Pipeline run not found")
    return run


@router.post("", response_model=PipelineRunRead)
def create_pipeline_run(
    payload: PipelineRunCreate,
    db: Session = Depends(db_session),
) -> PipelineRun:
    definition = _definition_payload(db, payload)
    lineage = {
        **payload.lineage,
        "source_release_id": payload.source_release_id,
        "target_release_name": payload.target_release_name,
    }
    run = PipelineRun(name=payload.name, definition=definition, lineage=lineage, status="queued", progress=0)
    db.add(run)
    db.flush()
    job = create_job(
        db,
        kind="pipeline",
        name=run.name,
        detail="Pipeline queued.",
        raw={"operation": "pipeline_run", "pipeline_run_id": run.id, "lineage": lineage},
    )
    db.add(
        AuditEvent(
            actor="system",
            action="pipeline_run_created",
            target=run.id,
        payload={
            "name": run.name,
            "definition_id": payload.definition_id,
            "source_release_id": payload.source_release_id,
            "target_release_name": payload.target_release_name,
            "lineage": lineage,
        },
        )
    )
    db.commit()
    task = pipeline_run_task.delay(job.id)
    attach_celery_task(db, job.id, task.id)
    db.refresh(run)
    return run


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
    if payload.target_release_name:
        definition["target_release_name"] = payload.target_release_name
    if payload.task_external_ids:
        definition["task_external_ids"] = payload.task_external_ids
    if payload.sample_policy:
        definition["sample_policy"] = payload.sample_policy
    return definition
