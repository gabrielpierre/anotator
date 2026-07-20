from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.config import get_settings
from app.models import AuditEvent, JobRecord, User
from app.schemas import ImportJobRead, ImportTaskCreate, JobRead
from app.services.artifacts import S3ArtifactStore
from app.services.imports import validate_import_quota
from app.services.jobs import attach_celery_task, create_job
from app.tasks import import_task_job_task

router = APIRouter()


@router.post("/tasks", response_model=ImportJobRead)
def create_import_task(
    payload: ImportTaskCreate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> ImportJobRead:
    try:
        validate_import_quota(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    job = create_job(
        db,
        kind="import",
        name=f"Import CVAT task {payload.name}",
        detail="Queued import job." if payload.source_path else "Waiting for upload files.",
        raw={"operation": "import_task", "payload": payload.model_dump(mode="json")},
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
    if job.status not in {"queued", "failed"}:
        raise HTTPException(status_code=409, detail="Import job is not accepting files")
    payload = ImportTaskCreate.model_validate((job.raw or {}).get("payload") or {})
    store = S3ArtifactStore(get_settings())
    uploaded = []
    total_bytes = 0
    for file in files:
        content = await file.read()
        total_bytes += len(content)
        filename = file.filename or "upload.bin"
        key = f"imports/{job.id}/uploads/{filename}"
        uri = store.put_bytes(key, content, file.content_type or "application/octet-stream")
        uploaded.append(
            {
                "filename": filename,
                "uri": uri,
                "content_type": file.content_type or "application/octet-stream",
                "size_bytes": len(content),
            }
        )
    try:
        validate_import_quota(db, payload, uploaded_bytes=total_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    job.raw = {**(job.raw or {}), "upload_artifacts": uploaded}
    job.detail = f"Queued upload of {len(uploaded)} files."
    db.add(job)
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


@router.get("/{job_id}", response_model=ImportJobRead)
def get_import_job(
    job_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> ImportJobRead:
    job = db.get(JobRecord, job_id)
    if job is None or job.kind != "import":
        raise HTTPException(status_code=404, detail="Import job not found")
    return ImportJobRead(job=JobRead.model_validate(job))
