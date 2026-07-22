from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.api.v1.artifacts import artifact_read_from_uri
from app.core.celery_app import celery_app
from app.core.config import get_settings
from app.models import ArtifactRecord, AuditEvent, DatasetRelease, JobRecord, Project, User
from app.schemas import ArtifactRead, DatasetReleaseCreate, DatasetReleaseRead, PreparedDatasetRead
from app.services.artifacts import S3ArtifactStore
from app.services.datasets import prepare_yolo_dataset
from app.services.jobs import ACTIVE_JOB_STATUSES, attach_celery_task, cancel_job, create_job
from app.services.releases import prepare_dataset_release
from app.tasks import build_dataset_release_task

router = APIRouter()


@router.get("", response_model=list[DatasetReleaseRead])
def list_releases(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[DatasetRelease]:
    return list(db.scalars(select(DatasetRelease).order_by(DatasetRelease.created_at.desc())).all())


@router.post("", response_model=DatasetReleaseRead)
def create_release(
    payload: DatasetReleaseCreate,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> DatasetRelease:
    settings = get_settings()
    try:
        release = prepare_dataset_release(db, payload=payload, settings=settings)
        job = create_job(
            db,
            kind="release",
            name=f"Build dataset release {release.name}",
            detail="Queued dataset release export.",
            raw={
                "operation": "dataset_release",
                "dataset_release_id": release.id,
                "payload": payload.model_dump(mode="json"),
            },
        )
        task = build_dataset_release_task.delay(job.id)
        attach_celery_task(db, job.id, task.id)
        release.snapshot = {**(release.snapshot or {}), "backend_job_id": job.id}
        db.add(release)
        db.commit()
        db.refresh(release)
        return release
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{release_id}", response_model=DatasetReleaseRead)
def get_release(
    release_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> DatasetRelease:
    return _require_release(db, release_id)


@router.get("/{release_id}/artifacts", response_model=list[ArtifactRead])
def list_release_artifacts(
    release_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[ArtifactRead]:
    release = _require_release(db, release_id)
    return [
        artifact_read_from_uri(
            str(artifact["uri"]),
            name=str(artifact.get("filename") or artifact.get("name") or "artifact"),
            kind="dataset_release",
            content_type=artifact.get("content_type"),
            size_bytes=artifact.get("size_bytes"),
            owner_type="dataset_release",
            owner_id=release.id,
        )
        for artifact in _release_artifacts(release)
    ]


@router.get("/{release_id}/download")
def download_release(
    release_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> Response:
    release = _require_release(db, release_id)
    uri = release.artifact_uri
    if not uri:
        artifacts = _release_artifacts(release)
        uri = str(artifacts[0]["uri"]) if artifacts else None
    if not uri:
        raise HTTPException(status_code=404, detail="Release artifact not found")
    try:
        blob = S3ArtifactStore(get_settings()).get(uri)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Release artifact not found") from exc
    return Response(
        content=blob.content,
        media_type=blob.content_type or "application/zip",
        headers={"Content-Disposition": f'attachment; filename="{release.name}.zip"'},
    )


@router.post("/{release_id}/prepare-yolo", response_model=PreparedDatasetRead)
def prepare_release_yolo(
    release_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> PreparedDatasetRead:
    try:
        prepared = prepare_yolo_dataset(db, release_id=release_id, artifact_store=S3ArtifactStore(get_settings()))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _prepared_dataset_read(release_id, prepared)


@router.get("/{release_id}/prepared-dataset", response_model=PreparedDatasetRead)
def get_prepared_dataset(
    release_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> PreparedDatasetRead:
    release = _require_release(db, release_id)
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    prepared = snapshot.get("prepared_dataset") if isinstance(snapshot.get("prepared_dataset"), dict) else {}
    return _prepared_dataset_read(release.id, prepared)


@router.delete("/{release_id}")
def delete_release(
    release_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> dict[str, Any]:
    release = _require_release(db, release_id)
    jobs = _release_jobs(db, release.id)
    canceled_jobs: list[str] = []
    for job in jobs:
        if job.status in ACTIVE_JOB_STATUSES:
            cancel_job(db, job.id, celery_app=celery_app, reason="Dataset release deleted by user")
            canceled_jobs.append(job.id)

    artifact_rows = _release_artifacts(release)
    artifact_uris = _release_artifact_uris(release)
    artifact_records = [
        record
        for record in db.scalars(select(ArtifactRecord)).all()
        if record.uri in artifact_uris or (record.owner_type == "dataset_release" and record.owner_id == release.id)
    ]
    for record in artifact_records:
        if record.uri.startswith("s3://"):
            artifact_uris.add(record.uri)

    artifact_store = S3ArtifactStore(get_settings())
    deleted_objects = 0
    artifact_errors: list[str] = []
    for uri in artifact_uris:
        try:
            artifact_store.delete(uri)
            deleted_objects += 1
        except Exception as exc:
            artifact_errors.append(f"{uri}: {exc}")

    deleted_artifact_records = 0
    for record in artifact_records:
        db.delete(record)
        deleted_artifact_records += 1

    _subtract_project_storage_usage(db, release, artifact_rows)

    db.add(
        AuditEvent(
            actor=actor.email,
            action="dataset_release_deleted",
            target=release.id,
            payload={
                "release_id": release.id,
                "name": release.name,
                "task_external_ids": release.task_external_ids,
                "artifact_uris": sorted(artifact_uris),
                "jobs": [job.id for job in jobs],
                "canceled_jobs": canceled_jobs,
                "deleted_objects": deleted_objects,
                "deleted_artifact_records": deleted_artifact_records,
                "artifact_errors": artifact_errors,
            },
        )
    )
    for job in jobs:
        db.delete(job)
    db.delete(release)
    db.commit()
    return {
        "id": release_id,
        "deleted": True,
        "canceled_jobs": canceled_jobs,
        "deleted_objects": deleted_objects,
        "deleted_artifact_records": deleted_artifact_records,
        "artifact_errors": artifact_errors,
    }


def _require_release(db: Session, release_id: str) -> DatasetRelease:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="Dataset release not found")
    return release


def _release_artifacts(release: DatasetRelease) -> list[dict]:
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    artifacts = snapshot.get("artifacts") if isinstance(snapshot.get("artifacts"), list) else []
    rows = [artifact for artifact in artifacts if isinstance(artifact, dict) and artifact.get("uri")]
    if not rows and release.artifact_uri:
        rows = [{"uri": release.artifact_uri, "name": f"{release.name}.zip"}]
    return rows


def _release_jobs(db: Session, release_id: str) -> list[JobRecord]:
    jobs = db.scalars(select(JobRecord).where(JobRecord.kind == "release").order_by(JobRecord.created_at.desc())).all()
    return [job for job in jobs if str((job.raw or {}).get("dataset_release_id")) == release_id]


def _release_artifact_uris(release: DatasetRelease) -> set[str]:
    uris: set[str] = set()
    if release.artifact_uri:
        uris.add(release.artifact_uri)
    for artifact in _release_artifacts(release):
        uri = artifact.get("uri")
        if isinstance(uri, str) and uri.startswith("s3://"):
            uris.add(uri)
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    uris.update(_nested_s3_uris(snapshot))
    return uris


def _nested_s3_uris(value: Any) -> set[str]:
    uris: set[str] = set()
    if isinstance(value, str) and value.startswith("s3://"):
        uris.add(value)
    elif isinstance(value, dict):
        for child in value.values():
            uris.update(_nested_s3_uris(child))
    elif isinstance(value, list):
        for child in value:
            uris.update(_nested_s3_uris(child))
    return uris


def _subtract_project_storage_usage(db: Session, release: DatasetRelease, artifacts: list[dict]) -> None:
    if not release.project_id:
        return
    project = db.get(Project, release.project_id)
    if project is None or not isinstance(project.raw, dict):
        return
    storage = project.raw.get("storage")
    if not isinstance(storage, dict):
        return
    removed_bytes = sum(_int_value(artifact.get("size_bytes")) or 0 for artifact in artifacts)
    if removed_bytes <= 0:
        return
    used_bytes = max((_int_value(storage.get("used_bytes")) or 0) - removed_bytes, 0)
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    percent = round((used_bytes / quota_bytes) * 100, 2) if quota_bytes else 0
    project.raw = {
        **project.raw,
        "storage": {
            **storage,
            "used_bytes": used_bytes,
            "used_gb": round(used_bytes / 1024**3, 3),
            "used_percent": percent,
        },
    }
    db.add(project)


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _prepared_dataset_read(release_id: str, prepared: dict) -> PreparedDatasetRead:
    return PreparedDatasetRead(
        release_id=release_id,
        status=str(prepared.get("status") or "missing"),
        artifact_uri=prepared.get("artifact_uri"),
        download_url=prepared.get("download_url"),
        data_yaml=prepared.get("data_yaml") if isinstance(prepared.get("data_yaml"), dict) else None,
        manifest=prepared.get("manifest") if isinstance(prepared.get("manifest"), dict) else None,
    )
