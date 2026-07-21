import hashlib
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
    TaskDataMeta,
    TrackRevision,
)
from app.schemas import ManualAnnotationSave, ManualAnnotationShape, ReviewDecisionCreate
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
    before = dict(annotation.raw or {}) if annotation else {}
    after = dict(before)
    decision_value = _canonical_review_decision(payload.decision)
    action = _action_for_decision(decision_value)
    cvat_synced = False
    cvat_error: str | None = None

    if annotation is not None:
        if decision_value == "accepted":
            after["review_status"] = "accepted"
            after["release_ready"] = True
        elif decision_value == "needs_annotation":
            after["review_status"] = "needs_annotation"
            after["needs_annotation"] = True
            after["release_ready"] = False
        elif decision_value == "corrected":
            label_error = _apply_corrected_label(db, annotation, payload, after)
            if label_error:
                cvat_error = label_error
            _apply_review_geometry(db, annotation, payload.payload, after)
            after["review_status"] = "corrected"
            after["release_ready"] = True
        elif decision_value == "deleted_by_reviewer":
            after["review_status"] = "deleted_by_reviewer"
            after["deleted_by_reviewer"] = True
            after["release_ready"] = False

        annotation.review_state = decision_value
        annotation.raw = after
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
        decision=decision_value,
        cvat_job_id=payload.cvat_job_id or (annotation.cvat_job_id if annotation else None),
        corrected_label=payload.corrected_label,
        reason=payload.reason,
        actor=payload.actor,
        payload={
            **payload.payload,
            "annotation_type": payload.annotation_type or (annotation.annotation_type if annotation else None),
            "action": action,
            "review_state": decision_value,
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
            action=f"review_{decision_value}",
            target=payload.external_annotation_id,
            reason=payload.reason or cvat_error,
            confidence=payload.payload.get("confidence") if payload.payload else None,
            payload={
                **payload.payload,
                "cvat_synced": cvat_synced,
                "cvat_error": cvat_error,
                "action": action,
                "review_state": decision_value,
            },
        )
    )
    db.commit()
    db.refresh(decision)
    return decision


def save_manual_annotations(
    db: Session,
    client: CvatClient,
    payload: ManualAnnotationSave,
) -> list[AnnotationRecord]:
    task = db.scalar(select(Task).where(Task.external_id == payload.task_external_id))
    if task is None:
        raise ValueError("Task not found")

    frame_width, frame_height = _frame_dimensions(db, payload.task_external_id, payload.frame)
    job = _job_for_task(db, payload.task_external_id)
    cvat_job_id = normalize_cvat_job_id(job.external_id) if job and job.external_id else None
    local_job_id = cvat_job_id or f"local:{payload.task_external_id}"
    version = _cvat_annotation_version(client, cvat_job_id) if payload.sync_cvat and cvat_job_id else None

    previous = list(
        db.scalars(
            select(AnnotationRecord).where(
                AnnotationRecord.external_id.like(f"manual:{payload.task_external_id}:{payload.frame}:%")
            )
        ).all()
    )
    if not payload.shapes:
        if not payload.replace_existing:
            return previous

    for row in previous:
        db.delete(row)
    db.flush()

    records: list[AnnotationRecord] = []
    cvat_shapes: list[dict[str, Any]] = []
    missing_labels: set[str] = set()
    for index, shape in enumerate(payload.shapes):
        label_name = shape.label_name.strip()
        if not label_name:
            continue
        label_id = _label_id_for_name(db, label_name, payload.task_external_id)
        if label_id is None:
            _ensure_local_label(db, task, label_name)
            missing_labels.add(label_name)

        points = _absolute_points(shape, frame_width, frame_height)
        external_id = _manual_external_id(payload.task_external_id, payload.frame, shape.client_id or str(index))
        annotation_id = external_id.rsplit(":", 1)[-1]
        raw = {
            "id": annotation_id,
            "type": shape.shape_type,
            "frame": payload.frame,
            "label_id": label_id,
            "label_name": label_name,
            "source": "manual",
            "points": points,
            "attributes": [],
            "bbox_norm": shape.bbox_norm,
            "points_norm": shape.points,
            "coordinate_space": "image-normalized",
            "client_id": shape.client_id,
            "origin": "cvat-plus",
            "_cvat_version": version,
            "cvat_synced": False,
            "cvat_error": None,
        }
        record = AnnotationRecord(
            external_id=external_id,
            cvat_job_id=local_job_id,
            task_external_id=payload.task_external_id,
            annotation_type="shape",
            cvat_annotation_id=annotation_id,
            frame=payload.frame,
            label_id=label_id,
            label_name=label_name,
            shape_type=shape.shape_type,
            source="cvat-plus",
            confidence=1.0,
            points=points,
            review_state="pending",
            raw=raw,
        )
        db.add(record)
        records.append(record)

        if payload.sync_cvat and cvat_job_id and label_id is not None:
            cvat_shapes.append(
                {
                    "type": shape.shape_type,
                    "frame": payload.frame,
                    "label_id": label_id,
                    "points": points,
                    "source": "manual",
                    "attributes": [],
                }
            )

    cvat_synced = False
    cvat_error: str | None = None
    if payload.sync_cvat and cvat_job_id and cvat_shapes:
        try:
            body: dict[str, Any] = {"tags": [], "shapes": cvat_shapes, "tracks": []}
            if version is not None:
                body["version"] = version
            client.partial_update_job_annotations(cvat_job_id, "create", body)
            cvat_synced = True
        except Exception as exc:
            cvat_error = str(exc)
    elif missing_labels:
        cvat_error = f"Labels not found in CVAT: {', '.join(sorted(missing_labels))}"
    elif payload.sync_cvat and not cvat_job_id and records:
        cvat_error = "CVAT job not found for task"

    for record in records:
        record.raw = {
            **record.raw,
            "cvat_synced": cvat_synced and record.label_id is not None,
            "cvat_error": None if cvat_synced and record.label_id is not None else cvat_error,
        }
        db.add(record)

    db.add(
        AuditEvent(
            actor=payload.actor,
            action="manual_annotations_saved",
            target=payload.task_external_id,
            payload={
                "task_external_id": payload.task_external_id,
                "frame": payload.frame,
                "annotations": len(records),
                "cvat_synced": cvat_synced,
                "cvat_error": cvat_error,
            },
        )
    )
    db.commit()
    for record in records:
        db.refresh(record)
    return records


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


def _job_for_task(db: Session, task_external_id: str) -> JobRecord | None:
    return db.scalar(
        select(JobRecord)
        .where(JobRecord.kind == "cvat_job", JobRecord.task_external_id == task_external_id)
        .order_by(JobRecord.updated_at.desc())
    )


def _frame_dimensions(db: Session, task_external_id: str, frame: int) -> tuple[float, float]:
    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == task_external_id))
    frames = meta.frames if meta and isinstance(meta.frames, list) else []
    if 0 <= frame < len(frames) and isinstance(frames[frame], dict):
        width = _float_or_none(frames[frame].get("width"))
        height = _float_or_none(frames[frame].get("height"))
        if width and height:
            return width, height
    return 1.0, 1.0


def _absolute_points(shape: ManualAnnotationShape, frame_width: float, frame_height: float) -> list[float]:
    values = [_float_or_none(value) for value in shape.points]
    points = [value for value in values if value is not None]
    if not points:
        return []
    if any(value > 1 for value in points):
        return points
    return [
        round(value * (frame_width if index % 2 == 0 else frame_height), 3)
        for index, value in enumerate(points)
    ]


def _cvat_annotation_version(client: CvatClient, cvat_job_id: str | None) -> Any:
    if not cvat_job_id:
        return None
    try:
        annotations = client.retrieve_job_annotations(cvat_job_id)
        return annotations.get("version")
    except Exception:
        return None


def _manual_external_id(task_external_id: str, frame: int, client_id: str) -> str:
    raw = f"{task_external_id}:{frame}:{client_id}"
    digest = hashlib.sha1(raw.encode()).hexdigest()[:16]
    safe_client_id = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in client_id)[:36]
    return f"manual:{task_external_id}:{frame}:{safe_client_id or digest}-{digest}"


def _ensure_local_label(db: Session, task: Task, name: str) -> None:
    existing = db.scalar(
        select(CvatLabel).where(CvatLabel.task_external_id == task.external_id, CvatLabel.name == name)
    )
    if existing is None:
        digest = hashlib.sha1(f"{task.external_id}:{name}".encode()).hexdigest()[:16]
        label = CvatLabel(
            external_id=f"manual:{task.external_id}:label:{digest}",
            name=name,
            color="#4f8cff",
            task_external_id=task.external_id,
            raw={"origin": "cvat-plus", "manual": True},
        )
        db.add(label)

    labels = list(task.labels or [])
    if not any(isinstance(item, dict) and item.get("name") == name for item in labels):
        labels.append({"name": name, "color": "#4f8cff", "raw": {"origin": "cvat-plus", "manual": True}})
        task.labels = labels
        db.add(task)


def _canonical_review_decision(decision: str) -> str:
    if decision == "rejected":
        return "needs_annotation"
    return decision


def _apply_corrected_label(
    db: Session,
    annotation: AnnotationRecord,
    payload: ReviewDecisionCreate,
    after: dict[str, Any],
) -> str | None:
    if not payload.corrected_label:
        if annotation.label_id is not None:
            after["label_id"] = annotation.label_id
        return None

    label_id = payload.corrected_label_id or _label_id_for_name(
        db,
        payload.corrected_label,
        task_external_id=annotation.task_external_id,
    )
    if label_id is None:
        return "Corrected label id not found"

    after["label_id"] = label_id
    after["label_name"] = payload.corrected_label
    annotation.label_id = label_id
    annotation.label_name = payload.corrected_label
    return None


def _apply_review_geometry(
    db: Session,
    annotation: AnnotationRecord,
    review_payload: dict[str, Any],
    after: dict[str, Any],
) -> None:
    box = _box_from_payload(review_payload.get("local_box"))
    if box is None:
        return

    dimensions = _payload_frame_dimensions(review_payload.get("frame_dimensions"))
    if dimensions is None and annotation.task_external_id and annotation.frame is not None:
        dimensions = _frame_dimensions(db, annotation.task_external_id, annotation.frame)
        if dimensions == (1.0, 1.0):
            dimensions = None
    if dimensions is None:
        after["review_geometry_skipped"] = "missing_frame_dimensions"
        return

    width, height = dimensions
    x1 = clamp_float(box["x"] / 100 * width, 0, width)
    y1 = clamp_float(box["y"] / 100 * height, 0, height)
    x2 = clamp_float((box["x"] + box["w"]) / 100 * width, 0, width)
    y2 = clamp_float((box["y"] + box["h"]) / 100 * height, 0, height)
    if x2 <= x1 or y2 <= y1:
        after["review_geometry_skipped"] = "invalid_box"
        return

    shape_type = (after.get("type") or annotation.shape_type or "rectangle").lower()
    points = _points_from_box(x1, y1, x2, y2, shape_type)
    points_norm = _points_from_box(
        box["x"] / 100,
        box["y"] / 100,
        (box["x"] + box["w"]) / 100,
        (box["y"] + box["h"]) / 100,
        shape_type,
    )
    annotation.points = points
    after["points"] = points
    after["points_norm"] = points_norm
    after["bbox_norm"] = {
        "x": round(box["x"] / 100, 6),
        "y": round(box["y"] / 100, 6),
        "w": round(box["w"] / 100, 6),
        "h": round(box["h"] / 100, 6),
    }
    after["coordinate_space"] = "image-normalized"
    after["review_corrected_geometry"] = True


def _box_from_payload(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    parsed = {key: _float_or_none(value.get(key)) for key in ("x", "y", "w", "h")}
    if any(number is None for number in parsed.values()):
        return None
    box = {key: float(number) for key, number in parsed.items() if number is not None}
    if max(box.values()) <= 1:
        box = {key: number * 100 for key, number in box.items()}
    x = clamp_float(box["x"], 0, 100)
    y = clamp_float(box["y"], 0, 100)
    w = clamp_float(box["w"], 0, 100 - x)
    h = clamp_float(box["h"], 0, 100 - y)
    if w <= 0 or h <= 0:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def _payload_frame_dimensions(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, dict):
        return None
    width = _float_or_none(value.get("width"))
    height = _float_or_none(value.get("height"))
    if width and height and width > 0 and height > 0:
        return width, height
    return None


def _points_from_box(x1: float, y1: float, x2: float, y2: float, shape_type: str) -> list[float]:
    if shape_type == "polygon":
        return [round(value, 3) for value in (x1, y1, x2, y1, x2, y2, x1, y2)]
    return [round(value, 3) for value in (x1, y1, x2, y2)]


def _patch_cvat_annotation(
    client: CvatClient,
    annotation: AnnotationRecord,
    action: str,
    raw: dict[str, Any],
) -> None:
    patch_item = _cvat_patch_item(annotation, raw)
    version = annotation.raw.get("_cvat_version")
    body = {"version": version} if version is not None else {}
    body["tags"] = []
    body["shapes"] = []
    body["tracks"] = []
    body[_collection_for_annotation_type(annotation.annotation_type)] = [patch_item]
    client.partial_update_job_annotations(annotation.cvat_job_id, action, body)


def _cvat_patch_item(annotation: AnnotationRecord, raw: dict[str, Any]) -> dict[str, Any]:
    annotation_id = _int_or_none(annotation.cvat_annotation_id)
    if annotation_id is None:
        raise ValueError("CVAT annotation id unavailable for this local annotation")

    frame = _int_or_none(raw.get("frame")) if raw.get("frame") is not None else annotation.frame
    label_id = _int_or_none(raw.get("label_id")) if raw.get("label_id") is not None else annotation.label_id
    points = raw.get("points") if isinstance(raw.get("points"), list) else annotation.points
    shape_type = raw.get("type") or annotation.shape_type or "rectangle"

    missing = []
    if frame is None:
        missing.append("frame")
    if label_id is None:
        missing.append("label_id")
    if not points:
        missing.append("points")
    if missing:
        raise ValueError(f"CVAT patch missing required fields: {', '.join(missing)}")

    item: dict[str, Any] = {
        "id": annotation_id,
        "type": shape_type,
        "frame": frame,
        "label_id": label_id,
        "points": points,
    }
    attributes = raw.get("attributes")
    if isinstance(attributes, list):
        item["attributes"] = attributes
    for key in ("occluded", "outside", "z_order", "rotation", "group", "source"):
        if key in raw:
            item[key] = raw[key]
    return item


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
        "decision": str(after.get("review_status") or _canonical_review_decision(payload.decision)),
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
    if decision == "deleted_by_reviewer":
        return "delete"
    if decision == "corrected":
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


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
