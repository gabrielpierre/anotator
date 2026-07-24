from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import (
    annotation_revision_visible,
    require_annotation_access,
    require_task_access,
    review_decision_visible,
    track_revision_visible,
    visible_task_external_ids as scope_visible_task_external_ids,
)
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    Project,
    ProjectMember,
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
from app.services.annotations import (
    FRAME_ANNOTATION_PENDING,
    FRAME_APPROVED,
    FRAME_NEEDS_ANNOTATION,
    FRAME_REVIEW_PENDING,
    apply_review_decision,
    frame_active_annotation_count,
    frame_workflow_state,
    save_manual_annotations,
)
from app.services.cvat_client import CvatClient

router = APIRouter()


@router.get("/queue", response_model=list[ReviewQueueItem])
def review_queue(
    project_external_id: str | None = Query(default=None, max_length=64),
    state: str = Query(default="pending", pattern="^(pending|approved)$"),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[ReviewQueueItem]:
    task_external_ids = scope_visible_task_external_ids(db, user, project_external_id)
    if task_external_ids is not None and not task_external_ids:
        return []
    review_states = ["pending"] if state == "pending" else ["accepted", "corrected"]
    query = select(AnnotationRecord).where(
        AnnotationRecord.review_state.in_(review_states),
        AnnotationRecord.task_external_id.is_not(None),
        AnnotationRecord.frame.is_not(None),
    )
    if task_external_ids is not None:
        query = query.where(AnnotationRecord.task_external_id.in_(task_external_ids))
    candidates = list(db.scalars(query.order_by(AnnotationRecord.updated_at.desc()).limit(2000)).all())
    if state == "approved":
        annotations = _limit_queue_frames(_approved_frame_annotations(db, candidates), 500)
    else:
        annotations = _limit_queue_frames(_frame_queue_annotations(db, candidates), 500)
    return [_queue_item_from_annotation(db, annotation) for annotation in annotations]


@router.get("/queue/count")
def review_queue_count(
    project_external_id: str | None = Query(default=None, max_length=64),
    state: str = Query(default="pending", pattern="^(pending|approved)$"),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> dict[str, int]:
    task_external_ids = scope_visible_task_external_ids(db, user, project_external_id)
    if task_external_ids is not None and not task_external_ids:
        return {"pending": 0}
    review_states = ["pending"] if state == "pending" else ["accepted", "corrected"]
    query = select(AnnotationRecord).where(
        AnnotationRecord.review_state.in_(review_states),
        AnnotationRecord.task_external_id.is_not(None),
        AnnotationRecord.frame.is_not(None),
    )
    if task_external_ids is not None:
        query = query.where(AnnotationRecord.task_external_id.in_(task_external_ids))
    candidates = list(db.scalars(query).all())
    annotations = _approved_frame_annotations(db, candidates) if state == "approved" else _frame_queue_annotations(db, candidates)
    return {"pending": _queue_frame_count(annotations)}


@router.post("/decisions", response_model=ReviewDecisionRead)
def create_review_decision(
    payload: ReviewDecisionCreate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> ReviewDecision:
    require_annotation_access(db, user, payload.external_annotation_id)
    return apply_review_decision(db, CvatClient(get_settings()), payload)


@router.get("/decisions", response_model=list[ReviewDecisionRead])
def list_review_decisions(
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[ReviewDecision]:
    decisions = list(db.scalars(select(ReviewDecision).order_by(ReviewDecision.created_at.desc())).all())
    return [decision for decision in decisions if review_decision_visible(db, user, decision)]


@router.get("/annotations", response_model=list[AnnotationRecordRead])
def list_review_annotations(
    task_external_id: str | None = None,
    project_external_id: str | None = Query(default=None, max_length=64),
    frame: int | None = Query(default=None, ge=0),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[AnnotationRecord]:
    query = select(AnnotationRecord)
    if task_external_id:
        task = require_task_access(db, user, task_external_id)
        task_external_id = task.external_id
        query = query.where(AnnotationRecord.task_external_id == task_external_id)
    elif project_external_id:
        task_ids = scope_visible_task_external_ids(db, user, project_external_id)
        if not task_ids:
            return []
        query = query.where(AnnotationRecord.task_external_id.in_(task_ids))
    elif user.role != "admin":
        task_ids = scope_visible_task_external_ids(db, user)
        if not task_ids:
            return []
        query = query.where(AnnotationRecord.task_external_id.in_(task_ids))
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
    require_task_access(db, user, payload.task_external_id)
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
    user: User = Depends(current_user),
) -> list[AnnotationRevision]:
    revisions = list(db.scalars(select(AnnotationRevision).order_by(AnnotationRevision.created_at.desc())).all())
    return [revision for revision in revisions if annotation_revision_visible(db, user, revision.annotation_external_id)]


@router.get("/track-revisions", response_model=list[TrackRevisionRead])
def list_track_revisions(
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[TrackRevision]:
    revisions = list(db.scalars(select(TrackRevision).order_by(TrackRevision.created_at.desc())).all())
    return [revision for revision in revisions if track_revision_visible(db, user, revision.track_external_id)]


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
    state = frame_workflow_state(db, annotation.task_external_id, annotation.frame)
    frame_status = state.status if state else FRAME_REVIEW_PENDING
    frame_annotation_count = frame_active_annotation_count(db, annotation.task_external_id, annotation.frame)
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
            "queue_scope": "frame",
            "frame_review_state": frame_status,
            "frame_annotation_count": frame_annotation_count,
        },
    )


def _frame_queue_annotations(db: Session, candidates: list[AnnotationRecord]) -> list[AnnotationRecord]:
    frame_terminal_statuses = {
        FRAME_APPROVED,
        FRAME_NEEDS_ANNOTATION,
        FRAME_ANNOTATION_PENDING,
    }
    frames: set[tuple[str, int]] = set()
    annotations: list[AnnotationRecord] = []
    for annotation in candidates:
        if not _is_reviewable_annotation(annotation):
            continue
        key = (annotation.task_external_id, annotation.frame)
        if key not in frames:
            state = frame_workflow_state(db, annotation.task_external_id, annotation.frame)
            frame_status = state.status if state else FRAME_REVIEW_PENDING
            if frame_status in frame_terminal_statuses:
                continue
            frames.add(key)
        annotations.append(annotation)
    return _dedupe_queue_annotations(annotations)


def _approved_frame_annotations(db: Session, candidates: list[AnnotationRecord]) -> list[AnnotationRecord]:
    annotations: list[AnnotationRecord] = []
    for annotation in candidates:
        if not _is_reviewable_annotation(annotation):
            continue
        state = frame_workflow_state(db, annotation.task_external_id, annotation.frame)
        if state is None or state.status != FRAME_APPROVED:
            continue
        annotations.append(annotation)
    return _dedupe_queue_annotations(annotations)


def _dedupe_queue_annotations(candidates: list[AnnotationRecord]) -> list[AnnotationRecord]:
    by_identity: dict[tuple, AnnotationRecord] = {}
    order: list[tuple] = []
    for annotation in candidates:
        key = _annotation_identity_key(annotation)
        existing = by_identity.get(key)
        if existing is None:
            by_identity[key] = annotation
            order.append(key)
            continue
        if _annotation_queue_priority(annotation) > _annotation_queue_priority(existing):
            by_identity[key] = annotation
    return [by_identity[key] for key in order]


def _limit_queue_frames(annotations: list[AnnotationRecord], limit: int) -> list[AnnotationRecord]:
    frames: set[tuple[str | None, int | None]] = set()
    limited: list[AnnotationRecord] = []
    for annotation in annotations:
        key = (annotation.task_external_id, annotation.frame)
        if key not in frames:
            if len(frames) >= limit:
                break
            frames.add(key)
        limited.append(annotation)
    return limited


def _queue_frame_count(annotations: list[AnnotationRecord]) -> int:
    return len({(annotation.task_external_id, annotation.frame) for annotation in annotations})


def _annotation_identity_key(annotation: AnnotationRecord) -> tuple:
    points = tuple(round(float(value), 3) for value in _annotation_points(annotation))
    return (
        annotation.task_external_id,
        annotation.frame,
        (annotation.label_name or "").casefold(),
        (annotation.shape_type or "").casefold(),
        points,
    )


def _annotation_queue_priority(annotation: AnnotationRecord) -> int:
    priority = 0
    if annotation.external_id.startswith("cvat_job:"):
        priority += 20
    if annotation.source == "dataset_import":
        priority += 10
    if annotation.source == "cvat-plus":
        priority -= 1
    return priority


def _visible_task_external_ids(
    db: Session,
    user: User,
    project_external_id: str | None,
) -> list[str] | None:
    if project_external_id:
        require_project_access(db, user, project_external_id)
        return [
            task.external_id
            for task in db.scalars(select(Task).where(Task.project_external_id == project_external_id)).all()
        ]
    if user.role == "admin":
        return None
    project_external_ids = [
        project.external_id
        for project in db.scalars(
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user.id)
        ).all()
    ]
    if not project_external_ids:
        return []
    return [
        task.external_id
        for task in db.scalars(select(Task).where(Task.project_external_id.in_(project_external_ids))).all()
    ]


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
    require_annotation_access(db, user, annotations[0].external_id)
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
