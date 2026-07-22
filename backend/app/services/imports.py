import hashlib
import io
import json
import time
from pathlib import Path
from typing import Any

import yaml
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AnnotationRecord, AuditEvent, CvatLabel, JobRecord, Project, ProjectMember, Task, TaskDataMeta, User
from app.schemas import ImportTaskCreate
from app.services.annotations import sync_job_annotations
from app.services.artifacts import ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.jobs import mark_job_running, succeed_job, update_job_progress
from app.services.sync import CvatSyncService

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
ANNOTATION_EXTENSIONS = {".txt", ".json", ".xml", ".yaml", ".yml", ".names"}
CLASS_FILE_NAMES = {"classes.txt", "obj.names", "data.yaml", "dataset.yaml"}
DATASET_IMPORT_EXTENSIONS = IMAGE_EXTENSIONS | ANNOTATION_EXTENSIONS
ACTIVE_IMPORT_STATUSES = {"queued", "running", "paused"}

COCO80_CLASS_NAMES = [
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
]


class DuplicateImportImagesError(ValueError):
    def __init__(self, conflicts: list[dict[str, Any]]):
        self.conflicts = conflicts
        super().__init__(_duplicate_import_message(conflicts))


def validate_import_quota(db: Session, payload: ImportTaskCreate, uploaded_bytes: int | None = None) -> Project | None:
    project = _resolve_project(db, payload.project_id)
    if project is None:
        return None
    storage = project.raw.get("storage") if isinstance(project.raw, dict) else None
    if not isinstance(storage, dict) or storage.get("enforce_quota") is False:
        return project
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    if not quota_bytes:
        return project
    used_bytes = _int_value(storage.get("used_bytes")) or 0
    estimated = uploaded_bytes if uploaded_bytes is not None else payload.estimated_bytes
    if estimated is None and payload.source_path:
        estimated = _path_size(Path(payload.source_path))
    if estimated is None:
        estimated = 0
    if used_bytes + estimated > quota_bytes:
        raise ValueError("Import exceeds project storage quota")
    return project


def record_import_storage_usage(
    db: Session,
    project: Project | None,
    uploaded_bytes: int,
    *,
    previous_uploaded_bytes: int = 0,
) -> None:
    if project is None or uploaded_bytes <= 0:
        return
    raw = dict(project.raw or {})
    storage = raw.get("storage")
    if not isinstance(storage, dict):
        return
    added_bytes = max(uploaded_bytes - max(previous_uploaded_bytes, 0), 0)
    if added_bytes <= 0:
        return
    used_bytes = (_int_value(storage.get("used_bytes")) or 0) + added_bytes
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    raw["storage"] = {
        **storage,
        "used_bytes": used_bytes,
        "used_gb": round(used_bytes / 1024**3, 3),
        "percent": round((used_bytes / quota_bytes) * 100, 2) if quota_bytes else 0,
    }
    project.raw = raw
    db.add(project)
    db.flush()


def run_import_task_job(
    db: Session,
    *,
    job_id: str,
    settings: Settings,
    artifact_store: ArtifactStore,
    client: CvatClient,
) -> JobRecord:
    job = mark_job_running(db, job_id, "Creating CVAT task.")
    payload = ImportTaskCreate.model_validate((job.raw or {}).get("payload") or {})
    project = validate_import_quota(db, payload)
    files = _files_from_job(job, artifact_store)
    if not files and payload.source_path:
        files = _files_from_source_path(Path(payload.source_path))
    media_files = _image_files(files)
    if not media_files:
        raise RuntimeError("Dataset import requires at least one image file")
    import_manifest = build_import_file_manifest(media_files)
    validate_import_file_manifest_unique(
        db,
        payload,
        import_manifest,
        artifact_store=artifact_store,
        current_job_id=job.id,
    )
    cvat_project_id = _cvat_project_id(project)
    task_payload = client.create_task(name=payload.name, labels=payload.labels, project_id=cvat_project_id)
    task_id = task_payload.get("id")
    if task_id is None:
        raise RuntimeError("CVAT did not return a task id")
    job.task_external_id = str(task_id)
    job.raw = {**(job.raw or {}), "cvat_task_id": str(task_id)}
    db.add(job)
    db.commit()
    update_job_progress(db, job_id, 35, detail=f"Created CVAT task {task_id}.")
    upload_result: dict[str, Any] | None = None
    upload_request: dict[str, Any] | None = None
    upload_result = client.upload_task_data(task_id, files=media_files)
    update_job_progress(db, job_id, 55, detail=f"Uploaded {len(media_files)} images to CVAT task {task_id}.")
    request_id = _request_id_from_payload(upload_result)
    if request_id:
        upload_request = _wait_for_cvat_request(client, request_id, settings)
    update_job_progress(db, job_id, 70, detail=f"CVAT processed {len(media_files)} images for task {task_id}.")
    sync_result = None
    if payload.sync_after_import:
        sync_result = CvatSyncService(db, client, job_id=job_id).sync_all().model_dump(mode="json")
        update_job_progress(db, job_id, 95, detail="Synchronized imported CVAT task.")
    assignee = _finalize_imported_task(
        db,
        str(task_id),
        payload.assignee_user_id,
        task_payload,
        project,
        import_manifest,
    )
    annotation_import = _materialize_dataset_annotations(
        db,
        client,
        task_external_id=str(task_id),
        payload=payload,
        files=files,
        media_files=media_files,
    )
    if annotation_import.get("imported"):
        update_job_progress(
            db,
            job_id,
            98,
            detail=f"Imported {annotation_import['imported']} dataset annotations.",
        )

    raw_update = {
        "cvat_task_id": str(task_id),
        "cvat_task": task_payload,
        "assignee": assignee,
        "import_manifest": {"files": import_manifest},
        "dataset_import": annotation_import,
        "upload_result": upload_result,
        "upload_request": upload_request,
        "sync_result": sync_result,
    }
    db.add(
        AuditEvent(
            actor="system",
            action="import_task_completed",
            target=job_id,
            payload=raw_update,
        )
    )
    return succeed_job(db, job_id, detail=f"Imported CVAT task {task_id}.", raw_update=raw_update)


def _files_from_job(job: JobRecord, artifact_store: ArtifactStore) -> list[tuple[str, bytes, str]]:
    uploads = (job.raw or {}).get("upload_artifacts")
    if not isinstance(uploads, list):
        return []
    files = []
    for upload in uploads:
        if not isinstance(upload, dict) or not upload.get("uri"):
            continue
        blob = artifact_store.get(str(upload["uri"]))
        files.append(
            (
                str(upload.get("relative_path") or upload.get("filename") or Path(str(upload["uri"])).name),
                blob.content,
                str(upload.get("content_type") or blob.content_type or "application/octet-stream"),
            )
        )
    return files


def is_import_image_file(filename: str, content_type: str | None = None) -> bool:
    suffix = Path(_safe_filename(filename)).suffix.lower()
    return suffix in IMAGE_EXTENSIONS or bool(content_type and content_type.startswith("image/"))


def _image_files(files: list[tuple[str, bytes, str]]) -> list[tuple[str, bytes, str]]:
    return [
        (filename, content, content_type)
        for filename, content, content_type in files
        if is_import_image_file(filename, content_type)
    ]


def build_import_file_manifest(files: list[tuple[str, bytes, str]]) -> list[dict[str, Any]]:
    manifest: list[dict[str, Any]] = []
    for filename, content, content_type in files:
        relative_path = _safe_relative_path(filename)
        safe_filename = _safe_filename(filename)
        manifest.append(
            {
                "filename": safe_filename,
                "relative_path": relative_path,
                "normalized_filename": _normalized_filename(safe_filename),
                "normalized_relative_path": relative_path.casefold(),
                "sha256": hashlib.sha256(content).hexdigest(),
                "size_bytes": len(content),
                "content_type": content_type or "application/octet-stream",
            }
        )
    return manifest


def validate_import_file_manifest_unique(
    db: Session,
    payload: ImportTaskCreate,
    manifest: list[dict[str, Any]],
    *,
    artifact_store: ArtifactStore | None = None,
    current_job_id: str | None = None,
) -> None:
    if not manifest:
        return
    project = _resolve_project(db, payload.project_id)
    conflicts = [
        *_incoming_manifest_conflicts(manifest),
        *_existing_manifest_conflicts(
            db,
            payload,
            manifest,
            project=project,
            artifact_store=artifact_store,
            current_job_id=current_job_id,
        ),
    ]
    if conflicts:
        raise DuplicateImportImagesError(conflicts)


def _files_from_source_path(path: Path) -> list[tuple[str, bytes, str]]:
    candidates = [path]
    root = path if path.is_dir() else path.parent
    if path.is_dir():
        candidates = sorted(file for file in path.rglob("*") if file.suffix.lower() in DATASET_IMPORT_EXTENSIONS)
    files = []
    for file in candidates:
        if file.is_file():
            filename = file.relative_to(root).as_posix() if path.is_dir() else file.name
            files.append((filename, file.read_bytes(), _content_type(file)))
    return files


def _resolve_project(db: Session, project_id: str | None) -> Project | None:
    if not project_id:
        return None
    return db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))


def _cvat_project_id(project: Project | None) -> str | int | None:
    if project is None:
        return None
    external_id = str(project.external_id)
    return int(external_id) if external_id.isdigit() else None


def _finalize_imported_task(
    db: Session,
    task_external_id: str,
    assignee_user_id: str | None,
    task_payload: dict[str, Any],
    project: Project | None,
    import_manifest: list[dict[str, Any]],
) -> dict[str, str] | None:
    assignee = db.get(User, assignee_user_id) if assignee_user_id else None
    if assignee is not None and (assignee.status != "active" or assignee.role != "anotador"):
        assignee = None

    task = db.scalar(select(Task).where(Task.external_id == task_external_id))
    if task is None:
        task = Task(
            external_id=task_external_id,
            name=str(task_payload.get("name") or f"Task {task_external_id}"),
        )
    if project is not None:
        task.project_external_id = project.external_id
    task.name = str(task_payload.get("name") or task.name)
    task.status = str(task_payload.get("status") or task.status or "unknown")
    task.size = int(task_payload.get("size") or task.size or 0)
    task.raw = {
        **(task.raw or {}),
        "local_import_manifest": {
            "files": import_manifest,
            "source": "cvat-plus",
        },
    }

    if assignee is None:
        db.add(task)
        db.flush()
        return None

    assignee_payload = {
        "user_id": assignee.id,
        "name": assignee.name,
        "email": assignee.email,
        "role": assignee.role,
    }
    task.raw = {**(task.raw or {}), "local_assignee": assignee_payload}
    db.add(task)
    _ensure_project_membership(db, task, assignee, project)
    db.flush()
    return assignee_payload


def _ensure_project_membership(db: Session, task: Task, assignee: User, project: Project | None) -> None:
    if project is None and task.project_external_id:
        project = db.scalar(select(Project).where(Project.external_id == task.project_external_id))
    if project is None:
        return
    membership = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == assignee.id)
    )
    if membership is not None:
        return
    db.add(
        ProjectMember(
            project_id=project.id,
            user_id=assignee.id,
            role="anotador",
            raw={"source": "import_assignment", "task_external_id": task.external_id},
        )
    )


def _materialize_dataset_annotations(
    db: Session,
    client: CvatClient,
    *,
    task_external_id: str,
    payload: ImportTaskCreate,
    files: list[tuple[str, bytes, str]],
    media_files: list[tuple[str, bytes, str]],
) -> dict[str, Any]:
    yolo_files = _yolo_annotation_files(files)
    coco_files = [] if yolo_files else _coco_annotation_files(files)
    if yolo_files:
        format_name = "yolo"
    elif coco_files:
        format_name = "coco"
    else:
        return {"format": None, "imported": 0, "skipped": 0, "cvat_synced": False}

    task = db.scalar(select(Task).where(Task.external_id == task_external_id))
    if task is None:
        return {
            "format": format_name,
            "imported": 0,
            "skipped": 0,
            "cvat_synced": False,
            "error": "Task not found after import",
        }

    class_names = _dataset_class_names(files)
    parsed_items = (
        _parsed_yolo_items(yolo_files, class_names)
        if yolo_files
        else _parsed_coco_items(coco_files)
    )
    if not parsed_items:
        return {"format": format_name, "imported": 0, "skipped": 0, "cvat_synced": False}

    class_mapping = _class_mapping_by_source(payload.class_mappings)
    _ensure_dataset_labels(db, task, payload.labels, parsed_items, class_mapping)
    db.flush()

    frame_index = _dataset_frame_index(db, task_external_id, media_files)
    label_lookup = _label_lookup(db, task)
    cvat_job = _cvat_job_for_task(db, task_external_id)
    cvat_job_id = _external_cvat_job_id(cvat_job)
    cvat_shapes: list[dict[str, Any]] = []
    local_records: list[dict[str, Any]] = []
    skipped = 0

    for item in parsed_items:
        frame_info = frame_index.get(item["image_stem"])
        if frame_info is None:
            skipped += 1
            continue

        label_name, label_color = _target_label(item["source_name"], class_mapping)
        label = label_lookup.get(label_name.casefold())
        label_id = _label_raw_id(label)
        width = _float_value(frame_info.get("width")) or _float_value(item.get("image_width")) or 1.0
        height = _float_value(frame_info.get("height")) or _float_value(item.get("image_height")) or 1.0
        shape = _shape_from_dataset_item(item, width, height)
        if shape is None:
            skipped += 1
            continue

        record_payload = {
            **shape,
            "frame": int(frame_info["frame"]),
            "label_id": label_id,
            "label_name": label_name,
            "label_color": label_color or (label.color if label is not None else None),
            "source_name": item["source_name"],
            "source_class_id": item["class_id"],
            "source_file": item["filename"],
        }
        local_records.append(record_payload)
        if cvat_job_id and label_id is not None:
            cvat_shapes.append(
                {
                    "type": "rectangle",
                    "frame": record_payload["frame"],
                    "label_id": label_id,
                    "points": record_payload["points"],
                    "source": "manual",
                    "attributes": [],
                }
            )

    if not local_records:
        return {"format": format_name, "imported": 0, "skipped": skipped, "cvat_synced": False}

    cvat_error: str | None = None
    cvat_synced = False
    if cvat_job_id and len(cvat_shapes) == len(local_records):
        try:
            body: dict[str, Any] = {"tags": [], "shapes": cvat_shapes, "tracks": []}
            version = _cvat_annotation_version(client, cvat_job_id)
            if version is not None:
                body["version"] = version
            client.partial_update_job_annotations(cvat_job_id, "create", body)
            if cvat_job is not None:
                sync_job_annotations(db, client, cvat_job)
            cvat_synced = True
        except Exception as exc:
            cvat_error = str(exc)

    for index, record_payload in enumerate(local_records):
        external_id = _dataset_annotation_external_id(task_external_id, record_payload, index)
        row = db.scalar(select(AnnotationRecord).where(AnnotationRecord.external_id == external_id))
        if row is None:
            row = AnnotationRecord(
                external_id=external_id,
                cvat_job_id=cvat_job_id or f"local:{task_external_id}",
                annotation_type="shape",
                cvat_annotation_id=external_id.rsplit(":", 1)[-1],
            )
        raw = {
            "id": row.cvat_annotation_id,
            "type": "rectangle",
            "frame": record_payload["frame"],
            "label_id": record_payload["label_id"],
            "label_name": record_payload["label_name"],
            "label_color": record_payload["label_color"],
            "source": "dataset_import",
            "points": record_payload["points"],
            "attributes": [],
            "bbox_norm": record_payload["bbox_norm"],
            "points_norm": record_payload["points_norm"],
            "coordinate_space": "image-normalized",
            "origin": "dataset_import",
            "source_name": record_payload["source_name"],
            "source_class_id": record_payload["source_class_id"],
            "source_file": record_payload["source_file"],
            "cvat_synced": cvat_synced,
            "cvat_error": cvat_error,
        }
        row.cvat_job_id = cvat_job_id or f"local:{task_external_id}"
        row.task_external_id = task_external_id
        row.annotation_type = "shape"
        row.frame = record_payload["frame"]
        row.label_id = record_payload["label_id"]
        row.label_name = record_payload["label_name"]
        row.shape_type = "rectangle"
        row.source = "dataset_import"
        row.confidence = 1.0
        row.points = record_payload["points"]
        row.review_state = "pending"
        row.raw = raw
        db.add(row)

    return {
        "format": format_name,
        "imported": len(local_records),
        "skipped": skipped,
        "cvat_synced": cvat_synced,
        "cvat_job_id": cvat_job_id,
        "cvat_error": cvat_error,
    }


def _yolo_annotation_files(files: list[tuple[str, bytes, str]]) -> list[tuple[str, str]]:
    parsed: list[tuple[str, str]] = []
    for filename, content, _content_type in files:
        relative_path = _safe_relative_path(filename)
        if Path(relative_path).suffix.lower() != ".txt":
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if _parse_yolo_rows(text) or "/labels/" in f"/{relative_path.casefold()}":
            parsed.append((relative_path, text))
    return parsed


def _parsed_yolo_items(
    yolo_files: list[tuple[str, str]],
    class_names: dict[int, str],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for filename, text in yolo_files:
        image_stem = Path(_safe_filename(filename)).stem.casefold()
        for row_index, row in enumerate(_parse_yolo_rows(text)):
            class_id = int(row["class_id"])
            items.append(
                {
                    **row,
                    "filename": filename,
                    "row_index": row_index,
                    "image_stem": image_stem,
                    "source_name": class_names.get(class_id) or f"classe_{class_id}",
                    "format": "yolo",
                }
            )
    return items


def _coco_annotation_files(files: list[tuple[str, bytes, str]]) -> list[tuple[str, dict[str, Any]]]:
    parsed: list[tuple[str, dict[str, Any]]] = []
    for filename, content, _content_type in files:
        relative_path = _safe_relative_path(filename)
        if Path(relative_path).suffix.lower() != ".json":
            continue
        try:
            data = json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not _is_coco_annotation_payload(data):
            continue
        parsed.append((relative_path, data))
    return parsed


def _is_coco_annotation_payload(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("images"), list)
        and isinstance(data.get("annotations"), list)
        and isinstance(data.get("categories"), list)
    )


def _parsed_coco_items(coco_files: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for filename, data in coco_files:
        categories = _coco_categories_by_id(data.get("categories"))
        images = _coco_images_by_id(data.get("images"))
        annotations = data.get("annotations") if isinstance(data.get("annotations"), list) else []
        for row_index, annotation in enumerate(annotations):
            if not isinstance(annotation, dict):
                continue
            image_id = _int_value(annotation.get("image_id"))
            category_id = _int_value(annotation.get("category_id"))
            image = images.get(image_id) if image_id is not None else None
            if image is None or category_id is None:
                continue
            image_filename = str(image.get("file_name") or image.get("name") or "").strip()
            if not image_filename:
                continue
            bbox = annotation.get("bbox")
            if not isinstance(bbox, list) or len(bbox) < 4:
                continue
            source_name = categories.get(category_id) or f"classe_{category_id}"
            items.append(
                {
                    "format": "coco",
                    "filename": filename,
                    "row_index": row_index,
                    "annotation_id": annotation.get("id"),
                    "image_id": image_id,
                    "image_filename": image_filename,
                    "image_stem": Path(_safe_filename(image_filename)).stem.casefold(),
                    "source_name": source_name,
                    "class_id": category_id,
                    "bbox": bbox[:4],
                    "image_width": _float_value(image.get("width")),
                    "image_height": _float_value(image.get("height")),
                }
            )
    return items


def _coco_categories_by_id(categories: Any) -> dict[int, str]:
    by_id: dict[int, str] = {}
    if not isinstance(categories, list):
        return by_id
    for category in categories:
        if not isinstance(category, dict):
            continue
        category_id = _int_value(category.get("id"))
        name = str(category.get("name") or "").strip()
        if category_id is not None and name:
            by_id[category_id] = name
    return by_id


def _coco_images_by_id(images: Any) -> dict[int, dict[str, Any]]:
    by_id: dict[int, dict[str, Any]] = {}
    if not isinstance(images, list):
        return by_id
    for image in images:
        if not isinstance(image, dict):
            continue
        image_id = _int_value(image.get("id"))
        if image_id is not None:
            by_id[image_id] = image
    return by_id


def _parse_yolo_rows(text: str) -> list[dict[str, float | int]]:
    rows: list[dict[str, float | int]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 5:
            continue
        try:
            class_id = int(float(parts[0]))
            cx, cy, width, height = [float(part) for part in parts[1:5]]
        except ValueError:
            continue
        if width <= 0 or height <= 0:
            continue
        rows.append({"class_id": class_id, "cx": cx, "cy": cy, "width": width, "height": height})
    return rows


def _dataset_class_names(files: list[tuple[str, bytes, str]]) -> dict[int, str]:
    explicit = _explicit_dataset_class_names(files)
    if explicit:
        return explicit
    if _looks_like_coco_dataset(files):
        return dict(enumerate(COCO80_CLASS_NAMES))
    return {}


def _explicit_dataset_class_names(files: list[tuple[str, bytes, str]]) -> dict[int, str]:
    for filename, content, _content_type in files:
        safe_name = _safe_filename(filename).casefold()
        if safe_name not in CLASS_FILE_NAMES and Path(safe_name).suffix.lower() not in {".yaml", ".yml", ".names"}:
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if safe_name.endswith((".yaml", ".yml")):
            names = _names_from_yaml(text)
        else:
            names = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
        if names:
            return {index: name for index, name in enumerate(names)}
    return {}


def _names_from_yaml(text: str) -> list[str]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return []
    if not isinstance(data, dict):
        return []
    names = data.get("names")
    if isinstance(names, list):
        return [str(name).strip() for name in names if str(name).strip()]
    if isinstance(names, dict):
        parsed: list[tuple[int, str]] = []
        for key, value in names.items():
            index = _int_value(key)
            name = str(value).strip()
            if index is not None and name:
                parsed.append((index, name))
        return [name for _index, name in sorted(parsed)]
    return []


def _looks_like_coco_dataset(files: list[tuple[str, bytes, str]]) -> bool:
    names = [f"/{_safe_relative_path(filename).casefold()}" for filename, _content, _content_type in files]
    if any("/coco128/" in name or "/coco/" in name for name in names):
        return True
    class_ids: set[int] = set()
    for filename, content, _content_type in files:
        if Path(_safe_filename(filename)).suffix.lower() != ".txt":
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for row in _parse_yolo_rows(text):
            class_ids.add(int(row["class_id"]))
            if len(class_ids) >= 25:
                break
        if len(class_ids) >= 25:
            break
    return bool(class_ids) and max(class_ids) < len(COCO80_CLASS_NAMES) and len(class_ids) >= 10


def _class_mapping_by_source(mappings: list[dict[str, Any]]) -> dict[str, dict[str, str | None]]:
    by_source: dict[str, dict[str, str | None]] = {}
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        source_name = str(mapping.get("source_name") or "").strip()
        target_name = str(mapping.get("target_name") or "").strip()
        if not source_name or not target_name:
            continue
        by_source[source_name.casefold()] = {
            "target_name": target_name,
            "color": str(mapping.get("color") or "").strip() or None,
        }
    return by_source


def _target_label(source_name: str, class_mapping: dict[str, dict[str, str | None]]) -> tuple[str, str | None]:
    mapped = class_mapping.get(source_name.casefold())
    if not mapped:
        return source_name, None
    return str(mapped.get("target_name") or source_name), mapped.get("color")


def _ensure_dataset_labels(
    db: Session,
    task: Task,
    payload_labels: list[dict[str, Any]],
    parsed_items: list[dict[str, Any]],
    class_mapping: dict[str, dict[str, str | None]],
) -> None:
    labels: dict[str, dict[str, str | None]] = {}
    for item in parsed_items:
        label_name, label_color = _target_label(str(item["source_name"]), class_mapping)
        labels[label_name.casefold()] = {"name": label_name, "color": label_color}
    for label in payload_labels:
        if not isinstance(label, dict):
            continue
        name = str(label.get("name") or label.get("label") or "").strip()
        if not name:
            continue
        labels[name.casefold()] = {"name": name, "color": str(label.get("color") or "").strip() or None}

    existing_task_labels = {
        str(item.get("name") or item.get("label") or "").casefold()
        for item in task.labels or []
        if isinstance(item, dict) and (item.get("name") or item.get("label"))
    }
    next_task_labels = list(task.labels or [])
    for payload in labels.values():
        name = str(payload["name"])
        color = payload.get("color") or _stable_label_color(name)
        _ensure_label_row(db, task, name, color)
        if name.casefold() not in existing_task_labels:
            existing_task_labels.add(name.casefold())
            next_task_labels.append(
                {
                    "name": name,
                    "color": color,
                    "raw": {
                        "origin": "dataset_import",
                        "manual": True,
                        "scope": "project" if task.project_external_id else "task",
                        "color": color,
                        "project_external_id": task.project_external_id,
                    },
                }
            )
    task.labels = next_task_labels
    db.add(task)


def _ensure_label_row(db: Session, task: Task, name: str, color: str) -> None:
    if task.project_external_id:
        project_label = db.scalar(
            select(CvatLabel).where(
                CvatLabel.project_external_id == task.project_external_id,
                CvatLabel.task_external_id.is_(None),
                CvatLabel.name == name,
            )
        )
        if project_label is None:
            digest = hashlib.sha1(f"{task.project_external_id}:{name}".encode()).hexdigest()[:16]
            project_label = CvatLabel(
                external_id=f"dataset:project:{task.project_external_id}:label:{digest}"[:128],
                name=name,
                project_external_id=task.project_external_id,
                task_external_id=None,
                attributes=[],
                raw={"origin": "dataset_import", "scope": "project", "color": color},
            )
        project_label.color = project_label.color or color
        db.add(project_label)

    task_label = db.scalar(
        select(CvatLabel).where(CvatLabel.task_external_id == task.external_id, CvatLabel.name == name)
    )
    if task_label is None:
        digest = hashlib.sha1(f"{task.external_id}:{name}".encode()).hexdigest()[:16]
        task_label = CvatLabel(
            external_id=f"dataset:task:{task.external_id}:label:{digest}"[:128],
            name=name,
            project_external_id=task.project_external_id,
            task_external_id=task.external_id,
            attributes=[],
            raw={"origin": "dataset_import", "scope": "task", "color": color},
        )
    task_label.color = task_label.color or color
    db.add(task_label)


def _label_lookup(db: Session, task: Task) -> dict[str, CvatLabel]:
    labels = list(db.scalars(select(CvatLabel).where(CvatLabel.task_external_id == task.external_id)).all())
    if task.project_external_id:
        labels.extend(
            list(
                db.scalars(
                    select(CvatLabel).where(
                        CvatLabel.task_external_id.is_(None),
                        CvatLabel.project_external_id == task.project_external_id,
                    )
                ).all()
            )
        )
    lookup: dict[str, CvatLabel] = {}
    for label in labels:
        lookup.setdefault(label.name.casefold(), label)
    return lookup


def _label_raw_id(label: CvatLabel | None) -> int | None:
    if label is None:
        return None
    return _int_value((label.raw or {}).get("id"))


def _dataset_frame_index(
    db: Session,
    task_external_id: str,
    media_files: list[tuple[str, bytes, str]],
) -> dict[str, dict[str, Any]]:
    dimensions_by_stem = _media_dimensions_by_stem(media_files)
    indexed: dict[str, dict[str, Any]] = {}
    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == task_external_id))
    frames = meta.frames if meta and isinstance(meta.frames, list) else []
    for frame_index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            continue
        filename = frame.get("name") or frame.get("filename") or frame.get("file_name") or frame.get("path")
        if not filename:
            continue
        stem = Path(_safe_filename(str(filename))).stem.casefold()
        dimensions = dimensions_by_stem.get(stem, {})
        indexed[stem] = {
            "frame": frame_index,
            "width": _float_value(frame.get("width")) or dimensions.get("width"),
            "height": _float_value(frame.get("height")) or dimensions.get("height"),
        }
    if indexed:
        return indexed

    for frame_index, (filename, _content, _content_type) in enumerate(
        sorted(media_files, key=lambda item: _safe_relative_path(item[0]).casefold())
    ):
        stem = Path(_safe_filename(filename)).stem.casefold()
        dimensions = dimensions_by_stem.get(stem, {})
        indexed[stem] = {
            "frame": frame_index,
            "width": dimensions.get("width"),
            "height": dimensions.get("height"),
        }
    return indexed


def _media_dimensions_by_stem(media_files: list[tuple[str, bytes, str]]) -> dict[str, dict[str, float]]:
    dimensions: dict[str, dict[str, float]] = {}
    for filename, content, content_type in media_files:
        if not is_import_image_file(filename, content_type):
            continue
        size = _image_dimensions(content)
        if size is None:
            continue
        stem = Path(_safe_filename(filename)).stem.casefold()
        dimensions.setdefault(stem, {"width": size[0], "height": size[1]})
    return dimensions


def _image_dimensions(content: bytes) -> tuple[float, float] | None:
    try:
        with Image.open(io.BytesIO(content)) as image:
            return float(image.width), float(image.height)
    except (UnidentifiedImageError, OSError):
        return None


def _shape_from_dataset_item(item: dict[str, Any], frame_width: float, frame_height: float) -> dict[str, Any] | None:
    if item.get("format") == "coco":
        return _shape_from_coco_item(item, frame_width, frame_height)
    return _shape_from_yolo_item(item, frame_width, frame_height)


def _shape_from_yolo_item(item: dict[str, Any], frame_width: float, frame_height: float) -> dict[str, Any] | None:
    cx = _float_value(item.get("cx"))
    cy = _float_value(item.get("cy"))
    width = _float_value(item.get("width"))
    height = _float_value(item.get("height"))
    if cx is None or cy is None or width is None or height is None:
        return None
    x1 = _clamp(cx - width / 2, 0.0, 1.0)
    y1 = _clamp(cy - height / 2, 0.0, 1.0)
    x2 = _clamp(cx + width / 2, 0.0, 1.0)
    y2 = _clamp(cy + height / 2, 0.0, 1.0)
    if x2 <= x1 or y2 <= y1:
        return None
    return {
        "points": [
            round(x1 * frame_width, 3),
            round(y1 * frame_height, 3),
            round(x2 * frame_width, 3),
            round(y2 * frame_height, 3),
        ],
        "points_norm": [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)],
        "bbox_norm": {
            "x": round(x1, 6),
            "y": round(y1, 6),
            "w": round(x2 - x1, 6),
            "h": round(y2 - y1, 6),
        },
    }


def _shape_from_coco_item(item: dict[str, Any], frame_width: float, frame_height: float) -> dict[str, Any] | None:
    bbox = item.get("bbox")
    if not isinstance(bbox, list) or len(bbox) < 4:
        return None
    x = _float_value(bbox[0])
    y = _float_value(bbox[1])
    width = _float_value(bbox[2])
    height = _float_value(bbox[3])
    if x is None or y is None or width is None or height is None:
        return None
    if width <= 0 or height <= 0:
        return None

    source_width = _float_value(item.get("image_width")) or frame_width
    source_height = _float_value(item.get("image_height")) or frame_height
    if source_width <= 0 or source_height <= 0:
        return None

    if max(abs(x), abs(y), abs(width), abs(height)) <= 1:
        x1 = _clamp(x, 0.0, 1.0)
        y1 = _clamp(y, 0.0, 1.0)
        x2 = _clamp(x + width, 0.0, 1.0)
        y2 = _clamp(y + height, 0.0, 1.0)
    else:
        x1 = _clamp(x / source_width, 0.0, 1.0)
        y1 = _clamp(y / source_height, 0.0, 1.0)
        x2 = _clamp((x + width) / source_width, 0.0, 1.0)
        y2 = _clamp((y + height) / source_height, 0.0, 1.0)

    if x2 <= x1 or y2 <= y1:
        return None
    return {
        "points": [
            round(x1 * frame_width, 3),
            round(y1 * frame_height, 3),
            round(x2 * frame_width, 3),
            round(y2 * frame_height, 3),
        ],
        "points_norm": [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)],
        "bbox_norm": {
            "x": round(x1, 6),
            "y": round(y1, 6),
            "w": round(x2 - x1, 6),
            "h": round(y2 - y1, 6),
        },
    }


def _dataset_annotation_external_id(task_external_id: str, record_payload: dict[str, Any], index: int) -> str:
    raw = (
        f"{task_external_id}:{record_payload.get('frame')}:{record_payload.get('source_file')}:"
        f"{record_payload.get('source_class_id')}:{record_payload.get('points_norm')}:{index}"
    )
    digest = hashlib.sha1(raw.encode()).hexdigest()[:20]
    return f"dataset:{task_external_id}:{record_payload.get('frame')}:{digest}"


def _cvat_job_for_task(db: Session, task_external_id: str) -> JobRecord | None:
    return db.scalar(
        select(JobRecord)
        .where(JobRecord.kind == "cvat_job", JobRecord.task_external_id == task_external_id)
        .order_by(JobRecord.updated_at.desc())
    )


def _external_cvat_job_id(job: JobRecord | None) -> str | None:
    if job is None:
        return None
    if job.external_id:
        return str(job.external_id).removeprefix("cvat:")
    raw_id = (job.raw or {}).get("id")
    return str(raw_id) if raw_id is not None else None


def _cvat_annotation_version(client: CvatClient, cvat_job_id: str | None) -> Any:
    if not cvat_job_id:
        return None
    try:
        annotations = client.retrieve_job_annotations(cvat_job_id)
        return annotations.get("version")
    except Exception:
        return None


def _stable_label_color(name: str) -> str:
    palette = [
        "#4f8cff",
        "#22c55e",
        "#a855f7",
        "#f59e0b",
        "#ef4444",
        "#14b8a6",
        "#eab308",
        "#ec4899",
    ]
    digest = hashlib.sha1(name.casefold().encode()).hexdigest()
    return palette[int(digest[:2], 16) % len(palette)]


def _float_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _path_size(path: Path) -> int | None:
    if not path.exists():
        return None
    if path.is_file():
        return path.stat().st_size
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".bmp":
        return "image/bmp"
    return "application/octet-stream"


def _incoming_manifest_conflicts(manifest: list[dict[str, Any]]) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    seen_names: dict[str, dict[str, Any]] = {}
    seen_hashes: dict[str, dict[str, Any]] = {}
    for item in manifest:
        name_key = str(item.get("normalized_filename") or "")
        sha256 = str(item.get("sha256") or "")
        if name_key and name_key in seen_names:
            conflicts.append(_conflict_payload(item, seen_names[name_key], reason="nome", scope="upload"))
        else:
            seen_names[name_key] = item
        if sha256 and sha256 in seen_hashes:
            conflicts.append(_conflict_payload(item, seen_hashes[sha256], reason="conteudo", scope="upload"))
        else:
            seen_hashes[sha256] = item
    return conflicts


def _existing_manifest_conflicts(
    db: Session,
    payload: ImportTaskCreate,
    manifest: list[dict[str, Any]],
    *,
    project: Project | None,
    artifact_store: ArtifactStore | None,
    current_job_id: str | None,
) -> list[dict[str, Any]]:
    existing = _existing_import_images(
        db,
        payload,
        project=project,
        artifact_store=artifact_store,
        current_job_id=current_job_id,
    )
    by_name = {
        str(item.get("normalized_filename")): item
        for item in existing
        if item.get("normalized_filename") and not item.get("sha256")
    }
    by_hash = {str(item.get("sha256")): item for item in existing if item.get("sha256")}
    conflicts: list[dict[str, Any]] = []
    for item in manifest:
        sha256 = str(item.get("sha256") or "")
        name_key = str(item.get("normalized_filename") or "")
        if sha256 and sha256 in by_hash:
            conflicts.append(_conflict_payload(item, by_hash[sha256], reason="conteudo", scope="projeto"))
        elif name_key and name_key in by_name:
            conflicts.append(_conflict_payload(item, by_name[name_key], reason="nome", scope="projeto"))
    return conflicts


def _existing_import_images(
    db: Session,
    payload: ImportTaskCreate,
    *,
    project: Project | None,
    artifact_store: ArtifactStore | None,
    current_job_id: str | None,
) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    tasks = list(db.scalars(_scoped_task_query(project)).all())
    import_jobs = list(db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all())
    upload_jobs_by_task = _upload_jobs_by_task(import_jobs)

    for task in tasks:
        task_images = _images_from_task(db, task)
        for job in upload_jobs_by_task.get(task.external_id, []):
            task_images.extend(_images_from_upload_artifacts(job, artifact_store))
        images.extend(_dedupe_existing_images(task_images))

    for job in import_jobs:
        if job.id == current_job_id or job.status not in ACTIVE_IMPORT_STATUSES:
            continue
        if (job.raw or {}).get("cvat_task_id"):
            continue
        raw_payload = (job.raw or {}).get("payload")
        if not isinstance(raw_payload, dict):
            continue
        other_payload = ImportTaskCreate.model_validate(raw_payload)
        if not _same_project_scope(other_payload.project_id, payload.project_id, project):
            continue
        images.extend(
            _dedupe_existing_images(
                _images_from_upload_artifacts(job, artifact_store),
                default_task_name=job.name,
            )
        )
    return images


def _scoped_task_query(project: Project | None):
    query = select(Task)
    if project is not None:
        return query.where(Task.project_external_id == project.external_id)
    return query.where(Task.project_external_id.is_(None))


def _upload_jobs_by_task(jobs: list[JobRecord]) -> dict[str, list[JobRecord]]:
    grouped: dict[str, list[JobRecord]] = {}
    for job in jobs:
        task_external_id = str((job.raw or {}).get("cvat_task_id") or "")
        if task_external_id:
            grouped.setdefault(task_external_id, []).append(job)
    return grouped


def _images_from_task(db: Session, task: Task) -> list[dict[str, Any]]:
    raw = task.raw or {}
    manifest = raw.get("local_import_manifest")
    images: list[dict[str, Any]] = []
    if isinstance(manifest, dict) and isinstance(manifest.get("files"), list):
        for item in manifest["files"]:
            if isinstance(item, dict):
                images.append(_existing_image_payload(item, task_name=task.name, task_external_id=task.external_id))

    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == task.external_id))
    if meta is not None:
        images.extend(_images_from_frame_meta(meta.frames, task))
    return images


def _images_from_frame_meta(frames: list[Any], task: Task) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        filename = frame.get("name") or frame.get("filename") or frame.get("file_name") or frame.get("path")
        if not filename:
            continue
        images.append(
            {
                "filename": _safe_filename(str(filename)),
                "normalized_filename": _normalized_filename(str(filename)),
                "task_name": task.name,
                "task_external_id": task.external_id,
            }
        )
    return images


def _images_from_upload_artifacts(
    job: JobRecord,
    artifact_store: ArtifactStore | None,
) -> list[dict[str, Any]]:
    uploads = (job.raw or {}).get("upload_artifacts")
    if not isinstance(uploads, list):
        return []
    task_external_id = str((job.raw or {}).get("cvat_task_id") or "") or None
    images: list[dict[str, Any]] = []
    for upload in uploads:
        if not isinstance(upload, dict):
            continue
        filename = str(upload.get("relative_path") or upload.get("filename") or "")
        content_type = str(upload.get("content_type") or "")
        if not is_import_image_file(filename, content_type):
            continue
        item = _existing_image_payload(
            upload,
            task_name=job.name,
            task_external_id=task_external_id,
        )
        if not item.get("sha256") and artifact_store is not None and upload.get("uri"):
            try:
                item["sha256"] = hashlib.sha256(artifact_store.get(str(upload["uri"])).content).hexdigest()
            except Exception:
                pass
        images.append(item)
    return images


def _dedupe_existing_images(
    images: list[dict[str, Any]],
    *,
    default_task_name: str | None = None,
) -> list[dict[str, Any]]:
    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for image in images:
        if default_task_name and not image.get("task_name"):
            image["task_name"] = default_task_name
        key = (str(image.get("normalized_filename") or ""), str(image.get("sha256") or ""))
        deduped[key] = image
    return list(deduped.values())


def _existing_image_payload(
    item: dict[str, Any],
    *,
    task_name: str | None,
    task_external_id: str | None,
) -> dict[str, Any]:
    filename = str(item.get("relative_path") or item.get("filename") or item.get("name") or "upload.bin")
    safe_filename = _safe_filename(filename)
    return {
        "filename": safe_filename,
        "relative_path": _safe_relative_path(filename),
        "normalized_filename": str(item.get("normalized_filename") or _normalized_filename(filename)),
        "sha256": item.get("sha256"),
        "size_bytes": item.get("size_bytes"),
        "content_type": item.get("content_type"),
        "task_name": task_name,
        "task_external_id": task_external_id,
    }


def _conflict_payload(
    incoming: dict[str, Any],
    existing: dict[str, Any],
    *,
    reason: str,
    scope: str,
) -> dict[str, Any]:
    return {
        "filename": incoming.get("filename"),
        "reason": reason,
        "scope": scope,
        "existing_filename": existing.get("filename"),
        "task_name": existing.get("task_name"),
        "task_external_id": existing.get("task_external_id"),
    }


def _same_project_scope(project_id: str | None, current_project_id: str | None, project: Project | None) -> bool:
    if project is None:
        return not project_id and not current_project_id
    valid_ids = {project.id, project.external_id}
    return str(project_id or "") in valid_ids and str(current_project_id or "") in valid_ids


def _safe_filename(filename: str) -> str:
    normalized = filename.replace("\\", "/").strip() or "upload.bin"
    return normalized.rsplit("/", 1)[-1] or "upload.bin"


def _safe_relative_path(filename: str) -> str:
    parts = []
    for part in filename.replace("\\", "/").split("/"):
        clean = part.strip()
        if not clean or clean in {".", ".."}:
            continue
        parts.append(clean)
    return "/".join(parts) or _safe_filename(filename)


def _normalized_filename(filename: str) -> str:
    return _safe_filename(filename).casefold()


def _duplicate_import_message(conflicts: list[dict[str, Any]]) -> str:
    visible = conflicts[:5]
    parts = []
    for conflict in visible:
        filename = str(conflict.get("filename") or "arquivo")
        reason = "mesmo conteudo" if conflict.get("reason") == "conteudo" else "mesmo nome"
        if conflict.get("scope") == "upload":
            parts.append(f"{filename} ({reason} no proprio upload)")
        else:
            task_name = str(conflict.get("task_name") or "outro lote")
            parts.append(f"{filename} ({reason} em {task_name})")
    hidden = len(conflicts) - len(visible)
    suffix = f" e mais {hidden}" if hidden > 0 else ""
    return f"Imagens duplicadas ou ja importadas neste projeto: {', '.join(parts)}{suffix}."


def _wait_for_cvat_request(client: CvatClient, request_id: str, settings: Settings) -> dict[str, Any]:
    last_payload: dict[str, Any] = {}
    terminal_statuses = {"finished", "completed", "succeeded", "failed", "error"}
    for _ in range(settings.cvat_request_poll_attempts):
        payload = client.retrieve_request(request_id)
        last_payload = payload if isinstance(payload, dict) else {}
        status = str(
            last_payload.get("status")
            or last_payload.get("state")
            or last_payload.get("result", {}).get("status")
            or ""
        ).lower()
        if status in terminal_statuses:
            if status in {"failed", "error"}:
                raise RuntimeError(f"CVAT request {request_id} failed: {last_payload}")
            return last_payload
        time.sleep(settings.cvat_request_poll_interval_seconds)
    raise TimeoutError(f"Timed out waiting for CVAT request {request_id}: {last_payload}")


def _request_id_from_payload(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("rq_id", "request_id", "id"):
        value = payload.get(key)
        if value:
            return str(value)
    result = payload.get("result")
    if isinstance(result, dict):
        return _request_id_from_payload(result)
    return None


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
