from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.core.config import get_settings
from app.models import Task, TaskDataMeta
from app.schemas import TaskDataMetaRead, TaskRead
from app.services.cvat_client import CvatClient
from app.services.frame_previews import retrieve_annotation_frame_preview

router = APIRouter()


@router.get("", response_model=list[TaskRead])
def list_tasks(db: Session = Depends(db_session)) -> list[Task]:
    return list(db.scalars(select(Task).order_by(Task.updated_at.desc())).all())


@router.get("/{task_id}", response_model=TaskRead)
def get_task(task_id: str, db: Session = Depends(db_session)) -> Task:
    task = _resolve_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/data-meta", response_model=TaskDataMetaRead)
def get_task_data_meta(task_id: str, db: Session = Depends(db_session)) -> TaskDataMeta:
    task = _resolve_task(db, task_id)
    external_id = task.external_id if task else task_id
    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == external_id))
    if meta is None:
        raise HTTPException(status_code=404, detail="Task data meta not found")
    return meta


@router.get("/{task_id}/preview")
def get_task_preview(task_id: str, db: Session = Depends(db_session)) -> Response:
    task = _resolve_task(db, task_id)
    external_id = task.external_id if task else task_id
    client = CvatClient(get_settings())
    try:
        preview = client.retrieve_task_preview(external_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CVAT preview unavailable: {exc}") from exc
    return Response(content=preview.content, media_type=preview.content_type or "image/jpeg")


@router.get("/{task_id}/frame/{frame}")
def get_task_frame(
    task_id: str,
    frame: int,
    variant: str = Query(default="annotation", pattern="^(annotation|original)$"),
    max_side: int | None = Query(default=None, ge=256, le=8192),
    db: Session = Depends(db_session),
) -> Response:
    task = _resolve_task(db, task_id)
    external_id = task.external_id if task else task_id
    if frame < 0:
        raise HTTPException(status_code=400, detail="Frame must be greater than or equal to zero")
    if task and task.size and frame >= task.size:
        raise HTTPException(status_code=404, detail="Frame not found")

    settings = get_settings()
    client = CvatClient(settings)
    try:
        if variant == "original":
            image = client.retrieve_task_frame(external_id, frame, quality="original")
            return Response(
                content=image.content,
                media_type=image.content_type or "image/jpeg",
                headers={"Cache-Control": "private, max-age=3600"},
            )

        preview = retrieve_annotation_frame_preview(
            client=client,
            settings=settings,
            task_id=external_id,
            frame=frame,
            max_side=max_side,
        )
        return Response(
            content=preview.content,
            media_type=preview.content_type,
            headers={
                "Cache-Control": "private, max-age=86400",
                "X-Frame-Variant": "annotation",
                "X-Frame-Preview-Source": preview.source,
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CVAT frame unavailable: {exc}") from exc


def _resolve_task(db: Session, task_id: str) -> Task | None:
    return db.get(Task, task_id) or db.scalar(select(Task).where(Task.external_id == task_id))
