import hashlib
import io
import json
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from xml.etree import ElementTree

from PIL import Image
from sqlalchemy.orm import Session

from app.models import AuditEvent, DatasetRelease
from app.services.artifacts import ArtifactStore, proxy_download_url

DEFAULT_SPLITS = {"train": 0.8, "val": 0.1, "test": 0.1}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


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
        manifest_images: list[dict[str, Any]] = []

        for artifact in artifacts:
            uri = str(artifact["uri"])
            blob = artifact_store.get(uri)
            extracted = _read_cvat_zip(blob.content)
            for name in extracted.class_names:
                if name not in class_index:
                    class_index[name] = len(class_index)
                    class_names.append(name)
            for item in extracted.images:
                split = _split_for_name(item.name, splits)
                image_member = _find_image_member(extracted.files, item.name)
                if image_member is None:
                    continue
                image_bytes = extracted.files[image_member]
                extension = Path(image_member).suffix.lower() or ".jpg"
                safe_stem = _safe_stem(f"{artifact.get('task_external_id', 'task')}_{item.name}")
                image_target = dataset_dir / "images" / split / f"{safe_stem}{extension}"
                label_target = dataset_dir / "labels" / split / f"{safe_stem}.txt"
                image_target.write_bytes(image_bytes)

                labels = []
                for box in item.boxes:
                    if box.label not in class_index:
                        class_index[box.label] = len(class_index)
                        class_names.append(box.label)
                    labels.append(_yolo_label_line(class_index[box.label], box, item.width, item.height))
                label_target.write_text("\n".join(labels) + ("\n" if labels else ""), encoding="utf-8")
                manifest_images.append(
                    {
                        "name": item.name,
                        "split": split,
                        "image": str(image_target.relative_to(dataset_dir)),
                        "label": str(label_target.relative_to(dataset_dir)),
                        "width": item.width,
                        "height": item.height,
                        "boxes": len(labels),
                        "source_artifact_uri": uri,
                    }
                )

        if not manifest_images:
            raise ValueError("No images with annotations were found in release artifacts")
        if not class_names:
            class_names.append("object")

        data_yaml_dict = {
            "path": ".",
            "train": "images/train",
            "val": "images/val",
            "test": "images/test",
            "names": {index: name for index, name in enumerate(class_names)},
        }
        (dataset_dir / "data.yaml").write_text(_data_yaml(data_yaml_dict), encoding="utf-8")
        manifest = {
            "format": "yolo",
            "release_id": release.id,
            "release_name": release.name,
            "splits": _count_splits(manifest_images),
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
    def __init__(self, name: str, width: int, height: int, boxes: list["CvatBox"]):
        self.name = name
        self.width = width
        self.height = height
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
        for image in root.findall(".//image"):
            name = str(image.attrib.get("name") or "").strip()
            if not name:
                continue
            width = _int(image.attrib.get("width")) or _image_dimension(files, name, 0)
            height = _int(image.attrib.get("height")) or _image_dimension(files, name, 1)
            boxes = _boxes_for_image(image)
            images.append(CvatImage(name=name, width=width, height=height, boxes=boxes))
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


def _split_for_name(name: str, splits: dict[str, float]) -> str:
    bucket = int(hashlib.sha1(name.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    if bucket < splits["train"]:
        return "train"
    if bucket < splits["train"] + splits["val"]:
        return "val"
    return "test"


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
