import hashlib
import time
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AuditEvent, JobRecord, Project, ProjectMember, Task, TaskDataMeta, User
from app.schemas import ImportTaskCreate
from app.services.artifacts import ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.jobs import mark_job_running, succeed_job, update_job_progress
from app.services.sync import CvatSyncService

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
ACTIVE_IMPORT_STATUSES = {"queued", "running", "paused"}


class DuplicateImportImagesError(ValueError):
    def __init__(self, conflicts: list[dict[str, Any]]):
        self.conflicts = conflicts
        super().__init__(_duplicate_import_message(conflicts))


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
    import_manifest = build_import_file_manifest(files)
    validate_import_file_manifest_unique(
        db,
        payload,
        import_manifest,
        artifact_store=artifact_store,
        current_job_id=job.id,
    )
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
    assignee = _finalize_imported_task(
        db,
        str(task_id),
        payload.assignee_user_id,
        task_payload,
        project,
        import_manifest,
    )

    raw_update = {
        "cvat_task_id": str(task_id),
        "cvat_task": task_payload,
        "assignee": assignee,
        "import_manifest": {"files": import_manifest},
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


def build_import_file_manifest(files: list[tuple[str, bytes, str]]) -> list[dict[str, Any]]:
    return [
        {
            "filename": _safe_filename(filename),
            "normalized_filename": _normalized_filename(filename),
            "sha256": hashlib.sha256(content).hexdigest(),
            "size_bytes": len(content),
            "content_type": content_type or "application/octet-stream",
        }
        for filename, content, content_type in files
    ]


def validate_import_file_manifest_unique(
    db: Session,
    payload: ImportTaskCreate,
    manifest: list[dict[str, Any]],
    *,
    artifact_store: ArtifactStore | None = None,
    current_job_id: str | None = None,
) -> None:
    if not manifest:
        return
    project = _resolve_project(db, payload.project_id)
    conflicts = [
        *_incoming_manifest_conflicts(manifest),
        *_existing_manifest_conflicts(
            db,
            payload,
            manifest,
            project=project,
            artifact_store=artifact_store,
            current_job_id=current_job_id,
        ),
    ]
    if conflicts:
        raise DuplicateImportImagesError(conflicts)


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


def _finalize_imported_task(
    db: Session,
    task_external_id: str,
    assignee_user_id: str | None,
    task_payload: dict[str, Any],
    project: Project | None,
    import_manifest: list[dict[str, Any]],
) -> dict[str, str] | None:
    assignee = db.get(User, assignee_user_id) if assignee_user_id else None
    if assignee is not None and (assignee.status != "active" or assignee.role != "anotador"):
        assignee = None

    task = db.scalar(select(Task).where(Task.external_id == task_external_id))
    if task is None:
        task = Task(
            external_id=task_external_id,
            name=str(task_payload.get("name") or f"Task {task_external_id}"),
        )
    if project is not None:
        task.project_external_id = project.external_id
    task.name = str(task_payload.get("name") or task.name)
    task.status = str(task_payload.get("status") or task.status or "unknown")
    task.size = int(task_payload.get("size") or task.size or 0)
    task.raw = {
        **(task.raw or {}),
        "local_import_manifest": {
            "files": import_manifest,
            "source": "cvat-plus",
        },
    }

    if assignee is None:
        db.add(task)
        db.flush()
        return None

    assignee_payload = {
        "user_id": assignee.id,
        "name": assignee.name,
        "email": assignee.email,
        "role": assignee.role,
    }
    task.raw = {**(task.raw or {}), "local_assignee": assignee_payload}
    db.add(task)
    _ensure_project_membership(db, task, assignee, project)
    db.flush()
    return assignee_payload


def _ensure_project_membership(db: Session, task: Task, assignee: User, project: Project | None) -> None:
    if project is None and task.project_external_id:
        project = db.scalar(select(Project).where(Project.external_id == task.project_external_id))
    if project is None:
        return
    membership = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == assignee.id)
    )
    if membership is not None:
        return
    db.add(
        ProjectMember(
            project_id=project.id,
            user_id=assignee.id,
            role="anotador",
            raw={"source": "import_assignment", "task_external_id": task.external_id},
        )
    )


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


def _incoming_manifest_conflicts(manifest: list[dict[str, Any]]) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    seen_names: dict[str, dict[str, Any]] = {}
    seen_hashes: dict[str, dict[str, Any]] = {}
    for item in manifest:
        name_key = str(item.get("normalized_filename") or "")
        sha256 = str(item.get("sha256") or "")
        if name_key and name_key in seen_names:
            conflicts.append(_conflict_payload(item, seen_names[name_key], reason="nome", scope="upload"))
        else:
            seen_names[name_key] = item
        if sha256 and sha256 in seen_hashes:
            conflicts.append(_conflict_payload(item, seen_hashes[sha256], reason="conteudo", scope="upload"))
        else:
            seen_hashes[sha256] = item
    return conflicts


def _existing_manifest_conflicts(
    db: Session,
    payload: ImportTaskCreate,
    manifest: list[dict[str, Any]],
    *,
    project: Project | None,
    artifact_store: ArtifactStore | None,
    current_job_id: str | None,
) -> list[dict[str, Any]]:
    existing = _existing_import_images(
        db,
        payload,
        project=project,
        artifact_store=artifact_store,
        current_job_id=current_job_id,
    )
    by_name = {
        str(item.get("normalized_filename")): item
        for item in existing
        if item.get("normalized_filename") and not item.get("sha256")
    }
    by_hash = {str(item.get("sha256")): item for item in existing if item.get("sha256")}
    conflicts: list[dict[str, Any]] = []
    for item in manifest:
        sha256 = str(item.get("sha256") or "")
        name_key = str(item.get("normalized_filename") or "")
        if sha256 and sha256 in by_hash:
            conflicts.append(_conflict_payload(item, by_hash[sha256], reason="conteudo", scope="projeto"))
        elif name_key and name_key in by_name:
            conflicts.append(_conflict_payload(item, by_name[name_key], reason="nome", scope="projeto"))
    return conflicts


def _existing_import_images(
    db: Session,
    payload: ImportTaskCreate,
    *,
    project: Project | None,
    artifact_store: ArtifactStore | None,
    current_job_id: str | None,
) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    tasks = list(db.scalars(_scoped_task_query(project)).all())
    import_jobs = list(db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all())
    upload_jobs_by_task = _upload_jobs_by_task(import_jobs)

    for task in tasks:
        task_images = _images_from_task(db, task)
        for job in upload_jobs_by_task.get(task.external_id, []):
            task_images.extend(_images_from_upload_artifacts(job, artifact_store))
        images.extend(_dedupe_existing_images(task_images))

    for job in import_jobs:
        if job.id == current_job_id or job.status not in ACTIVE_IMPORT_STATUSES:
            continue
        if (job.raw or {}).get("cvat_task_id"):
            continue
        raw_payload = (job.raw or {}).get("payload")
        if not isinstance(raw_payload, dict):
            continue
        other_payload = ImportTaskCreate.model_validate(raw_payload)
        if not _same_project_scope(other_payload.project_id, payload.project_id, project):
            continue
        images.extend(
            _dedupe_existing_images(
                _images_from_upload_artifacts(job, artifact_store),
                default_task_name=job.name,
            )
        )
    return images


def _scoped_task_query(project: Project | None):
    query = select(Task)
    if project is not None:
        return query.where(Task.project_external_id == project.external_id)
    return query.where(Task.project_external_id.is_(None))


def _upload_jobs_by_task(jobs: list[JobRecord]) -> dict[str, list[JobRecord]]:
    grouped: dict[str, list[JobRecord]] = {}
    for job in jobs:
        task_external_id = str((job.raw or {}).get("cvat_task_id") or "")
        if task_external_id:
            grouped.setdefault(task_external_id, []).append(job)
    return grouped


def _images_from_task(db: Session, task: Task) -> list[dict[str, Any]]:
    raw = task.raw or {}
    manifest = raw.get("local_import_manifest")
    images: list[dict[str, Any]] = []
    if isinstance(manifest, dict) and isinstance(manifest.get("files"), list):
        for item in manifest["files"]:
            if isinstance(item, dict):
                images.append(_existing_image_payload(item, task_name=task.name, task_external_id=task.external_id))

    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == task.external_id))
    if meta is not None:
        images.extend(_images_from_frame_meta(meta.frames, task))
    return images


def _images_from_frame_meta(frames: list[Any], task: Task) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        filename = frame.get("name") or frame.get("filename") or frame.get("file_name") or frame.get("path")
        if not filename:
            continue
        images.append(
            {
                "filename": _safe_filename(str(filename)),
                "normalized_filename": _normalized_filename(str(filename)),
                "task_name": task.name,
                "task_external_id": task.external_id,
            }
        )
    return images


def _images_from_upload_artifacts(
    job: JobRecord,
    artifact_store: ArtifactStore | None,
) -> list[dict[str, Any]]:
    uploads = (job.raw or {}).get("upload_artifacts")
    if not isinstance(uploads, list):
        return []
    task_external_id = str((job.raw or {}).get("cvat_task_id") or "") or None
    images: list[dict[str, Any]] = []
    for upload in uploads:
        if not isinstance(upload, dict):
            continue
        item = _existing_image_payload(
            upload,
            task_name=job.name,
            task_external_id=task_external_id,
        )
        if not item.get("sha256") and artifact_store is not None and upload.get("uri"):
            try:
                item["sha256"] = hashlib.sha256(artifact_store.get(str(upload["uri"])).content).hexdigest()
            except Exception:
                pass
        images.append(item)
    return images


def _dedupe_existing_images(
    images: list[dict[str, Any]],
    *,
    default_task_name: str | None = None,
) -> list[dict[str, Any]]:
    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for image in images:
        if default_task_name and not image.get("task_name"):
            image["task_name"] = default_task_name
        key = (str(image.get("normalized_filename") or ""), str(image.get("sha256") or ""))
        deduped[key] = image
    return list(deduped.values())


def _existing_image_payload(
    item: dict[str, Any],
    *,
    task_name: str | None,
    task_external_id: str | None,
) -> dict[str, Any]:
    filename = str(item.get("filename") or item.get("name") or "upload.bin")
    return {
        "filename": _safe_filename(filename),
        "normalized_filename": str(item.get("normalized_filename") or _normalized_filename(filename)),
        "sha256": item.get("sha256"),
        "size_bytes": item.get("size_bytes"),
        "content_type": item.get("content_type"),
        "task_name": task_name,
        "task_external_id": task_external_id,
    }


def _conflict_payload(
    incoming: dict[str, Any],
    existing: dict[str, Any],
    *,
    reason: str,
    scope: str,
) -> dict[str, Any]:
    return {
        "filename": incoming.get("filename"),
        "reason": reason,
        "scope": scope,
        "existing_filename": existing.get("filename"),
        "task_name": existing.get("task_name"),
        "task_external_id": existing.get("task_external_id"),
    }


def _same_project_scope(project_id: str | None, current_project_id: str | None, project: Project | None) -> bool:
    if project is None:
        return not project_id and not current_project_id
    valid_ids = {project.id, project.external_id}
    return str(project_id or "") in valid_ids and str(current_project_id or "") in valid_ids


def _safe_filename(filename: str) -> str:
    normalized = filename.replace("\\", "/").strip() or "upload.bin"
    return normalized.rsplit("/", 1)[-1] or "upload.bin"


def _normalized_filename(filename: str) -> str:
    return _safe_filename(filename).casefold()


def _duplicate_import_message(conflicts: list[dict[str, Any]]) -> str:
    visible = conflicts[:5]
    parts = []
    for conflict in visible:
        filename = str(conflict.get("filename") or "arquivo")
        reason = "mesmo conteudo" if conflict.get("reason") == "conteudo" else "mesmo nome"
        if conflict.get("scope") == "upload":
            parts.append(f"{filename} ({reason} no proprio upload)")
        else:
            task_name = str(conflict.get("task_name") or "outro lote")
            parts.append(f"{filename} ({reason} em {task_name})")
    hidden = len(conflicts) - len(visible)
    suffix = f" e mais {hidden}" if hidden > 0 else ""
    return f"Imagens duplicadas ou ja importadas neste projeto: {', '.join(parts)}{suffix}."


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
