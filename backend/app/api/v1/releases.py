from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.api.v1.artifacts import artifact_read_from_uri
from app.core.config import get_settings
from app.models import DatasetRelease, User
from app.schemas import ArtifactRead, DatasetReleaseCreate, DatasetReleaseRead, PreparedDatasetRead
from app.services.artifacts import S3ArtifactStore
from app.services.datasets import prepare_yolo_dataset
from app.services.jobs import attach_celery_task, create_job
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


def _prepared_dataset_read(release_id: str, prepared: dict) -> PreparedDatasetRead:
    return PreparedDatasetRead(
        release_id=release_id,
        status=str(prepared.get("status") or "missing"),
        artifact_uri=prepared.get("artifact_uri"),
        download_url=prepared.get("download_url"),
        data_yaml=prepared.get("data_yaml") if isinstance(prepared.get("data_yaml"), dict) else None,
        manifest=prepared.get("manifest") if isinstance(prepared.get("manifest"), dict) else None,
    )
