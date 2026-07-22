from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session, require_project_access
from app.api.project_scope import (
    filter_visible_models,
    project_for_model,
    project_for_release,
    project_payload,
    project_values,
    require_model_access,
    require_release_access,
)
from app.api.v1.artifacts import artifact_read_from_uri, persist_artifact_record
from app.core.config import get_settings
from app.models import ArtifactRecord, AuditEvent, InferenceSuggestion, ModelVersion, User
from app.schemas import ModelImportRead, ModelVersionCreate, ModelVersionRead, ModelVersionUpdate
from app.services.artifacts import S3ArtifactStore

router = APIRouter()


@router.get("", response_model=list[ModelVersionRead])
def list_model_versions(
    project_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[ModelVersion]:
    models = list(db.scalars(select(ModelVersion).order_by(ModelVersion.created_at.desc())).all())
    if project_id:
        project = require_project_access(db, user, project_id)
        models = [model for model in models if project_values(project_for_model(db, model)) & project_values(project)]
    return filter_visible_models(db, user, models)


@router.post("", response_model=ModelVersionRead)
def create_model_version(
    payload: ModelVersionCreate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> ModelVersion:
    _ensure_unique_model(db, payload.name, payload.version)
    project = None
    if payload.dataset_release_id:
        release = require_release_access(db, actor, payload.dataset_release_id)
        project = project_for_release(db, release)
    elif payload.project_id:
        project = require_project_access(db, actor, payload.project_id)
    else:
        raise HTTPException(status_code=400, detail="project_id or dataset_release_id is required")
    model = ModelVersion(
        name=payload.name,
        version=payload.version,
        family=payload.family,
        base_model=payload.base_model,
        dataset_release_id=payload.dataset_release_id,
        artifact_uri=payload.artifact_uri,
        metrics=payload.metrics,
        params={**payload.params, **project_payload(project)},
        status=payload.status,
    )
    db.add(model)
    db.flush()
    db.add(
        AuditEvent(
            actor=actor.email,
            action="model_registered",
            target=model.id,
            payload={"name": model.name, "version": model.version, "artifact_uri": model.artifact_uri},
        )
    )
    db.commit()
    db.refresh(model)
    return model


@router.post("/import", response_model=ModelImportRead)
async def import_model_weight(
    file: UploadFile = File(...),
    name: str = Form(...),
    version: str = Form(...),
    family: str = Form("detection"),
    base_model: str = Form("manual"),
    dataset_release_id: str | None = Form(None),
    project_id: str | None = Form(None),
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> ModelImportRead:
    _ensure_unique_model(db, name, version)
    project = None
    if dataset_release_id:
        release = require_release_access(db, actor, dataset_release_id)
        project = project_for_release(db, release)
    elif project_id:
        project = require_project_access(db, actor, project_id)
    else:
        raise HTTPException(status_code=400, detail="project_id or dataset_release_id is required")
    model = ModelVersion(
        name=name,
        version=version,
        family=family,
        base_model=base_model,
        dataset_release_id=dataset_release_id,
        params=project_payload(project),
        status="registered",
    )
    db.add(model)
    db.flush()
    filename = file.filename or "weights.pt"
    content = await file.read()
    uri = S3ArtifactStore(get_settings()).put_bytes(
        f"models/{model.id}/{filename}",
        content,
        file.content_type or "application/octet-stream",
    )
    model.artifact_uri = uri
    artifact = persist_artifact_record(
        db,
        uri=uri,
        name=filename,
        kind="model",
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(content),
        owner_type="model",
        owner_id=model.id,
    )
    db.add(model)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="model_imported",
            target=model.id,
            payload={"name": model.name, "version": model.version, "artifact_uri": uri, "artifact_id": artifact.id},
        )
    )
    db.commit()
    db.refresh(model)
    return ModelImportRead(
        model=ModelVersionRead.model_validate(model),
        artifact=artifact_read_from_uri(
            uri,
            name=artifact.name,
            kind=artifact.kind,
            content_type=artifact.content_type,
            size_bytes=artifact.size_bytes,
            owner_type=artifact.owner_type,
            owner_id=artifact.owner_id,
        ),
    )


@router.patch("/{model_id}", response_model=ModelVersionRead)
def update_model_version(
    model_id: str,
    payload: ModelVersionUpdate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> ModelVersion:
    model = require_model_access(db, actor, model_id)
    changes: dict[str, object] = {}
    for field in (
        "name",
        "version",
        "family",
        "base_model",
        "dataset_release_id",
        "artifact_uri",
        "metrics",
        "params",
        "status",
    ):
        value = getattr(payload, field)
        if value is not None:
            setattr(model, field, value)
            changes[field] = value
    if payload.dataset_release_id is not None:
        release = require_release_access(db, actor, payload.dataset_release_id)
        model.params = {**(model.params or {}), **project_payload(project_for_release(db, release))}
    elif payload.project_id is not None:
        project = require_project_access(db, actor, payload.project_id)
        model.params = {**(model.params or {}), **project_payload(project)}
    elif payload.params is not None:
        owner_project = project_for_model(db, model)
        if owner_project is not None:
            model.params = {**model.params, **project_payload(owner_project)}
    if "name" in changes or "version" in changes:
        existing = db.scalar(
            select(ModelVersion).where(
                ModelVersion.name == model.name,
                ModelVersion.version == model.version,
                ModelVersion.id != model.id,
            )
        )
        if existing is not None:
            raise HTTPException(status_code=409, detail="Model name/version already exists")
    if changes:
        db.add(AuditEvent(actor=actor.email, action="model_updated", target=model.id, payload=changes))
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


@router.post("/{model_id}/promote", response_model=ModelVersionRead)
def promote_model(
    model_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> ModelVersion:
    model = require_model_access(db, actor, model_id)
    model_project_values = project_values(project_for_model(db, model))
    promoted = list(
        db.scalars(
            select(ModelVersion).where(
                ModelVersion.name == model.name,
                ModelVersion.status == "promoted",
                ModelVersion.id != model.id,
            )
        ).all()
    )
    for row in promoted:
        if project_values(project_for_model(db, row)) != model_project_values:
            continue
        row.status = "registered"
        db.add(row)
    model.status = "promoted"
    db.add(model)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="model_promoted",
            target=model.id,
            payload={"name": model.name, "version": model.version},
        )
    )
    db.commit()
    db.refresh(model)
    return model


@router.post("/{model_id}/archive", response_model=ModelVersionRead)
def archive_model(
    model_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> ModelVersion:
    model = require_model_access(db, actor, model_id)
    model.status = "archived"
    db.add(model)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="model_archived",
            target=model.id,
            payload={"name": model.name, "version": model.version},
        )
    )
    db.commit()
    db.refresh(model)
    return model


@router.delete("/{model_id}", response_model=dict)
def delete_model(
    model_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> dict:
    model = require_model_access(db, actor, model_id)
    artifact_uris = {model.artifact_uri} if model.artifact_uri else set()
    artifact_filters = [((ArtifactRecord.owner_type == "model") & (ArtifactRecord.owner_id == model.id))]
    if artifact_uris:
        artifact_filters.append(ArtifactRecord.uri.in_(artifact_uris))
    artifact_records = list(
        db.scalars(select(ArtifactRecord).where(or_(*artifact_filters))).all()
    )
    artifact_uris.update(record.uri for record in artifact_records if record.uri)

    store = S3ArtifactStore(get_settings())
    deleted_objects = 0
    warnings: list[str] = []
    for uri in sorted(artifact_uris):
        try:
            store.delete(uri)
            deleted_objects += 1
        except Exception as exc:
            warnings.append(f"Artifact {uri} nao removido do storage: {exc}")

    deleted_artifact_records = 0
    for artifact in artifact_records:
        db.delete(artifact)
        deleted_artifact_records += 1
    deleted_suggestions = db.execute(delete(InferenceSuggestion).where(InferenceSuggestion.model_id == model.id)).rowcount or 0

    deleted_payload = {
        "model_id": model.id,
        "name": model.name,
        "version": model.version,
        "artifact_objects": deleted_objects,
        "artifact_records": deleted_artifact_records,
        "inference_suggestions": deleted_suggestions,
        "warnings": warnings,
    }
    db.add(AuditEvent(actor=actor.email, action="model_deleted", target=model.id, payload=deleted_payload))
    db.delete(model)
    db.commit()
    return deleted_payload


@router.get("/{model_id}/download")
def download_model(
    model_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Response:
    model = require_model_access(db, user, model_id)
    if not model.artifact_uri:
        raise HTTPException(status_code=404, detail="Model artifact not found")
    try:
        blob = S3ArtifactStore(get_settings()).get(model.artifact_uri)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Model artifact not found") from exc
    filename = f"{model.name}-{model.version}.pt"
    return Response(
        content=blob.content,
        media_type=blob.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _require_model(db: Session, model_id: str) -> ModelVersion:
    model = db.get(ModelVersion, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")
    return model


def _ensure_unique_model(db: Session, name: str, version: str) -> None:
    if db.scalar(select(ModelVersion).where(ModelVersion.name == name, ModelVersion.version == version)) is not None:
        raise HTTPException(status_code=409, detail="Model name/version already exists")
