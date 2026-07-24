from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import job_visible, project_payload
from app.core.config import get_settings
from app.models import AuditEvent, JobRecord, Project, User
from app.schemas import ImportJobRead, ImportTaskCreate, JobRead
from app.services.artifacts import S3ArtifactStore
from app.services.imports import (
    DuplicateImportImagesError,
    build_import_file_manifest,
    is_import_image_file,
    record_import_storage_usage,
    validate_import_file_manifest_unique,
    validate_import_quota,
)
from app.services.jobs import attach_celery_task, create_job, fail_job
from app.tasks import import_task_job_task

router = APIRouter()


@router.post("/tasks", response_model=ImportJobRead)
def create_import_task(
    payload: ImportTaskCreate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> ImportJobRead:
    payload = _normalize_import_project(db, payload)
    payload = _normalize_import_assignee(payload, actor)
    project = require_project_access(db, actor, payload.project_id) if payload.project_id else None
    if project is None and actor.role != "admin":
        raise HTTPException(status_code=403, detail="Project is required to import images")
    _validate_assignee(db, payload, actor)
    store = S3ArtifactStore(get_settings())
    try:
        store.verify_available()
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Storage de artefatos indisponivel. Inicie MinIO/Docker antes de importar imagens.",
        ) from exc
    try:
        validate_import_quota(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    job = create_job(
        db,
        kind="import",
        name=f"Import CVAT task {payload.name}",
        detail="Queued import job." if payload.source_path else "Waiting for upload files.",
        raw={
            "operation": "import_task",
            "payload": payload.model_dump(mode="json"),
            "created_by": _actor_payload(actor),
            **project_payload(project),
        },
    )
    db.add(
        AuditEvent(
            actor=actor.email,
            action="import_task_queued",
            target=job.id,
            payload=payload.model_dump(mode="json"),
        )
    )
    db.commit()
    if payload.source_path:
        task = import_task_job_task.delay(job.id)
        attach_celery_task(db, job.id, task.id)
    db.refresh(job)
    return ImportJobRead(job=JobRead.model_validate(job))


def _validate_assignee(db: Session, payload: ImportTaskCreate, actor: User) -> None:
    if not payload.assignee_user_id:
        return
    if actor.role != "admin":
        if actor.role != "anotador" or payload.assignee_user_id != actor.id:
            raise HTTPException(status_code=403, detail="Admin role required to assign annotators")
    assignee = db.get(User, payload.assignee_user_id)
    if assignee is None or assignee.status != "active":
        raise HTTPException(status_code=404, detail="Active annotator not found")
    if assignee.role != "anotador":
        raise HTTPException(status_code=400, detail="Only annotators can be assigned to a task")


def _normalize_import_assignee(payload: ImportTaskCreate, actor: User) -> ImportTaskCreate:
    if actor.role == "anotador" and not payload.assignee_user_id:
        return payload.model_copy(update={"assignee_user_id": actor.id})
    return payload


def _normalize_import_project(db: Session, payload: ImportTaskCreate) -> ImportTaskCreate:
    if payload.project_id:
        return payload
    active_projects = list(
        db.scalars(select(Project).where(Project.status == "active").order_by(Project.created_at)).all()
    )
    if len(active_projects) != 1:
        return payload
    return payload.model_copy(update={"project_id": active_projects[0].id})


def _actor_payload(actor: User) -> dict[str, str]:
    return {
        "user_id": actor.id,
        "name": actor.name,
        "email": actor.email,
        "role": actor.role,
    }


@router.post("/tasks/{job_id}/files", response_model=ImportJobRead)
async def upload_import_task_files(
    job_id: str,
    files: list[UploadFile] = File(...),
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> ImportJobRead:
    job = db.get(JobRecord, job_id)
    if job is None or job.kind != "import":
        raise HTTPException(status_code=404, detail="Import job not found")
    if not job_visible(db, actor, job):
        raise HTTPException(status_code=404, detail="Import job not found")
    if job.status not in {"queued", "failed"}:
        raise HTTPException(status_code=409, detail="Import job is not accepting files")
    payload = ImportTaskCreate.model_validate((job.raw or {}).get("payload") or {})
    duplicate_names = _duplicate_upload_filenames(files)
    if duplicate_names:
        detail = f"Arquivos com nomes repetidos no lote: {', '.join(duplicate_names)}"
        fail_job(db, job.id, reason=detail)
        raise HTTPException(
            status_code=409,
            detail=detail,
        )
    store = S3ArtifactStore(get_settings())
    try:
        store.verify_available()
    except Exception as exc:
        job.status = "failed"
        job.detail = "Upload nao concluido: storage de artefatos indisponivel."
        db.add(job)
        db.add(
            AuditEvent(
                actor="system",
                action="job_failed",
                target=job.id,
                payload={"reason": job.detail},
            )
        )
        db.commit()
        raise HTTPException(
            status_code=503,
            detail="Storage de artefatos indisponivel. Inicie MinIO/Docker antes de importar imagens.",
        ) from exc
    prepared_files: list[tuple[str, bytes, str]] = []
    total_bytes = 0
    for file in files:
        content = await file.read()
        total_bytes += len(content)
        filename = file.filename or "upload.bin"
        content_type = file.content_type or "application/octet-stream"
        prepared_files.append((filename, content, content_type))
    manifest = build_import_file_manifest(prepared_files)
    image_manifest = build_import_file_manifest(
        [
            (filename, content, content_type)
            for filename, content, content_type in prepared_files
            if is_import_image_file(filename, content_type)
        ]
    )
    try:
        validate_import_file_manifest_unique(
            db,
            payload,
            image_manifest,
            artifact_store=store,
            current_job_id=job.id,
        )
    except DuplicateImportImagesError as exc:
        fail_job(
            db,
            job.id,
            reason=str(exc),
            raw_update={"duplicate_import_conflicts": exc.conflicts},
        )
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    uploaded = []
    for index, ((filename, content, content_type), metadata) in enumerate(
        zip(prepared_files, manifest, strict=True)
    ):
        key = f"imports/{job.id}/uploads/{index:06d}-{metadata['filename']}"
        uri = store.put_bytes(key, content, content_type)
        uploaded.append(
            {
                **metadata,
                "uri": uri,
            }
        )
    try:
        project = validate_import_quota(db, payload, uploaded_bytes=total_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    job.raw = {**(job.raw or {}), "upload_artifacts": uploaded, "upload_storage_bytes": total_bytes}
    job.detail = f"Queued upload of {len(uploaded)} files."
    db.add(job)
    record_import_storage_usage(db, project, total_bytes)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="import_task_files_uploaded",
            target=job.id,
            payload={"files": uploaded, "total_bytes": total_bytes},
        )
    )
    db.commit()
    task = import_task_job_task.delay(job.id)
    attach_celery_task(db, job.id, task.id)
    db.refresh(job)
    return ImportJobRead(job=JobRead.model_validate(job))


def _duplicate_upload_filenames(files: list[UploadFile]) -> list[str]:
    seen: dict[str, str] = {}
    duplicates: dict[str, str] = {}
    for file in files:
        filename = (file.filename or "upload.bin").strip() or "upload.bin"
        key = filename.casefold()
        if key in seen:
            duplicates[key] = seen[key]
        else:
            seen[key] = filename
    return sorted(duplicates.values(), key=str.casefold)


def _int_value(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


@router.get("/{job_id}", response_model=ImportJobRead)
def get_import_job(
    job_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> ImportJobRead:
    job = db.get(JobRecord, job_id)
    if job is None or job.kind != "import":
        raise HTTPException(status_code=404, detail="Import job not found")
    if not job_visible(db, user, job):
        raise HTTPException(status_code=404, detail="Import job not found")
    return ImportJobRead(job=JobRead.model_validate(job))
