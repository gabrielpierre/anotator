from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AuditEvent, CvatLabel, InferenceSuggestion, Task, utcnow
from app.schemas import InferenceRunCreate
from app.services.cvat_client import CvatBinaryResponse, CvatClient


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
            db.add(suggestion)
            suggestions.append(suggestion)

    db.flush()
    if payload.write_to_cvat and payload.cvat_job_id:
        _append_suggestions_to_cvat(client, payload.cvat_job_id, suggestions)
        for suggestion in suggestions:
            suggestion.status = "accepted"
            suggestion.raw = {**(suggestion.raw or {}), "cvat_written": True}
            db.add(suggestion)

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
                "apply_mode": payload.apply_mode,
                "write_to_cvat": payload.write_to_cvat,
            },
        )
    )
    db.commit()
    for suggestion in suggestions:
        db.refresh(suggestion)
    _report(progress_callback, 98, f"Stored {len(suggestions)} suggestions.")
    return suggestions


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
    external_id = (
        f"inference:{payload.task_external_id}:{frame}:"
        f"{payload.model_id}:{payload.model_version}:{timestamp}:{prediction_index}"
    )
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
