from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DatasetRelease, JobRecord, Project, Task


def refresh_project_storage(
    db: Session,
    project: Project | None,
    *,
    flush: bool = True,
) -> int:
    """Persist the storage usage derived from data that still belongs to a project."""
    if project is None:
        return 0

    raw = dict(project.raw or {})
    storage = raw.get("storage")
    if not isinstance(storage, dict):
        return 0

    used_bytes = calculate_project_storage_bytes(db, project)
    quota_bytes = _as_int(storage.get("quota_bytes")) or 0
    percent = round((used_bytes / quota_bytes) * 100, 2) if quota_bytes else 0
    raw["storage"] = {
        **storage,
        "used_bytes": used_bytes,
        "used_gb": round(used_bytes / 1024**3, 3),
        "used_percent": percent,
        "percent": percent,
    }
    project.raw = raw
    db.add(project)
    if flush:
        db.flush()
    return used_bytes


def calculate_project_storage_bytes(db: Session, project: Project) -> int:
    """Return bytes for local task sources, release artifacts and pending uploads.

    Import uploads are temporary transport files. They are counted only while the
    corresponding task has not been materialized locally; after that, the task's
    import manifest is the source of truth. This prevents the same files from
    being counted twice and makes task deletion immediately reclaim its usage.
    """
    total = 0
    task_external_ids: set[str] = set()
    for task in db.scalars(
        select(Task).where(Task.project_external_id == project.external_id)
    ).all():
        task_external_ids.add(task.external_id)
        total += _task_storage_bytes(task)

    artifact_sizes: dict[str, int] = {}
    for release in db.scalars(
        select(DatasetRelease).where(DatasetRelease.project_id == project.id)
    ).all():
        for uri, size_bytes in _release_artifacts(release):
            if uri:
                artifact_sizes[uri] = max(artifact_sizes.get(uri, 0), size_bytes)
    total += sum(artifact_sizes.values())

    for job in db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all():
        if not _job_belongs_to_project(job, project):
            continue
        if _job_task_ids(job) & task_external_ids:
            continue
        total += _job_upload_bytes(job)

    return total


def _task_storage_bytes(task: Task) -> int:
    raw = task.raw if isinstance(task.raw, dict) else {}
    manifest = raw.get("local_import_manifest")
    if not isinstance(manifest, dict):
        return 0
    recorded = _as_int(manifest.get("storage_bytes"))
    if recorded is not None:
        return max(recorded, 0)
    files = manifest.get("files")
    if not isinstance(files, list):
        return 0
    return sum(
        max(_as_int(file.get("size_bytes")) or 0, 0)
        for file in files
        if isinstance(file, dict)
    )


def _release_artifacts(release: DatasetRelease) -> Iterable[tuple[str, int]]:
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    artifacts = snapshot.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            uri = artifact.get("uri")
            if isinstance(uri, str) and uri.startswith("s3://"):
                yield uri, max(_as_int(artifact.get("size_bytes")) or 0, 0)
    if release.artifact_uri and release.artifact_uri.startswith("s3://"):
        yield release.artifact_uri, 0


def _job_belongs_to_project(job: JobRecord, project: Project) -> bool:
    raw = job.raw if isinstance(job.raw, dict) else {}
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    project_payload = raw.get("project") if isinstance(raw.get("project"), dict) else {}
    candidates = {
        raw.get("project_id"),
        raw.get("project_external_id"),
        payload.get("project_id"),
        payload.get("project_external_id"),
        project_payload.get("id"),
        project_payload.get("project_id"),
        project_payload.get("external_id"),
        project_payload.get("project_external_id"),
    }
    return str(project.id) in {str(value) for value in candidates if value} or str(
        project.external_id
    ) in {str(value) for value in candidates if value}


def _job_task_ids(job: JobRecord) -> set[str]:
    raw = job.raw if isinstance(job.raw, dict) else {}
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    identifiers = {str(job.task_external_id)} if job.task_external_id else set()
    for source in (raw, payload):
        for key in ("cvat_task_id", "task_external_id"):
            value = source.get(key)
            if value:
                identifiers.add(str(value))
        task_ids = source.get("cvat_task_ids")
        if isinstance(task_ids, list):
            identifiers.update(str(value) for value in task_ids if value)
    return identifiers


def _job_upload_bytes(job: JobRecord) -> int:
    raw = job.raw if isinstance(job.raw, dict) else {}
    recorded = _as_int(raw.get("upload_storage_bytes"))
    if recorded is not None:
        return max(recorded, 0)
    uploads = raw.get("upload_artifacts")
    if not isinstance(uploads, list):
        return 0
    return sum(
        max(_as_int(upload.get("size_bytes")) or 0, 0)
        for upload in uploads
        if isinstance(upload, dict)
    )


def _as_int(value: Any) -> int | None:
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
