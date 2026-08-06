import hashlib
import io
import json
import zipfile
from collections import Counter
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from xml.etree import ElementTree

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnnotationRecord, AuditEvent, DatasetRelease
from app.services.artifacts import ArtifactStore, proxy_download_url

DEFAULT_SPLITS = {"train": 0.8, "val": 0.1, "test": 0.1}
DEFAULT_SPLIT_POLICY = {
    "strategy": "class_balanced_best_effort",
    "seed": 42,
    "min_per_class_train": 1,
    "min_per_class_val": 1,
    "test_required": False,
    "rare_class_threshold": 5,
    "preserve_groups": False,
}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
EXCLUDED_REVIEW_STATES = {"deleted_by_reviewer", "rejected", "incorrect", "needs_annotation", "replaced_by_manual"}


def prepare_yolo_dataset(
    db: Session,
    *,
    release_id: str,
    artifact_store: ArtifactStore,
    split_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise ValueError(f"DatasetRelease {release_id} not found")
    if release.status != "ready" or not release.artifact_uri:
        raise ValueError("YOLO preparation requires a ready DatasetRelease with artifacts")

    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    plan = _build_yolo_dataset_plan(db, release, artifact_store, split_config=split_config)

    with TemporaryDirectory(prefix="anotator-yolo-") as tmpdir:
        root = Path(tmpdir)
        dataset_dir = root / "dataset"
        for split in ("train", "val", "test"):
            (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
            (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

        class_index = {name: index for index, name in enumerate(plan["class_names"])}
        for source_image in plan["source_images"]:
            stable_key = str(source_image["stable_key"])
            split = plan["assignments"][stable_key]
            safe_stem = _safe_stem(stable_key)
            image_target = dataset_dir / "images" / split / f"{safe_stem}{source_image['extension']}"
            label_target = dataset_dir / "labels" / split / f"{safe_stem}.txt"
            image_target.write_bytes(source_image["image_bytes"])

            labels = _source_image_label_lines(source_image, class_index)
            label_target.write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")

        data_yaml_dict = plan["data_yaml"]
        (dataset_dir / "data.yaml").write_text(_data_yaml(data_yaml_dict), encoding="utf-8")
        manifest = plan["manifest"]
        (dataset_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        output = root / "prepared-yolo.zip"
        _zip_directory(dataset_dir, output)
        key = f"prepared-datasets/{release.id}/yolo/prepared-yolo-{plan['split_policy']['digest']}.zip"
        uri = artifact_store.put_bytes(key, output.read_bytes(), "application/zip")

    prepared = {
        "status": "ready",
        "artifact_uri": uri,
        "download_url": proxy_download_url(uri),
        "data_yaml": data_yaml_dict,
        "manifest": manifest,
    }
    release.snapshot = {**snapshot, "prepared_dataset": prepared}
    db.add(release)
    db.add(
        AuditEvent(
            actor="system",
            action="dataset_yolo_prepared",
            target=release.id,
            payload={
                "release_id": release.id,
                "artifact_uri": uri,
                "images": len(plan["manifest"]["images"]),
                "classes": plan["class_names"],
                "health": plan["manifest"]["health"],
            },
        )
    )
    db.commit()
    db.refresh(release)
    return prepared


def preview_yolo_dataset(
    db: Session,
    *,
    release_id: str,
    artifact_store: ArtifactStore,
    split_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise ValueError(f"DatasetRelease {release_id} not found")
    if release.status != "ready" or not release.artifact_uri:
        raise ValueError("YOLO preview requires a ready DatasetRelease with artifacts")

    plan = _build_yolo_dataset_plan(db, release, artifact_store, split_config=split_config)
    return {
        "status": "ready",
        "artifact_uri": None,
        "download_url": None,
        "data_yaml": plan["data_yaml"],
        "manifest": plan["manifest"],
    }


class CvatImage:
    def __init__(self, name: str, width: int, height: int, frame: int, boxes: list["CvatBox"], tags: list[str]):
        self.name = name
        self.width = width
        self.height = height
        self.frame = frame
        self.boxes = boxes
        self.tags = tags


class CvatBox:
    def __init__(
        self,
        label: str,
        xtl: float,
        ytl: float,
        xbr: float,
        ybr: float,
        *,
        shape_type: str = "rectangle",
        source: str = "cvat_export",
    ):
        self.label = label
        self.xtl = xtl
        self.ytl = ytl
        self.xbr = xbr
        self.ybr = ybr
        self.shape_type = shape_type
        self.source = source


class CvatZip:
    def __init__(self, class_names: list[str], images: list[CvatImage], files: dict[str, bytes]):
        self.class_names = class_names
        self.images = images
        self.files = files


def _build_yolo_dataset_plan(
    db: Session,
    release: DatasetRelease,
    artifact_store: ArtifactStore,
    *,
    split_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    artifacts = _release_artifacts(release)
    split_policy = _split_policy(split_config if split_config is not None else snapshot.get("splits"))

    class_names = _snapshot_class_names(snapshot)
    source_images: list[dict[str, Any]] = []
    local_annotations = _local_annotations_by_frame(db, _release_task_external_ids(release, artifacts))
    box_stats = _empty_box_stats()

    for artifact in artifacts:
        uri = str(artifact["uri"])
        task_external_id = str(artifact.get("task_external_id") or "")
        blob = artifact_store.get(uri)
        extracted = _read_cvat_zip(blob.content)
        for name in extracted.class_names:
            if name not in class_names:
                class_names.append(name)
        for item in extracted.images:
            image_member = _find_image_member(extracted.files, item.name)
            if image_member is None:
                box_stats["excluded_images_missing_file"] += 1
                continue
            extension = Path(image_member).suffix.lower() or ".jpg"
            stable_key = f"{artifact.get('task_external_id', 'task')}:{item.name}:{len(source_images)}"
            boxes = _canonical_boxes_for_image(
                task_external_id=task_external_id,
                frame=item.frame,
                xml_boxes=item.boxes,
                local_annotations=local_annotations.get((task_external_id, item.frame), []),
                width=item.width,
                height=item.height,
                box_stats=box_stats,
            )
            for box in boxes:
                if box.label not in class_names:
                    class_names.append(box.label)
            labels = _classification_labels_for_image(
                xml_tags=item.tags,
                local_annotations=local_annotations.get((task_external_id, item.frame), []),
            )
            for label in labels:
                if label not in class_names:
                    class_names.append(label)
            source_images.append(
                {
                    "stable_key": stable_key,
                    "group_key": _group_key_for_image(task_external_id, item.name, split_policy),
                    "name": item.name,
                    "image_bytes": extracted.files[image_member],
                    "extension": extension,
                    "width": item.width,
                    "height": item.height,
                    "frame": item.frame,
                    "boxes": boxes,
                    "labels": labels,
                    "source_artifact_uri": uri,
                }
            )

    if not source_images:
        raise ValueError("No images with annotations were found in release artifacts")
    if not class_names:
        class_names.append("object")

    assignments = _split_assignments(source_images, split_policy)
    class_index = {name: index for index, name in enumerate(class_names)}
    manifest_images = _manifest_images(source_images, assignments, class_index)
    split_counts = _count_splits(manifest_images)
    val_path = "images/val" if split_counts["val"] else "images/train"
    test_path = "images/test" if split_counts["test"] else val_path
    data_yaml_dict = {
        "path": ".",
        "train": "images/train",
        "val": val_path,
        "test": test_path,
        "names": {index: name for index, name in enumerate(class_names)},
    }
    box_stats["exported_boxes"] = sum(int(image.get("boxes") or 0) for image in manifest_images)
    class_distribution = _class_distribution(source_images, assignments, class_names)
    health = _dataset_health(
        class_distribution=class_distribution,
        manifest_images=manifest_images,
        box_stats=box_stats,
        split_policy=split_policy,
        snapshot=snapshot,
    )
    manifest = {
        "format": "yolo",
        "release_id": release.id,
        "release_name": release.name,
        "splits": split_counts,
        "split_policy": split_policy,
        "classes": class_names,
        "class_distribution": class_distribution,
        "box_stats": box_stats,
        "health": health,
        "images": manifest_images,
        "source_artifacts": artifacts,
    }
    return {
        "source_images": source_images,
        "class_names": class_names,
        "assignments": assignments,
        "split_policy": split_policy,
        "data_yaml": data_yaml_dict,
        "manifest": manifest,
    }


def _read_cvat_zip(content: bytes) -> CvatZip:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
        xml_name = next((name for name in files if name.lower().endswith(".xml")), None)
        if xml_name is None:
            raise ValueError("CVAT export ZIP does not contain annotations XML")
        root = ElementTree.fromstring(files[xml_name])
        class_names = [
            (label.findtext("name") or "").strip()
            for label in root.findall(".//meta/task/labels/label")
            if (label.findtext("name") or "").strip()
        ]
        images = []
        for index, image in enumerate(root.findall(".//image")):
            name = str(image.attrib.get("name") or "").strip()
            if not name:
                continue
            frame = _int(image.attrib.get("id"))
            width = _int(image.attrib.get("width")) or _image_dimension(files, name, 0)
            height = _int(image.attrib.get("height")) or _image_dimension(files, name, 1)
            boxes = _boxes_for_image(image)
            images.append(
                CvatImage(
                    name=name,
                    width=width,
                    height=height,
                    frame=frame if frame is not None else index,
                    boxes=boxes,
                    tags=_tags_for_image(image),
                )
            )
        return CvatZip(class_names=class_names, images=images, files=files)


def _boxes_for_image(image) -> list[CvatBox]:
    boxes = []
    for box in image.findall("box"):
        label = str(box.attrib.get("label") or "object")
        xtl = _float(box.attrib.get("xtl")) or 0
        ytl = _float(box.attrib.get("ytl")) or 0
        xbr = _float(box.attrib.get("xbr")) or xtl
        ybr = _float(box.attrib.get("ybr")) or ytl
        boxes.append(CvatBox(label, xtl, ytl, xbr, ybr, shape_type="rectangle", source="cvat_export"))
    for polygon in image.findall("polygon"):
        label = str(polygon.attrib.get("label") or "object")
        points = _polygon_points(str(polygon.attrib.get("points") or ""))
        if points:
            xs = points[0::2]
            ys = points[1::2]
            boxes.append(CvatBox(label, min(xs), min(ys), max(xs), max(ys), shape_type="polygon", source="cvat_export"))
    return boxes


def _tags_for_image(image) -> list[str]:
    labels = []
    seen = set()
    for tag in image.findall("tag"):
        label = str(tag.attrib.get("label") or "").strip()
        key = label.casefold()
        if label and key not in seen:
            labels.append(label)
            seen.add(key)
    return labels


def _yolo_label_line(class_id: int, box: CvatBox, width: int, height: int) -> str:
    width = max(width, 1)
    height = max(height, 1)
    x_center = ((box.xtl + box.xbr) / 2) / width
    y_center = ((box.ytl + box.ybr) / 2) / height
    box_width = (box.xbr - box.xtl) / width
    box_height = (box.ybr - box.ytl) / height
    values = [_clamp(x_center), _clamp(y_center), _clamp(box_width), _clamp(box_height)]
    return f"{class_id} " + " ".join(f"{value:.6f}" for value in values)


def _source_image_label_lines(source_image: dict[str, Any], class_index: dict[str, int]) -> list[str]:
    return [
        _yolo_label_line(
            class_index[box.label],
            box,
            int(source_image["width"]),
            int(source_image["height"]),
        )
        for box in source_image["boxes"]
    ]


def _manifest_images(
    source_images: list[dict[str, Any]],
    assignments: dict[str, str],
    class_index: dict[str, int],
) -> list[dict[str, Any]]:
    rows = []
    for source_image in source_images:
        stable_key = str(source_image["stable_key"])
        split = assignments[stable_key]
        safe_stem = _safe_stem(stable_key)
        box_counts = Counter(box.label for box in source_image["boxes"])
        class_counts = _source_image_class_counts(source_image)
        rows.append(
            {
                "name": source_image["name"],
                "split": split,
                "image": f"images/{split}/{safe_stem}{source_image['extension']}",
                "label": f"labels/{split}/{safe_stem}.txt",
                "width": source_image["width"],
                "height": source_image["height"],
                "frame": source_image["frame"],
                "boxes": sum(box_counts.values()),
                "annotations": sum(class_counts.values()),
                "image_labels": sorted(set(source_image.get("labels", []))),
                "classes": sorted(class_counts),
                "class_counts": dict(sorted(class_counts.items())),
                "class_ids": sorted(class_index[label] for label in class_counts if label in class_index),
                "source_artifact_uri": source_image["source_artifact_uri"],
                "group_key": source_image.get("group_key"),
            }
        )
    return rows


def _empty_box_stats() -> dict[str, int]:
    return {
        "xml_boxes_read": 0,
        "local_boxes_read": 0,
        "boxes_read": 0,
        "duplicate_boxes_removed": 0,
        "excluded_boxes": 0,
        "exported_boxes": 0,
        "excluded_images_missing_file": 0,
    }


def _canonical_boxes_for_image(
    *,
    task_external_id: str,
    frame: int,
    xml_boxes: list[CvatBox],
    local_annotations: list[AnnotationRecord],
    width: int,
    height: int,
    box_stats: dict[str, int],
) -> list[CvatBox]:
    output: list[CvatBox] = []
    seen: set[tuple[str, int, str, str, float, float, float, float]] = set()

    box_stats["xml_boxes_read"] += len(xml_boxes)
    for box in xml_boxes:
        if not _append_unique_box(output, seen, box, task_external_id, frame):
            box_stats["duplicate_boxes_removed"] += 1

    xml_has_boxes = bool(xml_boxes)
    for annotation in local_annotations:
        box_stats["local_boxes_read"] += 1
        if not _include_local_annotation(annotation, xml_has_boxes):
            box_stats["excluded_boxes"] += 1
            continue
        box = _local_annotation_box(annotation, width, height)
        if box is None:
            box_stats["excluded_boxes"] += 1
            continue
        if not _append_unique_box(output, seen, box, task_external_id, frame):
            box_stats["duplicate_boxes_removed"] += 1

    box_stats["boxes_read"] = box_stats["xml_boxes_read"] + box_stats["local_boxes_read"]
    return output


def _include_local_annotation(annotation: AnnotationRecord, xml_has_boxes: bool) -> bool:
    if not xml_has_boxes:
        return True
    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    cvat_synced = _raw_bool(raw.get("cvat_synced"))
    if cvat_synced is False:
        return True
    if cvat_synced is True:
        return False
    source = str(annotation.source or raw.get("source") or raw.get("origin") or "").strip().casefold()
    return source not in {"dataset_import", "cvat_export", "sync_cvat"}


def _append_unique_box(
    output: list[CvatBox],
    seen: set[tuple[str, int, str, str, float, float, float, float]],
    box: CvatBox,
    task_external_id: str,
    frame: int,
) -> bool:
    key = _box_dedup_key(box, task_external_id, frame)
    if key in seen:
        return False
    seen.add(key)
    output.append(box)
    return True


def _box_dedup_key(box: CvatBox, task_external_id: str, frame: int) -> tuple[str, int, str, str, float, float, float, float]:
    return (
        task_external_id,
        int(frame),
        box.label.casefold(),
        str(box.shape_type or "rectangle").casefold(),
        round(float(box.xtl), 3),
        round(float(box.ytl), 3),
        round(float(box.xbr), 3),
        round(float(box.ybr), 3),
    )


def _release_artifacts(release: DatasetRelease) -> list[dict[str, Any]]:
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    artifacts = snapshot.get("artifacts") if isinstance(snapshot.get("artifacts"), list) else []
    rows = [artifact for artifact in artifacts if isinstance(artifact, dict) and artifact.get("uri")]
    if not rows and release.artifact_uri:
        rows = [{"uri": release.artifact_uri, "name": Path(release.artifact_uri).name}]
    return rows


def _release_task_external_ids(release: DatasetRelease, artifacts: list[dict[str, Any]]) -> list[str]:
    ids = []
    snapshot_ids = release.task_external_ids if isinstance(release.task_external_ids, list) else []
    for value in snapshot_ids:
        if value is not None:
            ids.append(str(value))
    for artifact in artifacts:
        value = artifact.get("task_external_id")
        if value is not None:
            ids.append(str(value))
    return sorted(set(ids))


def _local_annotations_by_frame(
    db: Session,
    task_external_ids: list[str],
) -> dict[tuple[str, int], list[AnnotationRecord]]:
    if not task_external_ids:
        return {}
    rows = db.scalars(
        select(AnnotationRecord).where(
            AnnotationRecord.task_external_id.in_(task_external_ids),
            AnnotationRecord.frame.is_not(None),
        )
    ).all()
    grouped: dict[tuple[str, int], list[AnnotationRecord]] = {}
    for row in rows:
        task_external_id = str(row.task_external_id or "")
        if not task_external_id or row.frame is None:
            continue
        if (row.review_state or "").lower() in EXCLUDED_REVIEW_STATES:
            continue
        annotation_type = (row.annotation_type or "").lower()
        shape_type = (row.shape_type or "").lower()
        if annotation_type != "tag" and shape_type not in {"rectangle", "polygon"}:
            continue
        grouped.setdefault((task_external_id, int(row.frame)), []).append(row)
    return grouped


def _classification_labels_for_image(xml_tags: list[str], local_annotations: list[AnnotationRecord]) -> list[str]:
    labels = []
    seen = set()
    for label in xml_tags:
        normalized = label.strip()
        key = normalized.casefold()
        if normalized and key not in seen:
            labels.append(normalized)
            seen.add(key)
    for annotation in local_annotations:
        if (annotation.annotation_type or "").lower() != "tag":
            continue
        label = annotation.label_name or _raw_label_name(annotation.raw)
        if not label:
            continue
        normalized = label.strip()
        key = normalized.casefold()
        if normalized and key not in seen:
            labels.append(normalized)
            seen.add(key)
    return labels


def _local_boxes_for_image(
    annotations: list[AnnotationRecord],
    width: int,
    height: int,
) -> list[CvatBox]:
    boxes = []
    for annotation in annotations:
        box = _local_annotation_box(annotation, width, height)
        if box is not None:
            boxes.append(box)
    return boxes


def _local_annotation_box(annotation: AnnotationRecord, width: int, height: int) -> CvatBox | None:
    label = annotation.label_name or _raw_label_name(annotation.raw)
    if not label:
        return None
    shape_type = (annotation.shape_type or "rectangle").lower()
    source = annotation.source or _raw_source(annotation.raw) or "local"

    points = _numeric_points(annotation.points)
    if len(points) >= 4:
        points = _absolute_points(points, width, height)
        if shape_type == "polygon":
            xs = points[0::2]
            ys = points[1::2]
            xtl, ytl, xbr, ybr = min(xs), min(ys), max(xs), max(ys)
        else:
            xtl, ytl, xbr, ybr = points[:4]
        return _validated_box(label, xtl, ytl, xbr, ybr, width, height, shape_type=shape_type, source=source)

    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    bbox_norm = raw.get("bbox_norm") if isinstance(raw.get("bbox_norm"), dict) else None
    if bbox_norm:
        x = _float(bbox_norm.get("x"))
        y = _float(bbox_norm.get("y"))
        w = _float(bbox_norm.get("w"))
        h = _float(bbox_norm.get("h"))
        if x is not None and y is not None and w is not None and h is not None:
            return _validated_box(
                label,
                x * width,
                y * height,
                (x + w) * width,
                (y + h) * height,
                width,
                height,
                shape_type=shape_type,
                source=source,
            )
    return None


def _raw_label_name(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("label_name") or raw.get("label")
    return str(value).strip() if value else None


def _raw_source(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("source") or raw.get("origin")
    return str(value).strip() if value else None


def _raw_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "sim", "on"}:
            return True
        if normalized in {"0", "false", "no", "nao", "não", "off"}:
            return False
    return None


def _numeric_points(points: Any) -> list[float]:
    if not isinstance(points, list):
        return []
    values = [_float(value) for value in points]
    return [value for value in values if value is not None]


def _absolute_points(points: list[float], width: int, height: int) -> list[float]:
    if points and all(0 <= value <= 1 for value in points):
        return [value * (width if index % 2 == 0 else height) for index, value in enumerate(points)]
    return points


def _validated_box(
    label: str,
    xtl: float,
    ytl: float,
    xbr: float,
    ybr: float,
    width: int,
    height: int,
    *,
    shape_type: str = "rectangle",
    source: str = "local",
) -> CvatBox | None:
    left = _clamp_to_dimension(min(xtl, xbr), width)
    right = _clamp_to_dimension(max(xtl, xbr), width)
    top = _clamp_to_dimension(min(ytl, ybr), height)
    bottom = _clamp_to_dimension(max(ytl, ybr), height)
    if right <= left or bottom <= top:
        return None
    return CvatBox(label, left, top, right, bottom, shape_type=shape_type, source=source)


def _snapshot_class_names(snapshot: dict[str, Any]) -> list[str]:
    labels = snapshot.get("labels") if isinstance(snapshot.get("labels"), list) else []
    names = []
    for label in labels:
        if isinstance(label, dict) and label.get("name"):
            name = str(label["name"])
            if name not in names:
                names.append(name)
    return names


def split_policy_digest(raw: Any) -> str:
    return _split_policy(raw)["digest"]


def _split_policy(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    ratios = _normalize_splits(source)
    stratify = _bool_value(source.get("stratify"), True)
    raw_strategy = str(source.get("strategy_key") or source.get("strategy") or "").strip().casefold()
    if not stratify or raw_strategy in {"random", "image_random", "aleatoria", "aleatorio"}:
        strategy = "image_random"
    else:
        strategy = "class_balanced_best_effort"

    policy = {
        **ratios,
        "strategy": strategy,
        "seed": _int_policy(source.get("seed"), DEFAULT_SPLIT_POLICY["seed"]),
        "min_per_class_train": _int_policy(
            source.get("min_per_class_train"),
            DEFAULT_SPLIT_POLICY["min_per_class_train"],
        ),
        "min_per_class_val": _int_policy(
            source.get("min_per_class_val"),
            DEFAULT_SPLIT_POLICY["min_per_class_val"],
        ),
        "test_required": _bool_value(source.get("test_required"), DEFAULT_SPLIT_POLICY["test_required"]),
        "rare_class_threshold": _int_policy(
            source.get("rare_class_threshold"),
            DEFAULT_SPLIT_POLICY["rare_class_threshold"],
        ),
        "preserve_groups": _bool_value(
            source.get("preserve_groups", source.get("preserveGroups")),
            DEFAULT_SPLIT_POLICY["preserve_groups"],
        ),
        "group_by": str(source.get("group_by") or source.get("groupBy") or "").strip(),
    }
    policy["digest"] = _policy_digest(policy)
    return policy


def _policy_digest(policy: dict[str, Any]) -> str:
    payload = {key: value for key, value in policy.items() if key != "digest"}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()[:16]


def _normalize_splits(raw: Any) -> dict[str, float]:
    if not isinstance(raw, dict):
        return DEFAULT_SPLITS
    train = _ratio(raw.get("train"), DEFAULT_SPLITS["train"])
    val = _ratio(raw.get("val"), DEFAULT_SPLITS["val"])
    test = _ratio(raw.get("test"), DEFAULT_SPLITS["test"])
    total = train + val + test
    if total <= 0:
        return DEFAULT_SPLITS
    return {"train": train / total, "val": val / total, "test": test / total}


def _int_policy(value: Any, fallback: int) -> int:
    parsed = _int(value)
    return max(0, parsed if parsed is not None else int(fallback))


def _bool_value(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().casefold()
        if normalized in {"1", "true", "yes", "sim", "on"}:
            return True
        if normalized in {"0", "false", "no", "nao", "não", "off"}:
            return False
    return fallback


def _ratio(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed / 100 if parsed > 1 else parsed


def _split_assignments(items: list[dict[str, Any]], split_policy: dict[str, Any]) -> dict[str, str]:
    if split_policy.get("strategy") == "image_random":
        return _ratio_split_assignments(items, split_policy)
    return _class_balanced_split_assignments(items, split_policy)


def _ratio_split_assignments(items: list[dict[str, Any]], splits: dict[str, Any]) -> dict[str, str]:
    counts = _balanced_split_counts(len(items), splits)
    assignments: dict[str, str] = {}
    positive_items = [item for item in items if _source_image_annotation_count(item) > 0]
    background_items = [item for item in items if _source_image_annotation_count(item) <= 0]

    positive_counts = _bounded_positive_split_counts(len(positive_items), counts, splits)
    remaining_counts = dict(counts)
    positive_keys = _stable_ordered_keys(positive_items, _int_policy(splits.get("seed"), 42))
    cursor = _assign_ordered_keys(assignments, positive_keys, positive_counts, 0)
    if cursor < len(positive_keys):
        for key in positive_keys[cursor:]:
            split = max(remaining_counts, key=remaining_counts.get)
            assignments[key] = split
            remaining_counts[split] = max(0, remaining_counts[split] - 1)
    else:
        for split, count in positive_counts.items():
            remaining_counts[split] = max(0, remaining_counts[split] - count)

    background_keys = _stable_ordered_keys(background_items, _int_policy(splits.get("seed"), 42))
    _assign_ordered_keys(assignments, background_keys, remaining_counts, 0)
    return assignments


def _class_balanced_split_assignments(items: list[dict[str, Any]], split_policy: dict[str, Any]) -> dict[str, str]:
    capacities = _balanced_split_counts(len(items), split_policy)
    units = _split_units(items, split_policy)
    positive_units = [unit for unit in units if unit["labels"]]
    background_units = [unit for unit in units if not unit["labels"]]
    class_totals = Counter(label for unit in positive_units for label in unit["labels"])
    desired = {
        split: Counter(
            {
                label: _desired_class_split_counts(total, split_policy)[split]
                for label, total in class_totals.items()
            }
        )
        for split in ("train", "val", "test")
    }
    current = {"train": Counter(), "val": Counter(), "test": Counter()}
    remaining = dict(capacities)
    assignments: dict[str, str] = {}
    seed = _int_policy(split_policy.get("seed"), 42)

    for unit in sorted(positive_units, key=lambda item: _unit_order_key(item, class_totals, seed)):
        split = _best_split_for_unit(unit, desired, current, remaining, split_policy, seed)
        _assign_unit(assignments, unit, split)
        remaining[split] = remaining.get(split, 0) - int(unit["size"])
        for label in unit["labels"]:
            current[split][label] += 1

    for unit in sorted(background_units, key=lambda item: _stable_hash(str(item["key"]), seed)):
        split = _best_capacity_split(remaining, split_policy, int(unit["size"]))
        _assign_unit(assignments, unit, split)
        remaining[split] = remaining.get(split, 0) - int(unit["size"])

    return assignments


def _split_units(items: list[dict[str, Any]], split_policy: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    preserve_groups = bool(split_policy.get("preserve_groups"))
    for item in items:
        key = str((item.get("group_key") if preserve_groups else None) or item.get("stable_key"))
        grouped.setdefault(key, []).append(item)
    units = []
    for key, rows in grouped.items():
        labels = sorted({label for row in rows for label in _source_image_class_counts(row)})
        units.append(
            {
                "key": key,
                "items": rows,
                "size": len(rows),
                "labels": labels,
                "stable_key": "|".join(sorted(str(row["stable_key"]) for row in rows)),
            }
        )
    return units


def _unit_order_key(unit: dict[str, Any], class_totals: Counter, seed: int) -> tuple[int, int, str]:
    labels = list(unit.get("labels") or [])
    rarest = min((class_totals[label] for label in labels), default=0)
    return (rarest, -len(labels), _stable_hash(str(unit["stable_key"]), seed))


def _best_split_for_unit(
    unit: dict[str, Any],
    desired: dict[str, Counter],
    current: dict[str, Counter],
    remaining: dict[str, int],
    split_policy: dict[str, Any],
    seed: int,
) -> str:
    size = int(unit["size"])
    labels = list(unit.get("labels") or [])
    candidates = ("train", "val", "test")
    scored = []
    for split in candidates:
        if split_policy.get(split, 0) <= 0:
            continue
        capacity = remaining.get(split, 0)
        capacity_penalty = 0 if capacity >= size else abs(capacity - size) + 10
        score = -float(capacity_penalty)
        for label in labels:
            deficit = desired[split][label] - current[split][label]
            if deficit > 0:
                score += 10 + deficit
            else:
                score -= abs(deficit) * 0.1
        score += max(capacity, 0) / max(1, size) * 0.01
        scored.append((score, capacity, _stable_hash(f"{unit['stable_key']}:{split}", seed), split))
    if not scored:
        return "train"
    return max(scored, key=lambda row: (row[0], row[1], row[2]))[3]


def _best_capacity_split(remaining: dict[str, int], split_policy: dict[str, Any], size: int) -> str:
    candidates = [split for split in ("train", "val", "test") if split_policy.get(split, 0) > 0]
    if not candidates:
        return "train"
    return max(candidates, key=lambda split: (remaining.get(split, 0) >= size, remaining.get(split, 0), split_policy[split]))


def _assign_unit(assignments: dict[str, str], unit: dict[str, Any], split: str) -> None:
    for item in unit["items"]:
        assignments[str(item["stable_key"])] = split


def _desired_class_split_counts(total: int, split_policy: dict[str, Any]) -> dict[str, int]:
    counts = _balanced_split_counts(total, split_policy)
    minimums = {"train": 0, "val": 0, "test": 0}
    if split_policy.get("train", 0) > 0 and total >= 1:
        minimums["train"] = min(total, _int_policy(split_policy.get("min_per_class_train"), 1))
    if split_policy.get("val", 0) > 0 and total >= minimums["train"] + 1:
        minimums["val"] = min(total - minimums["train"], _int_policy(split_policy.get("min_per_class_val"), 1))
    if (
        split_policy.get("test", 0) > 0
        and split_policy.get("test_required")
        and total >= minimums["train"] + minimums["val"] + 1
    ):
        minimums["test"] = 1
    for split, minimum in minimums.items():
        counts[split] = max(counts.get(split, 0), minimum)
    while sum(counts.values()) > total:
        reducible = [split for split in ("train", "val", "test") if counts[split] > minimums[split]]
        if not reducible:
            break
        split = max(reducible, key=lambda item: counts[item] - (total * float(split_policy.get(item, 0) or 0)))
        counts[split] -= 1
    while sum(counts.values()) < total:
        split = max(("train", "val", "test"), key=lambda item: float(split_policy.get(item, 0) or 0))
        counts[split] += 1
    return counts


def _stable_ordered_keys(items: list[dict[str, Any]], seed: int = 42) -> list[str]:
    return sorted(
        [str(item["stable_key"]) for item in items],
        key=lambda value: _stable_hash(value, seed),
    )


def _stable_hash(value: str, seed: int) -> str:
    return hashlib.sha1(f"{seed}:{value}".encode()).hexdigest()


def _assign_ordered_keys(
    assignments: dict[str, str],
    ordered_keys: list[str],
    counts: dict[str, int],
    cursor: int,
) -> int:
    for split in ("train", "val", "test"):
        for key in ordered_keys[cursor : cursor + counts[split]]:
            assignments[key] = split
        cursor += counts[split]
    return cursor


def _bounded_positive_split_counts(
    total: int,
    split_capacity: dict[str, int],
    splits: dict[str, float],
) -> dict[str, int]:
    counts = _balanced_split_counts(total, splits)
    for split in ("train", "val", "test"):
        counts[split] = min(counts[split], split_capacity.get(split, 0))

    remaining = total - sum(counts.values())
    if remaining <= 0:
        return counts

    candidates = sorted(
        ("train", "val", "test"),
        key=lambda split: (split_capacity.get(split, 0) - counts[split], splits.get(split, 0)),
        reverse=True,
    )
    while remaining > 0:
        progressed = False
        for split in candidates:
            if remaining <= 0:
                break
            if counts[split] >= split_capacity.get(split, 0):
                continue
            counts[split] += 1
            remaining -= 1
            progressed = True
        if not progressed:
            break
    return counts


def _balanced_split_counts(total: int, splits: dict[str, float]) -> dict[str, int]:
    counts = {"train": 0, "val": 0, "test": 0}
    if total <= 0:
        return counts

    enabled = [split for split in ("train", "val", "test") if splits.get(split, 0) > 0]
    if "train" not in enabled:
        enabled.insert(0, "train")
    enabled = enabled[:total]

    for split in enabled:
        counts[split] = 1
    remaining = total - len(enabled)
    if remaining <= 0:
        return counts

    total_weight = sum(splits.get(split, 0) for split in enabled) or len(enabled)
    raw = {split: (remaining * splits.get(split, 0) / total_weight) for split in enabled}
    floors = {split: int(raw[split]) for split in enabled}
    for split, value in floors.items():
        counts[split] += value
    leftover = remaining - sum(floors.values())
    for split in sorted(enabled, key=lambda item: (raw[item] - floors[item], splits.get(item, 0)), reverse=True):
        if leftover <= 0:
            break
            counts[split] += 1
            leftover -= 1
    return counts


def _group_key_for_image(task_external_id: str, image_name: str, split_policy: dict[str, Any]) -> str:
    if not split_policy.get("preserve_groups"):
        return ""
    group_by = str(split_policy.get("group_by") or "").casefold()
    normalized = image_name.replace("\\", "/")
    parent = Path(normalized).parent.as_posix()
    if "pasta" in group_by and parent not in {"", ".", "images"}:
        return f"{task_external_id}:folder:{parent}"
    if parent not in {"", ".", "images"}:
        return f"{task_external_id}:path:{parent}"
    return ""


def _class_distribution(
    source_images: list[dict[str, Any]],
    assignments: dict[str, str],
    class_names: list[str],
) -> list[dict[str, Any]]:
    rows = {
        name: {
            "name": name,
            "train": 0,
            "val": 0,
            "test": 0,
            "total": 0,
            "images": {"train": 0, "val": 0, "test": 0, "total": 0},
        }
        for name in class_names
    }
    for source_image in source_images:
        split = assignments[str(source_image["stable_key"])]
        image_class_counts = _source_image_class_counts(source_image)
        for label, count in image_class_counts.items():
            if label not in rows:
                rows[label] = {
                    "name": label,
                    "train": 0,
                    "val": 0,
                    "test": 0,
                    "total": 0,
                    "images": {"train": 0, "val": 0, "test": 0, "total": 0},
                }
            rows[label][split] += count
            rows[label]["total"] += count
            rows[label]["images"][split] += 1
            rows[label]["images"]["total"] += 1
    return list(rows.values())


def _source_image_class_counts(source_image: dict[str, Any]) -> Counter:
    counts = Counter(box.label for box in source_image.get("boxes", []))
    for label in source_image.get("labels", []):
        if label:
            counts[str(label)] += 1
    return counts


def _source_image_annotation_count(source_image: dict[str, Any]) -> int:
    return sum(_source_image_class_counts(source_image).values())


def _dataset_health(
    *,
    class_distribution: list[dict[str, Any]],
    manifest_images: list[dict[str, Any]],
    box_stats: dict[str, int],
    split_policy: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    warnings: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    if box_stats.get("duplicate_boxes_removed", 0) > 0:
        warnings.append(
            {
                "code": "duplicate_boxes_removed",
                "message": "Labels duplicadas foram removidas durante o preparo YOLO.",
                "count": box_stats["duplicate_boxes_removed"],
            }
        )

    empty_images = [image["name"] for image in manifest_images if int(image.get("annotations") or image.get("boxes") or 0) == 0]
    if empty_images:
        warnings.append(
            {
                "code": "empty_images_included",
                "message": "Imagens sem anotação foram incluídas no dataset preparado.",
                "count": len(empty_images),
            }
        )

    if snapshot.get("image_scope") == "annotated" and empty_images:
        warnings.append(
            {
                "code": "annotated_scope_contains_empty_images",
                "message": "O release foi marcado como somente anotadas, mas o artefato contém imagens sem anotações.",
                "count": len(empty_images),
            }
        )

    active_classes = [row for row in class_distribution if int(row.get("total") or 0) > 0]
    missing_train = [row["name"] for row in active_classes if int(row.get("train") or 0) < split_policy["min_per_class_train"]]
    if missing_train:
        warnings.append(
            {
                "code": "classes_missing_train",
                "message": "Classes com anotações não ficaram representadas no treino.",
                "classes": missing_train,
                "count": len(missing_train),
            }
        )
    if split_policy.get("val", 0) > 0:
        missing_val = [row["name"] for row in active_classes if int(row.get("val") or 0) < split_policy["min_per_class_val"]]
        if missing_val:
            warnings.append(
                {
                    "code": "classes_missing_val",
                    "message": "Classes com anotações não ficaram representadas na validação.",
                    "classes": missing_val,
                    "count": len(missing_val),
                }
            )
    if split_policy.get("test_required") and split_policy.get("test", 0) > 0:
        missing_test = [row["name"] for row in active_classes if int(row.get("test") or 0) <= 0]
        if missing_test:
            warnings.append(
                {
                    "code": "classes_missing_test",
                    "message": "Classes com anotações não ficaram representadas no teste.",
                    "classes": missing_test,
                    "count": len(missing_test),
                }
            )

    rare_threshold = _int_policy(split_policy.get("rare_class_threshold"), 5)
    rare_classes = [row["name"] for row in active_classes if 0 < int(row.get("total") or 0) < rare_threshold]
    if rare_classes:
        warnings.append(
            {
                "code": "rare_classes",
                "message": f"Classes com menos de {rare_threshold} objetos terão métricas instáveis.",
                "classes": rare_classes,
                "count": len(rare_classes),
            }
        )

    zero_total = [row["name"] for row in class_distribution if int(row.get("total") or 0) == 0]
    if zero_total:
        warnings.append(
            {
                "code": "classes_without_annotations",
                "message": "Classes existem no catálogo, mas não têm anotações no dataset preparado.",
                "classes": zero_total,
                "count": len(zero_total),
            }
        )

    if not warnings:
        checks.append({"code": "split_health_ok", "message": "Split preparado sem alertas críticos."})

    return {
        "status": "warning" if warnings else "ok",
        "warnings": warnings,
        "checks": checks,
    }


def _find_image_member(files: dict[str, bytes], image_name: str) -> str | None:
    candidates = [image_name, image_name.replace("\\", "/")]
    basename = Path(image_name).name
    for name in files:
        suffix = Path(name).suffix.lower()
        if suffix not in IMAGE_EXTENSIONS:
            continue
        normalized = name.replace("\\", "/")
        if normalized in candidates or Path(normalized).name == basename:
            return name
    return None


def _image_dimension(files: dict[str, bytes], image_name: str, index: int) -> int:
    member = _find_image_member(files, image_name)
    if member is None:
        return 1
    with Image.open(io.BytesIO(files[member])) as image:
        return int(image.size[index])


def _polygon_points(raw: str) -> list[float]:
    values = []
    for point in raw.split(";"):
        x, _, y = point.partition(",")
        parsed_x = _float(x)
        parsed_y = _float(y)
        if parsed_x is not None and parsed_y is not None:
            values.extend([parsed_x, parsed_y])
    return values


def _safe_stem(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def _data_yaml(data: dict[str, Any]) -> str:
    names = data["names"]
    lines = [
        f"path: {data['path']}",
        f"train: {data['train']}",
        f"val: {data['val']}",
        f"test: {data['test']}",
        "names:",
    ]
    for index, name in names.items():
        escaped = str(name).replace('"', '\\"')
        lines.append(f'  {index}: "{escaped}"')
    return "\n".join(lines) + "\n"


def _count_splits(images: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"train": 0, "val": 0, "test": 0}
    for image in images:
        split = str(image.get("split") or "train")
        counts[split] = counts.get(split, 0) + 1
    return counts


def _zip_directory(source: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in source.rglob("*"):
            if file.is_file():
                archive.write(file, file.relative_to(source).as_posix())


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def _clamp_to_dimension(value: float, dimension: int) -> float:
    return min(float(max(dimension, 1)), max(0.0, value))
