import mimetypes
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.config import get_settings
from app.models import ArtifactRecord, User
from app.schemas import ArtifactPresignRead, ArtifactRead
from app.services.artifacts import (
    S3ArtifactStore,
    artifact_id_for_uri,
    proxy_download_url,
    uri_for_artifact_id,
)

router = APIRouter()


@router.get("/presign", response_model=ArtifactPresignRead)
def presign_artifact(
    artifact_id: str | None = None,
    uri: str | None = None,
    expires_in_seconds: int = Query(default=900, ge=60, le=86_400),
    _: User = Depends(current_user),
) -> ArtifactPresignRead:
    resolved_uri = _resolve_uri(artifact_id, uri)
    try:
        url = S3ArtifactStore(get_settings()).presign(resolved_uri, expires_in_seconds=expires_in_seconds)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Artifact not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ArtifactPresignRead(url=url, expires_in_seconds=expires_in_seconds)


@router.get("/{artifact_id}/download")
def download_artifact(
    artifact_id: str,
    inline: bool = Query(default=False),
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> Response:
    record = db.get(ArtifactRecord, artifact_id)
    if record is not None:
        uri = record.uri
        name = record.name
    else:
        try:
            uri = uri_for_artifact_id(artifact_id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid artifact id") from exc
        name = PurePosixPath(uri).name or "artifact"
    try:
        blob = S3ArtifactStore(get_settings()).get(uri)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Artifact not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    disposition = "inline" if inline else "attachment"
    media_type = blob.content_type
    if not media_type or media_type == "application/octet-stream":
        media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return Response(
        content=blob.content,
        media_type=media_type,
        headers={"Content-Disposition": f'{disposition}; filename="{name}"'},
    )


def artifact_read_from_uri(
    uri: str,
    *,
    name: str | None = None,
    kind: str = "artifact",
    content_type: str | None = None,
    size_bytes: int | None = None,
    owner_type: str | None = None,
    owner_id: str | None = None,
) -> ArtifactRead:
    artifact_id = artifact_id_for_uri(uri)
    return ArtifactRead(
        id=artifact_id,
        name=name or PurePosixPath(uri).name or artifact_id,
        kind=kind,
        content_type=content_type,
        size_bytes=size_bytes,
        download_url=proxy_download_url(uri),
        owner_type=owner_type,
        owner_id=owner_id,
    )


def persist_artifact_record(
    db: Session,
    *,
    uri: str,
    name: str | None = None,
    kind: str = "artifact",
    content_type: str | None = None,
    size_bytes: int | None = None,
    owner_type: str | None = None,
    owner_id: str | None = None,
) -> ArtifactRecord:
    record = db.scalar(select(ArtifactRecord).where(ArtifactRecord.uri == uri))
    if record is None:
        record = ArtifactRecord(
            uri=uri,
            name=name or PurePosixPath(uri).name or "artifact",
            kind=kind,
            content_type=content_type,
            size_bytes=size_bytes,
            owner_type=owner_type,
            owner_id=owner_id,
        )
    else:
        record.name = name or record.name
        record.kind = kind or record.kind
        record.content_type = content_type or record.content_type
        record.size_bytes = size_bytes if size_bytes is not None else record.size_bytes
        record.owner_type = owner_type or record.owner_type
        record.owner_id = owner_id or record.owner_id
    db.add(record)
    db.flush()
    return record


def _resolve_uri(artifact_id: str | None, uri: str | None) -> str:
    if uri:
        return uri
    if not artifact_id:
        raise HTTPException(status_code=400, detail="artifact_id or uri is required")
    return uri_for_artifact_id(artifact_id)
