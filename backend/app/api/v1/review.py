from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    JobRecord,
    ReviewDecision,
    Task,
    TrackRevision,
    User,
)
from app.schemas import (
    AnnotationRecordRead,
    AnnotationRevisionRead,
    ReviewDecisionCreate,
    ReviewDecisionRead,
    ReviewQueueItem,
    TrackActionPayload,
    TrackRevisionRead,
)
from app.services.annotations import apply_review_decision, normalize_cvat_job_id
from app.services.cvat_client import CvatClient

router = APIRouter()


@router.get("/queue", response_model=list[ReviewQueueItem])
def review_queue(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[ReviewQueueItem]:
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
    _: User = Depends(current_user),
) -> ReviewDecision:
    return apply_review_decision(db, CvatClient(get_settings()), payload)


@router.get("/decisions", response_model=list[ReviewDecisionRead])
def list_review_decisions(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[ReviewDecision]:
    return list(db.scalars(select(ReviewDecision).order_by(ReviewDecision.created_at.desc())).all())


@router.get("/annotations", response_model=list[AnnotationRecordRead])
def list_review_annotations(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[AnnotationRecord]:
    return list(db.scalars(select(AnnotationRecord).order_by(AnnotationRecord.updated_at.desc())).all())


@router.get("/annotation-revisions", response_model=list[AnnotationRevisionRead])
def list_annotation_revisions(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[AnnotationRevision]:
    return list(
        db.scalars(select(AnnotationRevision).order_by(AnnotationRevision.created_at.desc())).all()
    )


@router.get("/track-revisions", response_model=list[TrackRevisionRead])
def list_track_revisions(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[TrackRevision]:
    return list(db.scalars(select(TrackRevision).order_by(TrackRevision.created_at.desc())).all())


@router.post("/tracks/{track_id}/accept-segment", response_model=TrackRevisionRead)
def accept_track_segment(
    track_id: str,
    payload: TrackActionPayload,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrackRevision:
    return _apply_track_action(db, track_id, "accept_segment", payload, user)


@router.post("/tracks/{track_id}/correct-keyframe", response_model=TrackRevisionRead)
def correct_track_keyframe(
    track_id: str,
    payload: TrackActionPayload,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrackRevision:
    return _apply_track_action(db, track_id, "correct_keyframe", payload, user)


@router.post("/tracks/{track_id}/apply-label", response_model=TrackRevisionRead)
def apply_track_label(
    track_id: str,
    payload: TrackActionPayload,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrackRevision:
    return _apply_track_action(db, track_id, "apply_label", payload, user)


@router.post("/tracks/{track_id}/split", response_model=TrackRevisionRead)
def split_track(
    track_id: str,
    payload: TrackActionPayload,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrackRevision:
    return _apply_track_action(db, track_id, "split", payload, user)


@router.post("/tracks/{track_id}/close", response_model=TrackRevisionRead)
def close_track(
    track_id: str,
    payload: TrackActionPayload,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TrackRevision:
    return _apply_track_action(db, track_id, "close", payload, user)


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


def _apply_track_action(
    db: Session,
    track_id: str,
    action: str,
    payload: TrackActionPayload,
    user: User,
) -> TrackRevision:
    annotations = _track_annotations(db, track_id)
    before = [_annotation_snapshot(annotation) for annotation in annotations]
    if not annotations:
        raise HTTPException(status_code=404, detail="Track not found locally")
    for annotation in annotations:
        raw = dict(annotation.raw or {})
        if action == "accept_segment":
            annotation.review_state = "accepted"
        elif action == "apply_label":
            if payload.label_id is not None:
                annotation.label_id = payload.label_id
                raw["label_id"] = payload.label_id
            if payload.label_name:
                annotation.label_name = payload.label_name
        elif action == "correct_keyframe":
            if payload.frame is not None:
                annotation.frame = payload.frame
                raw["frame"] = payload.frame
            if payload.points:
                annotation.points = payload.points
                raw["points"] = payload.points
        elif action == "close":
            annotation.review_state = "accepted"
            raw["closed_by_review"] = True
        elif action == "split":
            raw["split_at_frame"] = payload.frame
            raw["split_requested"] = True
        annotation.raw = {**raw, "review_action": action}
        db.add(annotation)
    after = [_annotation_snapshot(annotation) for annotation in annotations]
    cvat_synced, cvat_error = _try_sync_track(action, annotations)
    revision = TrackRevision(
        track_external_id=track_id,
        cvat_job_id=annotations[0].cvat_job_id,
        decision=action,
        action=action,
        before={"annotations": before},
        after={"annotations": after, "payload": payload.model_dump(mode="json")},
        actor=payload.actor or user.email,
        cvat_synced=cvat_synced,
        cvat_error=cvat_error,
    )
    db.add(revision)
    db.add(
        AuditEvent(
            actor=user.email,
            action=f"track_{action}",
            target=track_id,
            reason=payload.reason or cvat_error,
            payload={"before": before, "after": after, "cvat_synced": cvat_synced},
        )
    )
    db.commit()
    db.refresh(revision)
    return revision


def _track_annotations(db: Session, track_id: str) -> list[AnnotationRecord]:
    return list(
        db.scalars(
            select(AnnotationRecord)
            .where(
                AnnotationRecord.annotation_type == "track",
                (AnnotationRecord.cvat_annotation_id == track_id) | (AnnotationRecord.external_id == track_id),
            )
            .order_by(AnnotationRecord.frame)
        ).all()
    )


def _annotation_snapshot(annotation: AnnotationRecord) -> dict:
    return {
        "external_id": annotation.external_id,
        "cvat_annotation_id": annotation.cvat_annotation_id,
        "frame": annotation.frame,
        "label_id": annotation.label_id,
        "label_name": annotation.label_name,
        "points": annotation.points,
        "review_state": annotation.review_state,
        "raw": annotation.raw,
    }


def _try_sync_track(action: str, annotations: list[AnnotationRecord]) -> tuple[bool, str | None]:
    if action in {"split", "close"}:
        return False, "Action recorded locally; CVAT track split/close requires manual reconciliation"
    first = annotations[0]
    try:
        raw = dict(first.raw or {})
        version = raw.get("_cvat_version")
        patch_item = {key: value for key, value in raw.items() if not key.startswith("_")}
        body = {"tags": [], "shapes": [], "tracks": [patch_item]}
        if version is not None:
            body["version"] = version
        CvatClient(get_settings()).partial_update_job_annotations(first.cvat_job_id, "update", body)
        return True, None
    except Exception as exc:
        return False, str(exc)
