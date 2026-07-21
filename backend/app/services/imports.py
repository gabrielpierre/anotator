import time
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AuditEvent, JobRecord, Project
from app.schemas import ImportTaskCreate
from app.services.artifacts import ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.jobs import mark_job_running, succeed_job, update_job_progress
from app.services.sync import CvatSyncService

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def validate_import_quota(db: Session, payload: ImportTaskCreate, uploaded_bytes: int | None = None) -> Project | None:
    project = _resolve_project(db, payload.project_id)
    if project is None:
        return None
    storage = project.raw.get("storage") if isinstance(project.raw, dict) else None
    if not isinstance(storage, dict) or storage.get("enforce_quota") is False:
        return project
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    if not quota_bytes:
        return project
    used_bytes = _int_value(storage.get("used_bytes")) or 0
    estimated = uploaded_bytes if uploaded_bytes is not None else payload.estimated_bytes
    if estimated is None and payload.source_path:
        estimated = _path_size(Path(payload.source_path))
    if estimated is None:
        estimated = 0
    if used_bytes + estimated > quota_bytes:
        raise ValueError("Import exceeds project storage quota")
    return project


def run_import_task_job(
    db: Session,
    *,
    job_id: str,
    settings: Settings,
    artifact_store: ArtifactStore,
    client: CvatClient,
) -> JobRecord:
    job = mark_job_running(db, job_id, "Creating CVAT task.")
    payload = ImportTaskCreate.model_validate((job.raw or {}).get("payload") or {})
    project = validate_import_quota(db, payload)
    files = _files_from_job(job, artifact_store)
    if not files and payload.source_path:
        files = _files_from_source_path(Path(payload.source_path))
    cvat_project_id = _cvat_project_id(project)
    task_payload = client.create_task(name=payload.name, labels=payload.labels, project_id=cvat_project_id)
    task_id = task_payload.get("id")
    if task_id is None:
        raise RuntimeError("CVAT did not return a task id")
    update_job_progress(db, job_id, 35, detail=f"Created CVAT task {task_id}.")
    upload_result: dict[str, Any] | None = None
    upload_request: dict[str, Any] | None = None
    if files:
        upload_result = client.upload_task_data(task_id, files=files)
        update_job_progress(db, job_id, 55, detail=f"Uploaded {len(files)} files to CVAT task {task_id}.")
        request_id = _request_id_from_payload(upload_result)
        if request_id:
            upload_request = _wait_for_cvat_request(client, request_id, settings)
        update_job_progress(db, job_id, 70, detail=f"CVAT processed {len(files)} files for task {task_id}.")
    sync_result = None
    if payload.sync_after_import:
        sync_result = CvatSyncService(db, client, job_id=job_id).sync_all().model_dump(mode="json")
        update_job_progress(db, job_id, 95, detail="Synchronized imported CVAT task.")

    raw_update = {
        "cvat_task_id": str(task_id),
        "cvat_task": task_payload,
        "upload_result": upload_result,
        "upload_request": upload_request,
        "sync_result": sync_result,
    }
    db.add(
        AuditEvent(
            actor="system",
            action="import_task_completed",
            target=job_id,
            payload=raw_update,
        )
    )
    return succeed_job(db, job_id, detail=f"Imported CVAT task {task_id}.", raw_update=raw_update)


def _files_from_job(job: JobRecord, artifact_store: ArtifactStore) -> list[tuple[str, bytes, str]]:
    uploads = (job.raw or {}).get("upload_artifacts")
    if not isinstance(uploads, list):
        return []
    files = []
    for upload in uploads:
        if not isinstance(upload, dict) or not upload.get("uri"):
            continue
        blob = artifact_store.get(str(upload["uri"]))
        files.append(
            (
                str(upload.get("filename") or Path(str(upload["uri"])).name),
                blob.content,
                str(upload.get("content_type") or blob.content_type or "application/octet-stream"),
            )
        )
    return files


def _files_from_source_path(path: Path) -> list[tuple[str, bytes, str]]:
    candidates = [path]
    if path.is_dir():
        candidates = sorted(file for file in path.rglob("*") if file.suffix.lower() in IMAGE_EXTENSIONS)
    files = []
    for file in candidates:
        if file.is_file():
            files.append((file.name, file.read_bytes(), _content_type(file)))
    return files


def _resolve_project(db: Session, project_id: str | None) -> Project | None:
    if not project_id:
        return None
    return db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))


def _cvat_project_id(project: Project | None) -> str | int | None:
    if project is None:
        return None
    external_id = str(project.external_id)
    return int(external_id) if external_id.isdigit() else None


def _path_size(path: Path) -> int | None:
    if not path.exists():
        return None
    if path.is_file():
        return path.stat().st_size
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".bmp":
        return "image/bmp"
    return "application/octet-stream"


def _wait_for_cvat_request(client: CvatClient, request_id: str, settings: Settings) -> dict[str, Any]:
    last_payload: dict[str, Any] = {}
    terminal_statuses = {"finished", "completed", "succeeded", "failed", "error"}
    for _ in range(settings.cvat_request_poll_attempts):
        payload = client.retrieve_request(request_id)
        last_payload = payload if isinstance(payload, dict) else {}
        status = str(
            last_payload.get("status")
            or last_payload.get("state")
            or last_payload.get("result", {}).get("status")
            or ""
        ).lower()
        if status in terminal_statuses:
            if status in {"failed", "error"}:
                raise RuntimeError(f"CVAT request {request_id} failed: {last_payload}")
            return last_payload
        time.sleep(settings.cvat_request_poll_interval_seconds)
    raise TimeoutError(f"Timed out waiting for CVAT request {request_id}: {last_payload}")


def _request_id_from_payload(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("rq_id", "request_id", "id"):
        value = payload.get(key)
        if value:
            return str(value)
    result = payload.get("result")
    if isinstance(result, dict):
        return _request_id_from_payload(result)
    return None


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
