import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AnnotationRecord, AuditEvent, CvatLabel, InferenceSuggestion, Task, utcnow
from app.schemas import InferenceRunCreate
from app.services.annotations import (
    _cvat_annotation_version,
    _ensure_local_label,
    _frame_dimensions,
    _job_for_task,
    _label_id_for_name,
    normalize_cvat_job_id,
)
from app.services.cvat_client import CvatClient


@dataclass
class ModelPrediction:
    label_name: str | None
    score: float | None
    shape_type: str
    points: list[float]
    raw: dict[str, Any]


PredictionRunner = Callable[[Any, InferenceRunCreate], list[ModelPrediction]]
ProgressCallback = Callable[[float, str | None], None]


def run_inference(
    db: Session,
    *,
    payload: InferenceRunCreate,
    settings: Settings,
    client: CvatClient,
    predictor: PredictionRunner | None = None,
    progress_callback: ProgressCallback | None = None,
) -> list[InferenceSuggestion]:
    task = db.scalar(select(Task).where(Task.external_id == payload.task_external_id))
    if task is None:
        raise ValueError(f"Task {payload.task_external_id} is not synchronized locally")
    if payload.apply_mode == "replace" and not payload.confirm_replace:
        raise ValueError("Replacing model suggestions requires confirm_replace=true")

    frame_end = payload.frame_end if payload.frame_end is not None else payload.frame_start
    if frame_end < payload.frame_start:
        raise ValueError("frame_end must be greater than or equal to frame_start")
    if task.size and frame_end >= task.size:
        frame_end = task.size - 1

    frames = list(range(payload.frame_start, frame_end + 1))
    if payload.apply_mode == "replace":
        _replace_existing_suggestions(db, payload, frames)

    label_ids = _task_label_ids(db, payload.task_external_id)
    runner = predictor or ultralytics_predict
    suggestions: list[InferenceSuggestion] = []
    total_frames = max(len(frames), 1)
    timestamp = utcnow().isoformat()

    for index, frame in enumerate(frames, start=1):
        _report(progress_callback, 5 + (index - 1) / total_frames * 80, f"Loading frame {frame}.")
        image = _load_task_image(client, payload.task_external_id, frame)
        predictions = runner(image, payload)
        _report(progress_callback, 10 + index / total_frames * 80, f"Predicted frame {frame}.")
        for pred_index, prediction in enumerate(predictions):
            if prediction.score is not None and prediction.score < payload.threshold:
                continue
            if payload.classes and prediction.label_name not in payload.classes:
                continue
            suggestion = _prediction_to_suggestion(
                payload=payload,
                prediction=prediction,
                frame=frame,
                prediction_index=pred_index,
                timestamp=timestamp,
                label_id=label_ids.get(prediction.label_name or ""),
            )
            existing = db.scalar(select(InferenceSuggestion).where(InferenceSuggestion.external_id == suggestion.external_id))
            if existing is not None:
                suggestions.append(existing)
                continue
            db.add(suggestion)
            suggestions.append(suggestion)

    db.flush()
    accepted_annotations = 0
    cvat_synced = False
    cvat_error: str | None = None
    if payload.write_to_cvat:
        accepted_annotations, cvat_synced, cvat_error = _materialize_accepted_suggestions(
            db,
            client=client,
            task=task,
            payload=payload,
            suggestions=suggestions,
        )

    db.add(
        AuditEvent(
            actor=payload.user_id,
            action="inference_suggestions_created",
            target=payload.task_external_id,
            payload={
                "task_external_id": payload.task_external_id,
                "model_id": payload.model_id,
                "model_version": payload.model_version,
                "model_family": payload.model_family,
                "frame_start": payload.frame_start,
                "frame_end": frame_end,
                "created": len(suggestions),
                "accepted_annotations": accepted_annotations,
                "apply_mode": payload.apply_mode,
                "write_to_cvat": payload.write_to_cvat,
                "cvat_synced": cvat_synced,
                "cvat_error": cvat_error,
            },
        )
    )
    db.commit()
    for suggestion in suggestions:
        db.refresh(suggestion)
    _report(progress_callback, 98, f"Stored {len(suggestions)} suggestions.")
    return suggestions


def _materialize_accepted_suggestions(
    db: Session,
    *,
    client: CvatClient,
    task: Task,
    payload: InferenceRunCreate,
    suggestions: list[InferenceSuggestion],
) -> tuple[int, bool, str | None]:
    if not suggestions:
        return 0, False, None

    job = _job_for_task(db, payload.task_external_id)
    cvat_job_id = (
        normalize_cvat_job_id(payload.cvat_job_id)
        or (normalize_cvat_job_id(job.external_id) if job and job.external_id else None)
    )
    local_job_id = cvat_job_id or f"local:{payload.task_external_id}"
    version = _cvat_annotation_version(client, cvat_job_id) if cvat_job_id else None

    records: list[AnnotationRecord] = []
    cvat_shapes: list[dict[str, Any]] = []
    missing_labels: set[str] = set()
    for suggestion in suggestions:
        suggestion.status = "accepted"
        if suggestion.shape_type not in {"rectangle", "polygon"}:
            suggestion.raw = {**(suggestion.raw or {}), "accepted_directly": False, "skip_reason": "unsupported_shape"}
            db.add(suggestion)
            continue

        label_name = (suggestion.label_name or "").strip()
        if not label_name:
            suggestion.raw = {**(suggestion.raw or {}), "accepted_directly": False, "skip_reason": "missing_label"}
            db.add(suggestion)
            continue

        label_id = suggestion.label_id or _label_id_for_name(db, label_name, payload.task_external_id)
        if label_id is None:
            _ensure_local_label(db, task, label_name, None)
            db.flush()
            label_id = _label_id_for_name(db, label_name, payload.task_external_id)
        if label_id is None:
            missing_labels.add(label_name)

        points = _absolute_suggestion_points(db, suggestion, payload.task_external_id)
        if not points:
            suggestion.raw = {**(suggestion.raw or {}), "accepted_directly": False, "skip_reason": "missing_points"}
            db.add(suggestion)
            continue

        external_id = _accepted_annotation_external_id(payload.task_external_id, suggestion)
        existing = db.scalar(select(AnnotationRecord).where(AnnotationRecord.external_id == external_id))
        record_already_existed = existing is not None
        annotation_id = external_id.rsplit(":", 1)[-1]
        raw = {
            "id": annotation_id,
            "type": suggestion.shape_type,
            "frame": suggestion.frame,
            "label_id": label_id,
            "label_name": label_name,
            "source": "auto",
            "points": points,
            "attributes": [],
            "bbox_norm": _suggestion_bbox_norm(suggestion),
            "points_norm": _suggestion_points_norm(suggestion),
            "coordinate_space": "image-absolute",
            "origin": "autoannotation",
            "model_id": payload.model_id,
            "model_version": payload.model_version,
            "model_family": payload.model_family,
            "confidence": suggestion.score,
            "_cvat_version": version,
            "cvat_synced": False,
            "cvat_error": None,
            "suggestion_id": suggestion.id,
        }

        if existing is None:
            record = AnnotationRecord(
                external_id=external_id,
                cvat_job_id=local_job_id,
                task_external_id=payload.task_external_id,
                annotation_type="shape",
                cvat_annotation_id=annotation_id,
                frame=suggestion.frame,
                label_id=label_id,
                label_name=label_name,
                shape_type=suggestion.shape_type,
                source="auto",
                confidence=suggestion.score,
                points=points,
                review_state="pending",
                raw=raw,
            )
        else:
            record = existing
            record.cvat_job_id = local_job_id
            record.task_external_id = payload.task_external_id
            record.annotation_type = "shape"
            record.cvat_annotation_id = annotation_id
            record.frame = suggestion.frame
            record.label_id = label_id
            record.label_name = label_name
            record.shape_type = suggestion.shape_type
            record.source = "auto"
            record.confidence = suggestion.score
            record.points = points
            record.review_state = "pending"
            record.raw = raw

        db.add(record)
        records.append(record)
        suggestion.raw = {**(suggestion.raw or {}), "accepted_directly": True, "annotation_external_id": external_id}
        db.add(suggestion)

        if cvat_job_id and label_id is not None and not record_already_existed:
            cvat_shapes.append(
                {
                    "type": suggestion.shape_type,
                    "frame": suggestion.frame,
                    "label_id": label_id,
                    "points": points,
                    "source": "auto",
                    "attributes": [],
                }
            )

    db.flush()
    cvat_synced = False
    cvat_error: str | None = None
    if cvat_job_id and cvat_shapes:
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
    elif records and not cvat_job_id:
        cvat_error = "CVAT job not found for task"

    for record in records:
        record.raw = {
            **(record.raw or {}),
            "cvat_synced": cvat_synced and record.label_id is not None,
            "cvat_error": None if cvat_synced and record.label_id is not None else cvat_error,
        }
        db.add(record)

    for suggestion in suggestions:
        suggestion.raw = {
            **(suggestion.raw or {}),
            "cvat_written": cvat_synced,
            "cvat_error": None if cvat_synced else cvat_error,
        }
        db.add(suggestion)

    return len(records), cvat_synced, cvat_error


def _accepted_annotation_external_id(task_external_id: str, suggestion: InferenceSuggestion) -> str:
    digest = hashlib.sha1(suggestion.external_id.encode()).hexdigest()[:16]
    return f"auto:{task_external_id}:{suggestion.frame}:{digest}"


def _absolute_suggestion_points(
    db: Session,
    suggestion: InferenceSuggestion,
    task_external_id: str,
) -> list[float]:
    points = [float(value) for value in (suggestion.points or []) if _is_number(value)]
    if not points:
        return []
    if any(value > 1 for value in points):
        return [round(value, 3) for value in points]
    frame_width, frame_height = _frame_dimensions(db, task_external_id, suggestion.frame)
    return [
        round(value * (frame_width if index % 2 == 0 else frame_height), 3)
        for index, value in enumerate(points)
    ]


def _suggestion_bbox_norm(suggestion: InferenceSuggestion) -> dict[str, float] | None:
    raw = suggestion.raw if isinstance(suggestion.raw, dict) else {}
    bbox = raw.get("bbox_norm")
    if isinstance(bbox, dict):
        parsed = {key: _float_or_none(bbox.get(key)) for key in ("x", "y", "w", "h")}
        if all(value is not None for value in parsed.values()):
            return {key: float(value) for key, value in parsed.items() if value is not None}
    points_norm = _suggestion_points_norm(suggestion)
    if len(points_norm) < 4:
        return None
    xs = points_norm[0::2]
    ys = points_norm[1::2]
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)
    return {"x": x1, "y": y1, "w": max(0.0, x2 - x1), "h": max(0.0, y2 - y1)}


def _suggestion_points_norm(suggestion: InferenceSuggestion) -> list[float]:
    raw = suggestion.raw if isinstance(suggestion.raw, dict) else {}
    polygon = raw.get("polygon_norm")
    if isinstance(polygon, list):
        flattened: list[float] = []
        for point in polygon:
            if isinstance(point, list | tuple) and len(point) >= 2:
                x = _float_or_none(point[0])
                y = _float_or_none(point[1])
                if x is not None and y is not None:
                    flattened.extend([x, y])
        if flattened:
            return flattened
    bbox = raw.get("bbox_norm")
    if isinstance(bbox, dict):
        x = _float_or_none(bbox.get("x"))
        y = _float_or_none(bbox.get("y"))
        w = _float_or_none(bbox.get("w"))
        h = _float_or_none(bbox.get("h"))
        if x is not None and y is not None and w is not None and h is not None:
            return [x, y, x + w, y + h]
    points = [float(value) for value in (suggestion.points or []) if _is_number(value)]
    if points and all(0 <= value <= 1 for value in points):
        return points
    return []


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_number(value: Any) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def ultralytics_predict(image: Any, payload: InferenceRunCreate) -> list[ModelPrediction]:
    from ultralytics import YOLO

    model = YOLO(payload.base_model)
    kwargs = {"conf": payload.threshold, "iou": payload.nms_iou, "verbose": False}
    if payload.model_family == "tracking":
        results = model.track(source=image, persist=True, **kwargs)
    else:
        results = model.predict(source=image, **kwargs)
    result = results[0]
    width, height = image.size
    names = getattr(result, "names", {}) or {}

    if payload.model_family == "classification" and getattr(result, "probs", None) is not None:
        probs = result.probs
        top1 = int(probs.top1)
        label_name = str(names.get(top1, top1))
        score = float(probs.top1conf)
        return [
            ModelPrediction(
                label_name=label_name,
                score=score,
                shape_type="tag",
                points=[],
                raw={"task": "classification", "class_index": top1},
            )
        ]

    predictions: list[ModelPrediction] = []
    boxes = getattr(result, "boxes", None)
    masks = getattr(result, "masks", None)
    if boxes is None:
        return predictions

    xyxy_rows = _tensor_rows(boxes.xyxy)
    cls_rows = _flat_tensor(boxes.cls)
    conf_rows = _flat_tensor(boxes.conf)
    mask_rows = getattr(masks, "xyn", None) if masks is not None else None

    for index, xyxy in enumerate(xyxy_rows):
        cls_index = int(cls_rows[index]) if index < len(cls_rows) else -1
        label_name = str(names.get(cls_index, cls_index))
        score = float(conf_rows[index]) if index < len(conf_rows) else None
        if payload.model_family == "segmentation" and mask_rows is not None and index < len(mask_rows):
            normalized_polygon = [[float(x), float(y)] for x, y in mask_rows[index]]
            points = [value for point in normalized_polygon for value in (point[0] * width, point[1] * height)]
            raw = {"polygon_norm": normalized_polygon, "class_index": cls_index}
            predictions.append(ModelPrediction(label_name, score, "polygon", points, raw))
            continue

        x1, y1, x2, y2 = [float(value) for value in xyxy]
        raw = {
            "bbox_norm": {
                "x": x1 / width,
                "y": y1 / height,
                "w": max(0.0, (x2 - x1) / width),
                "h": max(0.0, (y2 - y1) / height),
            },
            "class_index": cls_index,
        }
        predictions.append(ModelPrediction(label_name, score, "rectangle", [x1, y1, x2, y2], raw))

    return predictions


def _prediction_to_suggestion(
    *,
    payload: InferenceRunCreate,
    prediction: ModelPrediction,
    frame: int,
    prediction_index: int,
    timestamp: str,
    label_id: int | None,
) -> InferenceSuggestion:
    external_id = _suggestion_external_id(payload, frame, prediction_index, timestamp)
    origin = {
        "model_id": payload.model_id,
        "model_version": payload.model_version,
        "model_family": payload.model_family,
        "base_model": payload.base_model,
        "threshold_used": payload.threshold,
        "nms_iou": payload.nms_iou,
        "score": prediction.score,
        "user_id": payload.user_id,
        "timestamp": timestamp,
        "apply_mode": payload.apply_mode,
        "write_to_cvat": payload.write_to_cvat,
    }
    return InferenceSuggestion(
        external_id=external_id,
        task_external_id=payload.task_external_id,
        cvat_job_id=payload.cvat_job_id,
        frame=frame,
        model_id=payload.model_id,
        model_version=payload.model_version,
        model_family=payload.model_family,
        label_id=label_id,
        label_name=prediction.label_name,
        score=prediction.score,
        threshold=payload.threshold,
        nms_iou=payload.nms_iou,
        shape_type=prediction.shape_type,
        points=prediction.points,
        status="proposed" if not payload.write_to_cvat else "accepted",
        origin=origin,
        raw=prediction.raw,
    )


def _suggestion_external_id(
    payload: InferenceRunCreate,
    frame: int,
    prediction_index: int,
    timestamp: str,
) -> str:
    raw = ":".join(
        [
            payload.task_external_id,
            str(frame),
            payload.model_id,
            payload.model_version,
            payload.model_family,
            payload.dedupe_key or timestamp,
            str(prediction_index),
        ]
    )
    digest = hashlib.sha1(raw.encode()).hexdigest()[:24]
    return f"inference:{payload.task_external_id}:{frame}:{digest}"


def _replace_existing_suggestions(db: Session, payload: InferenceRunCreate, frames: list[int]) -> None:
    db.execute(
        delete(InferenceSuggestion).where(
            InferenceSuggestion.task_external_id == payload.task_external_id,
            InferenceSuggestion.model_id == payload.model_id,
            InferenceSuggestion.model_version == payload.model_version,
            InferenceSuggestion.frame.in_(frames),
            InferenceSuggestion.status == "proposed",
        )
    )
    db.add(
        AuditEvent(
            actor=payload.user_id,
            action="inference_suggestions_replaced",
            target=payload.task_external_id,
            payload={
                "task_external_id": payload.task_external_id,
                "model_id": payload.model_id,
                "model_version": payload.model_version,
                "frames": frames,
            },
        )
    )
    db.commit()


def _load_task_image(client: CvatClient, task_external_id: str, frame: int) -> Any:
    from PIL import Image

    try:
        response = client.retrieve_task_frame(task_external_id, frame)
    except Exception:
        response = client.retrieve_task_preview(task_external_id)
    return Image.open(BytesIO(response.content)).convert("RGB")


def _task_label_ids(db: Session, task_external_id: str) -> dict[str, int]:
    labels = db.scalars(select(CvatLabel).where(CvatLabel.task_external_id == task_external_id)).all()
    mapped: dict[str, int] = {}
    for label in labels:
        raw_id = label.raw.get("id") if isinstance(label.raw, dict) else None
        try:
            mapped[label.name] = int(raw_id)
        except (TypeError, ValueError):
            continue
    return mapped


def _append_suggestions_to_cvat(client: CvatClient, cvat_job_id: str, suggestions: list[InferenceSuggestion]) -> None:
    annotations = client.retrieve_job_annotations(cvat_job_id)
    shapes = []
    for suggestion in suggestions:
        if suggestion.shape_type not in {"rectangle", "polygon"} or suggestion.label_id is None:
            continue
        shapes.append(
            {
                "type": suggestion.shape_type,
                "frame": suggestion.frame,
                "label_id": suggestion.label_id,
                "points": suggestion.points,
                "source": "auto",
            }
        )
    if not shapes:
        return
    client.partial_update_job_annotations(
        cvat_job_id,
        "create",
        {"version": annotations.get("version", 0), "tags": [], "shapes": shapes, "tracks": []},
    )


def _report(callback: ProgressCallback | None, progress: float, detail: str) -> None:
    if callback is not None:
        callback(progress, detail)


def _tensor_rows(value: Any) -> list[list[float]]:
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "tolist"):
        value = value.tolist()
    return value or []


def _flat_tensor(value: Any) -> list[float]:
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "tolist"):
        value = value.tolist()
    return value or []
