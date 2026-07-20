from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    CvatLabel,
    JobRecord,
    ReviewDecision,
    Task,
    TrackRevision,
)
from app.schemas import ReviewDecisionCreate
from app.services.cvat_client import CvatClient


@dataclass
class AnnotationSyncResult:
    annotations_synced: int = 0
    errors: list[str] | None = None


def normalize_cvat_job_id(value: str | None) -> str | None:
    if value is None:
        return None
    return value.removeprefix("cvat:")


def sync_job_annotations(
    db: Session,
    client: CvatClient,
    job: JobRecord,
) -> AnnotationSyncResult:
    job_id = normalize_cvat_job_id(job.external_id) or job.raw.get("id")
    if job_id is None:
        return AnnotationSyncResult(errors=["CVAT job id is missing"])

    annotations = client.retrieve_job_annotations(job_id)
    version = annotations.get("version")
    count = 0
    for annotation_type, collection_name in (
        ("tag", "tags"),
        ("shape", "shapes"),
        ("track", "tracks"),
    ):
        for index, raw in enumerate(annotations.get(collection_name) or []):
            count += _upsert_annotation_record(
                db,
                job=job,
                cvat_job_id=str(job_id),
                annotation_type=annotation_type,
                raw=raw,
                index=index,
                version=version,
            )
    return AnnotationSyncResult(annotations_synced=count, errors=[])


def apply_review_decision(
    db: Session,
    client: CvatClient,
    payload: ReviewDecisionCreate,
) -> ReviewDecision:
    annotation = db.scalar(
        select(AnnotationRecord).where(AnnotationRecord.external_id == payload.external_annotation_id)
    )
    before = annotation.raw if annotation else {}
    after = dict(before)
    action = _action_for_decision(payload.decision)
    cvat_synced = False
    cvat_error: str | None = None

    if annotation is not None:
        if payload.decision == "corrected":
            label_id = payload.corrected_label_id or _label_id_for_name(
                db,
                payload.corrected_label,
                task_external_id=annotation.task_external_id,
            )
            if label_id is None:
                cvat_error = "Corrected label id not found"
            else:
                after["label_id"] = label_id
                annotation.label_id = label_id
                annotation.label_name = payload.corrected_label or annotation.label_name
        elif payload.decision == "rejected":
            after = {"deleted": True, "raw": before}

        annotation.review_state = payload.decision
        db.add(annotation)

        if payload.patch_cvat and action and cvat_error is None:
            try:
                _patch_cvat_annotation(client, annotation, action, after)
                cvat_synced = True
            except Exception as exc:
                cvat_error = str(exc)
    else:
        cvat_error = "Annotation not found locally"

    decision = ReviewDecision(
        external_annotation_id=payload.external_annotation_id,
        decision=payload.decision,
        cvat_job_id=payload.cvat_job_id or (annotation.cvat_job_id if annotation else None),
        corrected_label=payload.corrected_label,
        reason=payload.reason,
        actor=payload.actor,
        payload={
            **payload.payload,
            "annotation_type": payload.annotation_type or (annotation.annotation_type if annotation else None),
            "action": action,
        },
        cvat_synced=cvat_synced,
        cvat_error=cvat_error,
    )
    db.add(decision)
    _add_revision(
        db,
        annotation=annotation,
        payload=payload,
        action=action or "none",
        before=before,
        after=after,
        cvat_synced=cvat_synced,
        cvat_error=cvat_error,
    )
    db.add(
        AuditEvent(
            actor=payload.actor,
            action=f"review_{payload.decision}",
            target=payload.external_annotation_id,
            reason=payload.reason or cvat_error,
            confidence=payload.payload.get("confidence") if payload.payload else None,
            payload={
                **payload.payload,
                "cvat_synced": cvat_synced,
                "cvat_error": cvat_error,
                "action": action,
            },
        )
    )
    db.commit()
    db.refresh(decision)
    return decision


def _upsert_annotation_record(
    db: Session,
    *,
    job: JobRecord,
    cvat_job_id: str,
    annotation_type: str,
    raw: dict[str, Any],
    index: int,
    version: Any,
) -> int:
    annotation_id = str(raw.get("id") or f"index-{index}")
    external_id = f"cvat_job:{cvat_job_id}:{annotation_type}:{annotation_id}"
    row = db.scalar(select(AnnotationRecord).where(AnnotationRecord.external_id == external_id))
    if row is None:
        row = AnnotationRecord(
            external_id=external_id,
            cvat_job_id=cvat_job_id,
            annotation_type=annotation_type,
            cvat_annotation_id=annotation_id,
        )
    label_id = _int_or_none(raw.get("label_id"))
    row.cvat_job_id = cvat_job_id
    row.task_external_id = job.task_external_id
    row.annotation_type = annotation_type
    row.cvat_annotation_id = annotation_id
    row.frame = _annotation_frame(raw, annotation_type)
    row.label_id = label_id
    row.label_name = _label_name_for_id(db, label_id, job.task_external_id)
    row.shape_type = _annotation_shape_type(raw, annotation_type)
    row.source = raw.get("source")
    row.confidence = _confidence(raw)
    row.points = _annotation_points(raw, annotation_type)
    row.raw = {**raw, "_cvat_version": version}
    db.add(row)
    return 1


def _patch_cvat_annotation(
    client: CvatClient,
    annotation: AnnotationRecord,
    action: str,
    raw: dict[str, Any],
) -> None:
    patch_item = {key: value for key, value in raw.items() if not key.startswith("_")}
    if action == "delete":
        patch_item = {"id": _int_or_none(annotation.cvat_annotation_id) or annotation.cvat_annotation_id}
    version = annotation.raw.get("_cvat_version")
    body = {"version": version} if version is not None else {}
    body["tags"] = []
    body["shapes"] = []
    body["tracks"] = []
    body[_collection_for_annotation_type(annotation.annotation_type)] = [patch_item]
    client.partial_update_job_annotations(annotation.cvat_job_id, action, body)


def _add_revision(
    db: Session,
    *,
    annotation: AnnotationRecord | None,
    payload: ReviewDecisionCreate,
    action: str,
    before: dict[str, Any],
    after: dict[str, Any],
    cvat_synced: bool,
    cvat_error: str | None,
) -> None:
    annotation_type = payload.annotation_type or (annotation.annotation_type if annotation else "shape")
    common = {
        "cvat_job_id": payload.cvat_job_id or (annotation.cvat_job_id if annotation else None),
        "decision": payload.decision,
        "action": action,
        "before": before,
        "after": after,
        "actor": payload.actor,
        "cvat_synced": cvat_synced,
        "cvat_error": cvat_error,
    }
    if annotation_type == "track":
        db.add(TrackRevision(track_external_id=payload.external_annotation_id, **common))
    else:
        db.add(AnnotationRevision(annotation_external_id=payload.external_annotation_id, **common))


def _action_for_decision(decision: str) -> str | None:
    if decision == "rejected":
        return "delete"
    if decision in {"accepted", "corrected"}:
        return "update"
    return None


def _collection_for_annotation_type(annotation_type: str) -> str:
    if annotation_type == "track":
        return "tracks"
    if annotation_type == "tag":
        return "tags"
    return "shapes"


def _label_name_for_id(db: Session, label_id: int | None, task_external_id: str | None) -> str | None:
    if label_id is None:
        return None
    labels = list(db.scalars(select(CvatLabel)).all())
    for label in labels:
        raw_id = _int_or_none(label.raw.get("id"))
        if raw_id == label_id and (label.task_external_id in {task_external_id, None}):
            return label.name
    for label in labels:
        if _int_or_none(label.raw.get("id")) == label_id:
            return label.name
    return None


def _label_id_for_name(db: Session, name: str | None, task_external_id: str | None) -> int | None:
    if not name:
        return None
    labels = list(db.scalars(select(CvatLabel).where(CvatLabel.name == name)).all())
    for label in labels:
        if label.task_external_id in {task_external_id, None}:
            return _int_or_none(label.raw.get("id"))
    if labels:
        return _int_or_none(labels[0].raw.get("id"))
    task = db.scalar(select(Task).where(Task.external_id == task_external_id))
    for raw in task.labels if task else []:
        if isinstance(raw, dict) and raw.get("name") == name:
            return _int_or_none(raw.get("raw", {}).get("id") or raw.get("id"))
    return None


def _annotation_frame(raw: dict[str, Any], annotation_type: str) -> int | None:
    if annotation_type == "track":
        shapes = raw.get("shapes") or []
        if shapes and isinstance(shapes[0], dict):
            return _int_or_none(shapes[0].get("frame"))
    return _int_or_none(raw.get("frame"))


def _annotation_shape_type(raw: dict[str, Any], annotation_type: str) -> str | None:
    if annotation_type == "track":
        shapes = raw.get("shapes") or []
        if shapes and isinstance(shapes[0], dict):
            return shapes[0].get("type") or raw.get("shape_type")
    return raw.get("type") or raw.get("shape_type")


def _annotation_points(raw: dict[str, Any], annotation_type: str) -> list[Any]:
    if annotation_type == "track":
        shapes = raw.get("shapes") or []
        if shapes and isinstance(shapes[0], dict):
            return shapes[0].get("points") or []
    return raw.get("points") or []


def _confidence(raw: dict[str, Any]) -> float | None:
    score = raw.get("score")
    if score is not None:
        return _float_or_none(score)
    for attr in raw.get("attributes") or []:
        if isinstance(attr, dict) and str(attr.get("name") or attr.get("spec_id")).lower() in {
            "confidence",
            "score",
        }:
            return _float_or_none(attr.get("value"))
    return None


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
