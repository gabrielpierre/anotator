import hashlib
import html
import json
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import (
    AnnotationRecord,
    AuditEvent,
    DatasetRelease,
    DerivedAsset,
    PipelineDefinition,
    PipelineRun,
)
from app.services.artifacts import ArtifactStore

ProgressCallback = Callable[[float, str | None], None]

DEFAULT_PIPELINE_GRAPH = {
    "type": "detection-to-classification",
    "steps": ["detect", "filter", "crop", "classification", "review", "release"],
}
DEFAULT_SPLITS = {"train": 0.8, "val": 0.1, "test": 0.1}


def run_pipeline(
    db: Session,
    *,
    run_id: str,
    settings: Settings,
    artifact_store: ArtifactStore,
    progress_callback: ProgressCallback | None = None,
) -> PipelineRun:
    run = db.get(PipelineRun, run_id)
    if run is None:
        raise ValueError(f"PipelineRun {run_id} not found")

    definition = _pipeline_definition(db, run)
    run.definition = definition
    run.status = "running"
    run.progress = 5
    run.lineage = {**(run.lineage or {}), "current_step": "detect", "completed_steps": []}
    db.add(run)
    db.commit()
    _report(progress_callback, 5, "Pipeline started.")

    task_external_ids = _source_task_ids(db, definition)
    annotations = _source_annotations(db, task_external_ids)
    max_assets = _max_assets(definition)
    selected = annotations[:max_assets]
    _update_run(db, run, 18, "filter", ["detect"], {"candidate_annotations": len(annotations), "selected": len(selected)})
    _report(progress_callback, 18, f"Selected {len(selected)} annotations.")

    splits = _splits(definition)
    padding = _padding(definition)
    source_release = _source_release(db, definition)
    target_release = _create_target_release(db, run, definition, selected, source_release)
    run.lineage = {**(run.lineage or {}), "derived_release_id": target_release.id}
    db.add(run)
    db.commit()
    _report(progress_callback, 28, f"Created derived release {target_release.name}.")

    assets: list[DerivedAsset] = []
    total = max(len(selected), 1)
    for index, annotation in enumerate(selected, start=1):
        split = _split_for_annotation(annotation, splits)
        asset = _asset_from_annotation(
            annotation=annotation,
            run=run,
            release=target_release,
            split=split,
            padding=padding,
            definition=definition,
        )
        asset.crop_uri = artifact_store.put_bytes(
            f"derived-datasets/{target_release.id}/previews/{asset.external_id}.svg",
            _preview_svg(asset).encode("utf-8"),
            "image/svg+xml",
        )
        asset.preview_url = asset.crop_uri
        db.add(asset)
        assets.append(asset)
        if index == len(selected) or index % 25 == 0:
            progress = 28 + (index / total) * 42
            _report(progress_callback, progress, f"Materialized {index}/{len(selected)} crops.")

    db.flush()
    manifest = _manifest(run, target_release, definition, assets, source_release, settings)
    manifest_uri = artifact_store.put_bytes(
        f"derived-datasets/{target_release.id}/manifest.json",
        json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        "application/json",
    )
    for asset in assets:
        asset.lineage = {**(asset.lineage or {}), "manifest_uri": manifest_uri}
        db.add(asset)

    target_release.artifact_uri = manifest_uri
    target_release.status = "ready"
    target_release.snapshot = {
        **(target_release.snapshot or {}),
        **manifest,
        "artifacts": [{"name": "manifest.json", "uri": manifest_uri, "content_type": "application/json"}],
    }
    db.add(target_release)
    _update_run(
        db,
        run,
        85,
        "review",
        ["detect", "filter", "crop", "classification"],
        {"derived_asset_count": len(assets), "derived_release_id": target_release.id},
    )
    _report(progress_callback, 85, "Derived manifest stored.")

    run.status = "succeeded"
    run.progress = 100
    run.lineage = {
        **(run.lineage or {}),
        "current_step": "release",
        "completed_steps": definition.get("steps", DEFAULT_PIPELINE_GRAPH["steps"]),
        "derived_release_id": target_release.id,
        "derived_asset_count": len(assets),
        "manifest_uri": manifest_uri,
    }
    db.add(run)
    db.add(
        AuditEvent(
            actor="system",
            action="pipeline_run_completed",
            target=run.id,
            payload={
                "pipeline_run_id": run.id,
                "derived_release_id": target_release.id,
                "derived_asset_count": len(assets),
                "manifest_uri": manifest_uri,
                "source_release_id": source_release.id if source_release else None,
            },
        )
    )
    db.commit()
    db.refresh(run)
    _report(progress_callback, 100, "Pipeline completed.")
    return run


def _pipeline_definition(db: Session, run: PipelineRun) -> dict[str, Any]:
    raw_definition = run.definition or {}
    definition_id = raw_definition.get("definition_id") or (run.lineage or {}).get("definition_id")
    stored = db.get(PipelineDefinition, str(definition_id)) if definition_id else None
    graph = stored.graph if stored is not None else {}
    config = stored.config if stored is not None else {}
    merged = {
        **DEFAULT_PIPELINE_GRAPH,
        **graph,
        **config,
        **raw_definition,
    }
    steps = merged.get("steps")
    if not isinstance(steps, list) or not steps:
        merged["steps"] = DEFAULT_PIPELINE_GRAPH["steps"]
    if stored is not None:
        merged["definition_id"] = stored.id
        merged["definition_name"] = stored.name
        merged["definition_version"] = stored.version
    return merged


def _source_task_ids(db: Session, definition: dict[str, Any]) -> list[str]:
    task_ids = definition.get("task_external_ids")
    if isinstance(task_ids, list) and task_ids:
        return [str(task_id) for task_id in task_ids]
    release = _source_release(db, definition)
    if release is not None:
        return [str(task_id) for task_id in release.task_external_ids or []]
    return []


def _source_release(db: Session, definition: dict[str, Any]) -> DatasetRelease | None:
    release_id = definition.get("source_release_id")
    if not release_id:
        return None
    return db.get(DatasetRelease, str(release_id))


def _source_annotations(db: Session, task_external_ids: list[str]) -> list[AnnotationRecord]:
    query = select(AnnotationRecord).where(AnnotationRecord.review_state != "rejected")
    if task_external_ids:
        query = query.where(AnnotationRecord.task_external_id.in_(task_external_ids))
    return list(db.scalars(query.order_by(AnnotationRecord.task_external_id, AnnotationRecord.frame)).all())


def _max_assets(definition: dict[str, Any]) -> int:
    policy = definition.get("sample_policy") if isinstance(definition.get("sample_policy"), dict) else {}
    raw = policy.get("max_assets", definition.get("max_assets", 500))
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 500


def _splits(definition: dict[str, Any]) -> dict[str, float]:
    raw = definition.get("splits") if isinstance(definition.get("splits"), dict) else DEFAULT_SPLITS
    train = _ratio(raw.get("train"), DEFAULT_SPLITS["train"])
    val = _ratio(raw.get("val"), DEFAULT_SPLITS["val"])
    test = _ratio(raw.get("test"), DEFAULT_SPLITS["test"])
    total = train + val + test
    if total <= 0:
        return DEFAULT_SPLITS
    return {"train": train / total, "val": val / total, "test": test / total}


def _ratio(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed / 100 if parsed > 1 else parsed


def _padding(definition: dict[str, Any]) -> dict[str, Any]:
    raw = definition.get("padding") if isinstance(definition.get("padding"), dict) else {}
    return {
        "mode": str(raw.get("mode", "relative")),
        "value": _ratio(raw.get("value", raw.get("ratio", 0.08)), 0.08),
    }


def _create_target_release(
    db: Session,
    run: PipelineRun,
    definition: dict[str, Any],
    annotations: list[AnnotationRecord],
    source_release: DatasetRelease | None,
) -> DatasetRelease:
    base_name = str(definition.get("target_release_name") or f"derived_cls_{run.id[:8]}")
    name = _unique_release_name(db, base_name)
    task_external_ids = sorted({str(annotation.task_external_id) for annotation in annotations if annotation.task_external_id})
    release = DatasetRelease(
        name=name,
        status="building",
        task_external_ids=task_external_ids,
        immutable=True,
        snapshot={
            "source": "derived_pipeline",
            "pipeline_run_id": run.id,
            "source_release_id": source_release.id if source_release else definition.get("source_release_id"),
            "source_release_name": source_release.name if source_release else None,
            "definition": definition,
            "mutable_source_blocked": True,
            "derived_type": "classification_crops",
        },
    )
    db.add(release)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="derived_dataset_release_queued",
            target=release.id,
            payload={"pipeline_run_id": run.id, "source_release_id": source_release.id if source_release else None},
        )
    )
    db.commit()
    db.refresh(release)
    return release


def _unique_release_name(db: Session, base_name: str) -> str:
    existing = db.scalar(select(DatasetRelease).where(DatasetRelease.name == base_name))
    if existing is None:
        return base_name
    for index in range(2, 1000):
        candidate = f"{base_name}_{index}"
        if db.scalar(select(DatasetRelease).where(DatasetRelease.name == candidate)) is None:
            return candidate
    return f"{base_name}_{hashlib.sha1(base_name.encode('utf-8')).hexdigest()[:8]}"


def _asset_from_annotation(
    *,
    annotation: AnnotationRecord,
    run: PipelineRun,
    release: DatasetRelease,
    split: str,
    padding: dict[str, Any],
    definition: dict[str, Any],
) -> DerivedAsset:
    bbox = _bbox(annotation.points)
    track_id = _track_id(annotation)
    model = definition.get("model") if isinstance(definition.get("model"), dict) else {}
    corrections = _human_corrections(annotation)
    return DerivedAsset(
        external_id=f"derived:{run.id}:{annotation.external_id}",
        pipeline_run_id=run.id,
        dataset_release_id=release.id,
        source_task_external_id=annotation.task_external_id,
        source_annotation_id=annotation.external_id,
        source_track_id=track_id,
        frame=annotation.frame,
        label_id=annotation.label_id,
        label_name=annotation.label_name,
        split=split,
        bbox=bbox,
        padding=padding,
        model_id=str(model.get("id")) if model.get("id") else annotation.source,
        model_version=str(model.get("version")) if model.get("version") else None,
        score=annotation.confidence,
        human_corrections=corrections,
        lineage={
            "source": "annotation_record",
            "annotation_type": annotation.annotation_type,
            "cvat_annotation_id": annotation.cvat_annotation_id,
            "task_external_id": annotation.task_external_id,
            "frame": annotation.frame,
            "track_split_group": _split_group(annotation),
            "pipeline_run_id": run.id,
        },
        status="ready",
    )


def _bbox(points: list[Any]) -> dict[str, float]:
    values = [_float(value) for value in points]
    values = [value for value in values if value is not None]
    if len(values) >= 4:
        xs = values[0::2]
        ys = values[1::2]
        return {
            "x": min(xs),
            "y": min(ys),
            "width": max(xs) - min(xs),
            "height": max(ys) - min(ys),
        }
    return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _track_id(annotation: AnnotationRecord) -> str | None:
    if annotation.annotation_type == "track":
        return annotation.cvat_annotation_id
    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    for key in ("track_id", "track", "parent_track_id"):
        if raw.get(key) is not None:
            return str(raw[key])
    return None


def _split_group(annotation: AnnotationRecord) -> str:
    track_id = _track_id(annotation)
    if track_id:
        return f"track:{annotation.task_external_id}:{track_id}"
    return f"image:{annotation.task_external_id}:{annotation.frame}:{annotation.external_id}"


def _split_for_annotation(annotation: AnnotationRecord, splits: dict[str, float]) -> str:
    group = _split_group(annotation)
    bucket = int(hashlib.sha1(group.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    if bucket < splits["train"]:
        return "train"
    if bucket < splits["train"] + splits["val"]:
        return "val"
    return "test"


def _human_corrections(annotation: AnnotationRecord) -> dict[str, Any]:
    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    return {
        "review_state": annotation.review_state,
        "label_name": annotation.label_name,
        "corrected": bool(raw.get("review_decision") == "corrected" or raw.get("human_corrected")),
    }


def _preview_svg(asset: DerivedAsset) -> str:
    label = html.escape(asset.label_name or "object")
    split = html.escape(asset.split)
    score = "" if asset.score is None else f"{asset.score:.2f}"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="224" height="160" viewBox="0 0 224 160">
  <rect width="224" height="160" fill="#f5f7fb"/>
  <rect x="18" y="24" width="188" height="102" rx="8" fill="#ffffff" stroke="#3b82f6" stroke-width="3"/>
  <text x="24" y="146" fill="#111827" font-family="Arial, sans-serif" font-size="14" font-weight="700">{label}</text>
  <text x="172" y="146" fill="#64748b" font-family="Arial, sans-serif" font-size="12" text-anchor="end">{split}</text>
  <text x="24" y="44" fill="#64748b" font-family="Arial, sans-serif" font-size="11">{score}</text>
</svg>
"""


def _manifest(
    run: PipelineRun,
    release: DatasetRelease,
    definition: dict[str, Any],
    assets: list[DerivedAsset],
    source_release: DatasetRelease | None,
    settings: Settings,
) -> dict[str, Any]:
    by_split: dict[str, int] = {}
    by_class: dict[str, int] = {}
    for asset in assets:
        by_split[asset.split] = by_split.get(asset.split, 0) + 1
        label = asset.label_name or "unknown"
        by_class[label] = by_class.get(label, 0) + 1
    return {
        "source": "derived_pipeline",
        "pipeline_run_id": run.id,
        "dataset_release_id": release.id,
        "source_release_id": source_release.id if source_release else definition.get("source_release_id"),
        "definition": definition,
        "counts": {
            "derived_assets": len(assets),
            "classes": len(by_class),
            "tracks": len({asset.source_track_id for asset in assets if asset.source_track_id}),
        },
        "splits": by_split,
        "classes": by_class,
        "lineage_policy": {
            "track_split_lock": True,
            "crop_padding": definition.get("padding", {"mode": "relative", "value": 0.08}),
            "artifact_bucket": settings.s3_bucket,
        },
        "assets": [
            {
                "id": asset.id,
                "external_id": asset.external_id,
                "split": asset.split,
                "label_name": asset.label_name,
                "source_task_external_id": asset.source_task_external_id,
                "source_annotation_id": asset.source_annotation_id,
                "source_track_id": asset.source_track_id,
                "frame": asset.frame,
                "crop_uri": asset.crop_uri,
                "bbox": asset.bbox,
            }
            for asset in assets
        ],
    }


def _update_run(
    db: Session,
    run: PipelineRun,
    progress: float,
    current_step: str,
    completed_steps: list[str],
    extra_lineage: dict[str, Any] | None = None,
) -> None:
    run.progress = progress
    run.lineage = {
        **(run.lineage or {}),
        "current_step": current_step,
        "completed_steps": completed_steps,
        **(extra_lineage or {}),
    }
    db.add(run)
    db.commit()
    db.refresh(run)


def derived_asset_counts(db: Session) -> dict[str, int]:
    total = db.scalar(select(func.count(DerivedAsset.id))) or 0
    ready = db.scalar(select(func.count(DerivedAsset.id)).where(DerivedAsset.status == "ready")) or 0
    return {"total": total, "ready": ready}


def _report(callback: ProgressCallback | None, progress: float, detail: str) -> None:
    if callback is not None:
        callback(progress, detail)
