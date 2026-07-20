from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    JobRecord,
    ReviewDecision,
    Task,
    TrackRevision,
)
from app.schemas import (
    AnnotationRecordRead,
    AnnotationRevisionRead,
    ReviewDecisionCreate,
    ReviewDecisionRead,
    ReviewQueueItem,
    TrackRevisionRead,
)
from app.services.annotations import apply_review_decision, normalize_cvat_job_id
from app.services.cvat_client import CvatClient

router = APIRouter()


@router.get("/queue", response_model=list[ReviewQueueItem])
def review_queue(db: Session = Depends(db_session)) -> list[ReviewQueueItem]:
    annotations = list(
        db.scalars(
            select(AnnotationRecord)
            .where(AnnotationRecord.review_state.notin_(["accepted", "rejected"]))
            .order_by(AnnotationRecord.updated_at.desc())
            .limit(500)
        ).all()
    )
    if annotations:
        return [_queue_item_from_annotation(db, annotation) for annotation in annotations]

    jobs = list(
        db.scalars(
            select(JobRecord)
            .where(JobRecord.kind == "cvat_job")
            .order_by(JobRecord.updated_at.desc())
            .limit(200)
        ).all()
    )
    items: list[ReviewQueueItem] = []
    for job in jobs:
        task = None
        if job.task_external_id:
            task = db.scalar(select(Task).where(Task.external_id == job.task_external_id))
        label = None
        labels = task.labels if task else []
        if labels and isinstance(labels[0], dict):
            label = labels[0].get("name")
        items.append(
            ReviewQueueItem(
                external_annotation_id=None,
                cvat_job_id=normalize_cvat_job_id(job.external_id),
                task_external_id=job.task_external_id,
                task_name=task.name if task else None,
                preview_url=task.preview_url if task else None,
                status=job.status,
                annotation_type=None,
                label=label,
                confidence=None,
                origin="CVAT job",
                payload={
                    "job_id": job.id,
                    "job_name": job.name,
                    "job_status": job.status,
                    "task_external_id": job.task_external_id,
                },
            )
        )
    return items


@router.post("/decisions", response_model=ReviewDecisionRead)
def create_review_decision(
    payload: ReviewDecisionCreate,
    db: Session = Depends(db_session),
) -> ReviewDecision:
    return apply_review_decision(db, CvatClient(get_settings()), payload)


@router.get("/decisions", response_model=list[ReviewDecisionRead])
def list_review_decisions(db: Session = Depends(db_session)) -> list[ReviewDecision]:
    return list(db.scalars(select(ReviewDecision).order_by(ReviewDecision.created_at.desc())).all())


@router.get("/annotations", response_model=list[AnnotationRecordRead])
def list_review_annotations(db: Session = Depends(db_session)) -> list[AnnotationRecord]:
    return list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.updated_at.desc())).all())


@router.get("/annotation-revisions", response_model=list[AnnotationRevisionRead])
def list_annotation_revisions(db: Session = Depends(db_session)) -> list[AnnotationRevision]:
    return list(
        db.scalars(select(AnnotationRevision).order_by(AnnotationRevision.created_at.desc())).all()
    )


@router.get("/track-revisions", response_model=list[TrackRevisionRead])
def list_track_revisions(db: Session = Depends(db_session)) -> list[TrackRevision]:
    return list(db.scalars(select(TrackRevision).order_by(TrackRevision.created_at.desc())).all())


def _queue_item_from_annotation(db: Session, annotation: AnnotationRecord) -> ReviewQueueItem:
    task = None
    if annotation.task_external_id:
        task = db.scalar(select(Task).where(Task.external_id == annotation.task_external_id))
    return ReviewQueueItem(
        external_annotation_id=annotation.external_id,
        cvat_job_id=annotation.cvat_job_id,
        task_external_id=annotation.task_external_id,
        task_name=task.name if task else None,
        preview_url=task.preview_url if task else None,
        status=annotation.review_state,
        annotation_type=annotation.annotation_type,  # type: ignore[arg-type]
        cvat_annotation_id=annotation.cvat_annotation_id,
        frame=annotation.frame,
        shape_type=annotation.shape_type,
        points=annotation.points,
        review_state=annotation.review_state,
        label=annotation.label_name,
        label_id=annotation.label_id,
        confidence=annotation.confidence,
        origin=annotation.source or "CVAT",
        payload={
            "annotation_id": annotation.id,
            "external_annotation_id": annotation.external_id,
            "raw": annotation.raw,
        },
    )
