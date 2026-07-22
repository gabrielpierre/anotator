import hashlib
import io
import json
import zipfile
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
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
EXCLUDED_REVIEW_STATES = {"deleted_by_reviewer", "rejected", "incorrect", "needs_annotation"}


def prepare_yolo_dataset(
    db: Session,
    *,
    release_id: str,
    artifact_store: ArtifactStore,
) -> dict[str, Any]:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise ValueError(f"DatasetRelease {release_id} not found")
    if release.status != "ready" or not release.artifact_uri:
        raise ValueError("YOLO preparation requires a ready DatasetRelease with artifacts")

    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    artifacts = _release_artifacts(release)
    splits = _normalize_splits(snapshot.get("splits"))

    with TemporaryDirectory(prefix="anotator-yolo-") as tmpdir:
        root = Path(tmpdir)
        dataset_dir = root / "dataset"
        for split in ("train", "val", "test"):
            (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
            (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

        class_names = _snapshot_class_names(snapshot)
        class_index = {name: index for index, name in enumerate(class_names)}
        source_images: list[dict[str, Any]] = []
        local_annotations = _local_annotations_by_frame(db, _release_task_external_ids(release, artifacts))

        for artifact in artifacts:
            uri = str(artifact["uri"])
            task_external_id = str(artifact.get("task_external_id") or "")
            blob = artifact_store.get(uri)
            extracted = _read_cvat_zip(blob.content)
            for name in extracted.class_names:
                if name not in class_index:
                    class_index[name] = len(class_index)
                    class_names.append(name)
            for item in extracted.images:
                image_member = _find_image_member(extracted.files, item.name)
                if image_member is None:
                    continue
                extension = Path(image_member).suffix.lower() or ".jpg"
                stable_key = f"{artifact.get('task_external_id', 'task')}:{item.name}:{len(source_images)}"
                boxes = [
                    *item.boxes,
                    *_local_boxes_for_image(
                        local_annotations.get((task_external_id, item.frame), []),
                        item.width,
                        item.height,
                    ),
                ]
                source_images.append(
                    {
                        "stable_key": stable_key,
                        "name": item.name,
                        "image_bytes": extracted.files[image_member],
                        "extension": extension,
                        "width": item.width,
                        "height": item.height,
                        "frame": item.frame,
                        "boxes": boxes,
                        "source_artifact_uri": uri,
                    }
                )

        if not source_images:
            raise ValueError("No images with annotations were found in release artifacts")
        if not class_names:
            class_names.append("object")

        assignments = _balanced_split_assignments(source_images, splits)
        manifest_images: list[dict[str, Any]] = []
        for source_image in source_images:
            split = assignments[str(source_image["stable_key"])]
            safe_stem = _safe_stem(str(source_image["stable_key"]))
            image_target = dataset_dir / "images" / split / f"{safe_stem}{source_image['extension']}"
            label_target = dataset_dir / "labels" / split / f"{safe_stem}.txt"
            image_target.write_bytes(source_image["image_bytes"])

            labels = []
            for box in source_image["boxes"]:
                if box.label not in class_index:
                    class_index[box.label] = len(class_index)
                    class_names.append(box.label)
                labels.append(
                    _yolo_label_line(
                        class_index[box.label],
                        box,
                        source_image["width"],
                        source_image["height"],
                    )
                )
            label_target.write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")
            manifest_images.append(
                {
                    "name": source_image["name"],
                    "split": split,
                    "image": str(image_target.relative_to(dataset_dir)),
                    "label": str(label_target.relative_to(dataset_dir)),
                    "width": source_image["width"],
                    "height": source_image["height"],
                    "boxes": len(labels),
                    "source_artifact_uri": source_image["source_artifact_uri"],
                }
            )

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
        (dataset_dir / "data.yaml").write_text(_data_yaml(data_yaml_dict), encoding="utf-8")
        manifest = {
            "format": "yolo",
            "release_id": release.id,
            "release_name": release.name,
            "splits": split_counts,
            "classes": class_names,
            "images": manifest_images,
            "source_artifacts": artifacts,
        }
        (dataset_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        output = root / "prepared-yolo.zip"
        _zip_directory(dataset_dir, output)
        key = f"prepared-datasets/{release.id}/yolo/prepared-yolo.zip"
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
                "images": len(manifest_images),
                "classes": class_names,
            },
        )
    )
    db.commit()
    db.refresh(release)
    return prepared


class CvatImage:
    def __init__(self, name: str, width: int, height: int, frame: int, boxes: list["CvatBox"]):
        self.name = name
        self.width = width
        self.height = height
        self.frame = frame
        self.boxes = boxes


class CvatBox:
    def __init__(self, label: str, xtl: float, ytl: float, xbr: float, ybr: float):
        self.label = label
        self.xtl = xtl
        self.ytl = ytl
        self.xbr = xbr
        self.ybr = ybr


class CvatZip:
    def __init__(self, class_names: list[str], images: list[CvatImage], files: dict[str, bytes]):
        self.class_names = class_names
        self.images = images
        self.files = files


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
        boxes.append(CvatBox(label, xtl, ytl, xbr, ybr))
    for polygon in image.findall("polygon"):
        label = str(polygon.attrib.get("label") or "object")
        points = _polygon_points(str(polygon.attrib.get("points") or ""))
        if points:
            xs = points[0::2]
            ys = points[1::2]
            boxes.append(CvatBox(label, min(xs), min(ys), max(xs), max(ys)))
    return boxes


def _yolo_label_line(class_id: int, box: CvatBox, width: int, height: int) -> str:
    width = max(width, 1)
    height = max(height, 1)
    x_center = ((box.xtl + box.xbr) / 2) / width
    y_center = ((box.ytl + box.ybr) / 2) / height
    box_width = (box.xbr - box.xtl) / width
    box_height = (box.ybr - box.ytl) / height
    values = [_clamp(x_center), _clamp(y_center), _clamp(box_width), _clamp(box_height)]
    return f"{class_id} " + " ".join(f"{value:.6f}" for value in values)


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
        if (row.shape_type or "").lower() not in {"rectangle", "polygon"}:
            continue
        grouped.setdefault((task_external_id, int(row.frame)), []).append(row)
    return grouped


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

    points = _numeric_points(annotation.points)
    if len(points) >= 4:
        points = _absolute_points(points, width, height)
        if (annotation.shape_type or "").lower() == "polygon":
            xs = points[0::2]
            ys = points[1::2]
            xtl, ytl, xbr, ybr = min(xs), min(ys), max(xs), max(ys)
        else:
            xtl, ytl, xbr, ybr = points[:4]
        return _validated_box(label, xtl, ytl, xbr, ybr, width, height)

    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    bbox_norm = raw.get("bbox_norm") if isinstance(raw.get("bbox_norm"), dict) else None
    if bbox_norm:
        x = _float(bbox_norm.get("x"))
        y = _float(bbox_norm.get("y"))
        w = _float(bbox_norm.get("w"))
        h = _float(bbox_norm.get("h"))
        if x is not None and y is not None and w is not None and h is not None:
            return _validated_box(label, x * width, y * height, (x + w) * width, (y + h) * height, width, height)
    return None


def _raw_label_name(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("label_name") or raw.get("label")
    return str(value).strip() if value else None


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
) -> CvatBox | None:
    left = _clamp_to_dimension(min(xtl, xbr), width)
    right = _clamp_to_dimension(max(xtl, xbr), width)
    top = _clamp_to_dimension(min(ytl, ybr), height)
    bottom = _clamp_to_dimension(max(ytl, ybr), height)
    if right <= left or bottom <= top:
        return None
    return CvatBox(label, left, top, right, bottom)


def _snapshot_class_names(snapshot: dict[str, Any]) -> list[str]:
    labels = snapshot.get("labels") if isinstance(snapshot.get("labels"), list) else []
    names = []
    for label in labels:
        if isinstance(label, dict) and label.get("name"):
            name = str(label["name"])
            if name not in names:
                names.append(name)
    return names


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


def _ratio(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed / 100 if parsed > 1 else parsed


def _balanced_split_assignments(items: list[dict[str, Any]], splits: dict[str, float]) -> dict[str, str]:
    counts = _balanced_split_counts(len(items), splits)
    assignments: dict[str, str] = {}
    positive_items = [item for item in items if item.get("boxes")]
    background_items = [item for item in items if not item.get("boxes")]

    positive_counts = _bounded_positive_split_counts(len(positive_items), counts, splits)
    remaining_counts = dict(counts)
    positive_keys = _stable_ordered_keys(positive_items)
    cursor = _assign_ordered_keys(assignments, positive_keys, positive_counts, 0)
    if cursor < len(positive_keys):
        for key in positive_keys[cursor:]:
            split = max(remaining_counts, key=remaining_counts.get)
            assignments[key] = split
            remaining_counts[split] = max(0, remaining_counts[split] - 1)
    else:
        for split, count in positive_counts.items():
            remaining_counts[split] = max(0, remaining_counts[split] - count)

    background_keys = _stable_ordered_keys(background_items)
    _assign_ordered_keys(assignments, background_keys, remaining_counts, 0)
    return assignments


def _stable_ordered_keys(items: list[dict[str, Any]]) -> list[str]:
    return sorted(
        [str(item["stable_key"]) for item in items],
        key=lambda value: hashlib.sha1(value.encode("utf-8")).hexdigest(),
    )


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
