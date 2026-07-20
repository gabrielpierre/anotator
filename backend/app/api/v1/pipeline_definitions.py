from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import AuditEvent, PipelineDefinition
from app.schemas import PipelineDefinitionCreate, PipelineDefinitionRead
from app.services.pipelines import DEFAULT_PIPELINE_GRAPH

router = APIRouter()


@router.get("", response_model=list[PipelineDefinitionRead])
def list_pipeline_definitions(db: Session = Depends(db_session)) -> list[PipelineDefinition]:
    return list(db.scalars(select(PipelineDefinition).order_by(PipelineDefinition.created_at.desc())).all())


@router.post("", response_model=PipelineDefinitionRead)
def create_pipeline_definition(
    payload: PipelineDefinitionCreate,
    db: Session = Depends(db_session),
) -> PipelineDefinition:
    existing = db.scalar(
        select(PipelineDefinition).where(
            PipelineDefinition.name == payload.name,
            PipelineDefinition.version == payload.version,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="Pipeline definition version already exists")
    definition = PipelineDefinition(
        name=payload.name,
        version=payload.version,
        graph={**DEFAULT_PIPELINE_GRAPH, **payload.graph},
        config=payload.config,
        status="active",
    )
    db.add(definition)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="pipeline_definition_created",
            target=definition.id,
            payload={"name": definition.name, "version": definition.version},
        )
    )
    db.commit()
    db.refresh(definition)
    return definition
