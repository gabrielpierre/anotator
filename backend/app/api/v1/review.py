from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    ReviewDecision,
    Task,
    TaskDataMeta,
    TrackRevision,
    User,
)
from app.schemas import (
    AnnotationRecordRead,
    AnnotationRevisionRead,
    ManualAnnotationSave,
    ReviewDecisionCreate,
    ReviewDecisionRead,
    ReviewQueueItem,
    TrackActionPayload,
    TrackRevisionRead,
)
from app.services.annotations import apply_review_decision, save_manual_annotations
from app.services.cvat_client import CvatClient

router = APIRouter()


@router.get("/queue", response_model=list[ReviewQueueItem])
def review_queue(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[ReviewQueueItem]:
    candidates = list(
        db.scalars(
            select(AnnotationRecord)
            .where(
                AnnotationRecord.review_state == "pending",
                AnnotationRecord.task_external_id.is_not(None),
                AnnotationRecord.frame.is_not(None),
            )
            .order_by(AnnotationRecord.updated_at.desc())
            .limit(2000)
        ).all()
    )
    annotations = [annotation for annotation in candidates if _is_reviewable_annotation(annotation)][:500]
    return [_queue_item_from_annotation(db, annotation) for annotation in annotations]


@router.get("/queue/count")
def review_queue_count(
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> dict[str, int]:
    candidates = list(
        db.scalars(
            select(AnnotationRecord).where(
                AnnotationRecord.review_state == "pending",
                AnnotationRecord.task_external_id.is_not(None),
                AnnotationRecord.frame.is_not(None),
            )
        ).all()
    )
    return {"pending": sum(1 for annotation in candidates if _is_reviewable_annotation(annotation))}


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
    task_external_id: str | None = None,
    frame: int | None = Query(default=None, ge=0),
    db: Session = Depends(db_session),
    _: User = Depends(current_user),
) -> list[AnnotationRecord]:
    query = select(AnnotationRecord)
    if task_external_id:
        query = query.where(AnnotationRecord.task_external_id == task_external_id)
    if frame is not None:
        query = query.where(AnnotationRecord.frame == frame)
    return list(db.scalars(query.order_by(AnnotationRecord.updated_at.desc())).all())


@router.put("/annotations/manual", response_model=list[AnnotationRecordRead])
def save_review_manual_annotations(
    payload: ManualAnnotationSave,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[AnnotationRecord]:
    actor = payload.actor if payload.actor != "local-user" else user.email
    try:
        return save_manual_annotations(
            db,
            CvatClient(get_settings()),
            payload.model_copy(update={"actor": actor}),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


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
    preview_url = task.preview_url if task else None
    if annotation.task_external_id and annotation.frame is not None:
        preview_url = f"/api/v1/tasks/{annotation.task_external_id}/frame/{annotation.frame}"
    return ReviewQueueItem(
        external_annotation_id=annotation.external_id,
        cvat_job_id=annotation.cvat_job_id,
        task_external_id=annotation.task_external_id,
        task_name=task.name if task else None,
        preview_url=preview_url,
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
            "frame_dimensions": _frame_dimensions(db, annotation.task_external_id, annotation.frame),
        },
    )


def _is_reviewable_annotation(annotation: AnnotationRecord) -> bool:
    if annotation.annotation_type == "tag":
        return False
    if annotation.frame is None or not annotation.task_external_id:
        return False
    if (annotation.shape_type or "").lower() not in {"rectangle", "polygon"}:
        return False
    points = _annotation_points(annotation)
    return len(points) >= 4 and all(isinstance(value, int | float) for value in points)


def _annotation_points(annotation: AnnotationRecord) -> list:
    points = annotation.points if isinstance(annotation.points, list) else []
    if points:
        return points
    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    points_norm = raw.get("points_norm")
    return points_norm if isinstance(points_norm, list) else []


def _frame_dimensions(db: Session, task_external_id: str | None, frame: int | None) -> dict[str, int] | None:
    if task_external_id is None or frame is None:
        return None
    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == task_external_id))
    frames = meta.frames if meta and isinstance(meta.frames, list) else []
    if 0 <= frame < len(frames) and isinstance(frames[frame], dict):
        width = _positive_int(frames[frame].get("width"))
        height = _positive_int(frames[frame].get("height"))
        if width and height:
            return {"width": width, "height": height}
    return None


def _positive_int(value: object) -> int | None:
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


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
