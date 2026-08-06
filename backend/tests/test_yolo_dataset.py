import io
import zipfile

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import AnnotationRecord, DatasetRelease
from app.services.artifacts import ArtifactBlob, ArtifactStore
from app.services.datasets import prepare_yolo_dataset, preview_yolo_dataset


class MemoryArtifactStore(ArtifactStore):
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects
        self.puts: dict[str, bytes] = {}

    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        uri = f"s3://bucket/{key}"
        self.puts[uri] = content
        return uri

    def get(self, uri: str) -> ArtifactBlob:
        return ArtifactBlob(self.objects[uri], "application/zip", len(self.objects[uri]))


def test_prepare_yolo_dataset_materializes_images_labels_manifest_and_yaml() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip()})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": {"train": 1, "val": 0, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        output = store.puts[prepared["artifact_uri"]]

        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            names = set(archive.namelist())
            label_name = next(name for name in names if name.startswith("labels/train/"))
            label_text = archive.read(label_name).decode("utf-8")
            data_yaml = archive.read("data.yaml").decode("utf-8")
            manifest = archive.read("manifest.json").decode("utf-8")

        assert "data.yaml" in names
        assert any(name.startswith("images/train/") for name in names)
        assert label_text.startswith("0 ")
        assert '0: "car"' in data_yaml
        assert '"format": "yolo"' in manifest
        assert prepared["manifest"]["splits"]["train"] == 1


def test_prepare_yolo_dataset_balances_non_empty_validation_split() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip(count=9)})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        output = store.puts[prepared["artifact_uri"]]

        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            names = set(archive.namelist())

        assert prepared["manifest"]["splits"]["train"] > 0
        assert prepared["manifest"]["splits"]["val"] > 0
        assert prepared["manifest"]["splits"]["test"] > 0
        assert any(name.startswith("images/val/") for name in names)
        assert any(name.startswith("images/test/") for name in names)


def test_prepare_yolo_dataset_deduplicates_cvat_export_and_local_records() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip(label="car")})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            task_external_ids=["21"],
            snapshot={
                "splits": {"train": 1, "val": 0, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.add(
            AnnotationRecord(
                external_id="dataset:21:0:box",
                cvat_job_id="local:21",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="dataset-box",
                frame=0,
                label_name="car",
                shape_type="rectangle",
                source="dataset_import",
                confidence=1,
                points=[10, 20, 50, 60],
                review_state="pending",
                raw={"cvat_synced": True, "bbox_norm": {"x": 0.1, "y": 0.25, "w": 0.4, "h": 0.5}},
            )
        )
        db.add(
            AnnotationRecord(
                external_id="manual:21:0:box",
                cvat_job_id="local:21",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="manual-box",
                frame=0,
                label_name="car",
                shape_type="rectangle",
                source="cvat-plus",
                confidence=1,
                points=[10, 20, 50, 60],
                review_state="pending",
                raw={"cvat_synced": False, "bbox_norm": {"x": 0.1, "y": 0.25, "w": 0.4, "h": 0.5}},
            )
        )
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        output = store.puts[prepared["artifact_uri"]]

        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            label_name = next(name for name in archive.namelist() if name.startswith("labels/train/"))
            label_lines = [line for line in archive.read(label_name).decode("utf-8").splitlines() if line]

        assert label_lines == ["0 0.300000 0.500000 0.400000 0.500000"]
        assert prepared["manifest"]["box_stats"]["xml_boxes_read"] == 1
        assert prepared["manifest"]["box_stats"]["local_boxes_read"] == 2
        assert prepared["manifest"]["box_stats"]["duplicate_boxes_removed"] == 1
        assert prepared["manifest"]["box_stats"]["excluded_boxes"] == 1
        assert prepared["manifest"]["box_stats"]["exported_boxes"] == 1
        assert prepared["manifest"]["health"]["warnings"][0]["code"] == "duplicate_boxes_removed"


def test_prepare_yolo_dataset_includes_local_annotations_when_cvat_export_is_empty() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip(include_boxes=False, label="tower")})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            task_external_ids=["21"],
            snapshot={
                "splits": {"train": 1, "val": 0, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.add(
            AnnotationRecord(
                external_id="manual:21:0:box",
                cvat_job_id="local:21",
                task_external_id="21",
                annotation_type="shape",
                cvat_annotation_id="box",
                frame=0,
                label_name="tower",
                shape_type="rectangle",
                source="cvat-plus",
                confidence=1,
                points=[10, 20, 50, 60],
                review_state="pending",
                raw={"bbox_norm": {"x": 0.1, "y": 0.25, "w": 0.4, "h": 0.5}},
            )
        )
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        output = store.puts[prepared["artifact_uri"]]

        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            label_name = next(name for name in archive.namelist() if name.startswith("labels/train/"))
            label_text = archive.read(label_name).decode("utf-8")
            data_yaml = archive.read("data.yaml").decode("utf-8")

        assert label_text.startswith("0 ")
        assert '0: "tower"' in data_yaml
        assert prepared["manifest"]["images"][0]["boxes"] == 1


def test_prepare_yolo_dataset_excludes_annotations_that_need_rework() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip(include_boxes=False, label="tower")})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            task_external_ids=["21"],
            snapshot={
                "splits": {"train": 1, "val": 0, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        for index, state in enumerate(["accepted", "needs_annotation", "rejected", "replaced_by_manual"]):
            db.add(
                AnnotationRecord(
                    external_id=f"manual:21:0:{state}",
                    cvat_job_id="local:21",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=f"box-{index}",
                    frame=0,
                    label_name="tower",
                    shape_type="rectangle",
                    source="cvat-plus",
                    confidence=1,
                    points=[10 + index, 20, 50 + index, 60],
                    review_state=state,
                    raw={"cvat_synced": False},
                )
            )
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        output = store.puts[prepared["artifact_uri"]]

        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            label_name = next(name for name in archive.namelist() if name.startswith("labels/train/"))
            label_lines = [line for line in archive.read(label_name).decode("utf-8").splitlines() if line]

        assert len(label_lines) == 1
        assert prepared["manifest"]["box_stats"]["exported_boxes"] == 1


def test_prepare_yolo_dataset_distributes_positive_local_annotations_across_splits() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    store = MemoryArtifactStore({source_uri: _cvat_export_zip(count=27, include_boxes=False, label="tower")})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            task_external_ids=["21"],
            snapshot={
                "splits": {"train": 0.8, "val": 0.1, "test": 0.1},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        for frame in range(9):
            db.add(
                AnnotationRecord(
                    external_id=f"manual:21:{frame}:box",
                    cvat_job_id="local:21",
                    task_external_id="21",
                    annotation_type="shape",
                    cvat_annotation_id=f"box-{frame}",
                    frame=frame,
                    label_name="tower",
                    shape_type="rectangle",
                    source="cvat-plus",
                    confidence=1,
                    points=[10, 20, 50, 60],
                    review_state="pending",
                    raw={},
                )
            )
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        positive_by_split = {"train": 0, "val": 0, "test": 0}
        for image in prepared["manifest"]["images"]:
            if image["boxes"]:
                positive_by_split[image["split"]] += 1

        assert positive_by_split["train"] > 0
        assert positive_by_split["val"] > 0
        assert positive_by_split["test"] > 0


def test_prepare_yolo_dataset_balances_rare_classes_best_effort() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    specs = [
        {"name": "images/rare_0.jpg", "boxes": [{"label": "rare"}]},
        {"name": "images/rare_1.jpg", "boxes": [{"label": "rare"}]},
        *[
            {"name": f"images/common_{index}.jpg", "boxes": [{"label": "common"}]}
            for index in range(8)
        ],
    ]
    store = MemoryArtifactStore({source_uri: _cvat_export_zip_with_images(specs)})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": {
                    "train": 0.6,
                    "val": 0.2,
                    "test": 0.2,
                    "strategy": "class_balanced_best_effort",
                    "seed": 7,
                    "min_per_class_train": 1,
                    "min_per_class_val": 1,
                },
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        prepared = prepare_yolo_dataset(db, release_id=release.id, artifact_store=store)
        distribution = {row["name"]: row for row in prepared["manifest"]["class_distribution"]}

        assert distribution["rare"]["train"] >= 1
        assert distribution["rare"]["val"] >= 1
        assert prepared["manifest"]["split_policy"]["strategy"] == "class_balanced_best_effort"


def test_preview_yolo_dataset_split_is_reproducible_for_same_seed() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    specs = [
        {"name": f"images/frame_{index:06d}.jpg", "boxes": [{"label": "car"}]}
        for index in range(12)
    ]
    store = MemoryArtifactStore({source_uri: _cvat_export_zip_with_images(specs)})
    split_config = {"train": 0.5, "val": 0.25, "test": 0.25, "seed": 99}

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": split_config,
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        first = preview_yolo_dataset(db, release_id=release.id, artifact_store=store, split_config=split_config)
        second = preview_yolo_dataset(db, release_id=release.id, artifact_store=store, split_config=split_config)

        first_map = {row["name"]: row["split"] for row in first["manifest"]["images"]}
        second_map = {row["name"]: row["split"] for row in second["manifest"]["images"]}
        assert first_map == second_map


def test_preview_yolo_dataset_counts_classification_tags_in_split_distribution() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    specs = [{"name": f"images/frame_{index:06d}.jpg", "boxes": []} for index in range(4)]
    store = MemoryArtifactStore({source_uri: _cvat_export_zip_with_images(specs, labels=["daisy", "tulip"])})

    with session_factory() as db:
        db.add_all(
            [
                _classification_tag_record("21", 0, "daisy"),
                _classification_tag_record("21", 1, "daisy"),
                _classification_tag_record("21", 2, "tulip"),
                _classification_tag_record("21", 3, "tulip"),
            ]
        )
        release = DatasetRelease(
            name="release_classification",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": {"train": 0.5, "val": 0.5, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        prepared = preview_yolo_dataset(db, release_id=release.id, artifact_store=store)
        distribution = {row["name"]: row for row in prepared["manifest"]["class_distribution"]}
        warnings = prepared["manifest"]["health"]["warnings"]

        assert distribution["daisy"]["total"] == 2
        assert distribution["tulip"]["total"] == 2
        assert sum(row["annotations"] for row in prepared["manifest"]["images"]) == 4
        assert all(row["boxes"] == 0 for row in prepared["manifest"]["images"])
        assert not any(warning["code"] == "empty_images_included" for warning in warnings)


def test_preview_yolo_dataset_preserves_folder_groups_when_requested() -> None:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    source_uri = "s3://bucket/source.zip"
    specs = [
        {"name": f"video_a/frame_{index}.jpg", "boxes": [{"label": "car"}]}
        for index in range(3)
    ] + [
        {"name": f"video_b/frame_{index}.jpg", "boxes": [{"label": "car"}]}
        for index in range(3)
    ]
    store = MemoryArtifactStore({source_uri: _cvat_export_zip_with_images(specs)})

    with session_factory() as db:
        release = DatasetRelease(
            name="release_yolo",
            status="ready",
            artifact_uri=source_uri,
            immutable=True,
            snapshot={
                "splits": {"train": 0.5, "val": 0.5, "test": 0},
                "artifacts": [{"uri": source_uri, "task_external_id": "21"}],
            },
        )
        db.add(release)
        db.commit()
        db.refresh(release)

        prepared = preview_yolo_dataset(
            db,
            release_id=release.id,
            artifact_store=store,
            split_config={
                "train": 0.5,
                "val": 0.5,
                "test": 0,
                "preserve_groups": True,
                "group_by": "Pasta de origem",
            },
        )
        splits_by_folder: dict[str, set[str]] = {"video_a": set(), "video_b": set()}
        for row in prepared["manifest"]["images"]:
            folder = row["name"].split("/", 1)[0]
            splits_by_folder[folder].add(row["split"])

        assert splits_by_folder["video_a"] in ({"train"}, {"val"})
        assert splits_by_folder["video_b"] in ({"train"}, {"val"})


def _cvat_export_zip(count: int = 1, include_boxes: bool = True, label: str = "car") -> bytes:
    return _cvat_export_zip_with_images(
        [
            {
                "name": f"images/frame_{index:06d}.jpg",
                "boxes": [{"label": label}] if include_boxes else [],
            }
            for index in range(count)
        ],
        labels=[label],
    )


def _cvat_export_zip_with_images(specs: list[dict], labels: list[str] | None = None) -> bytes:
    image_buffer = io.BytesIO()
    image = Image.new("RGB", (100, 80), color=(255, 255, 255))
    image.save(image_buffer, format="JPEG")
    labels = labels or sorted({box.get("label", "object") for spec in specs for box in spec.get("boxes", [])}) or ["object"]
    image_rows = "\n".join(
        f"""  <image id="{index}" name="{spec['name']}" width="100" height="80">
{_box_rows(spec.get("boxes", []))}
  </image>"""
        for index, spec in enumerate(specs)
    )
    label_rows = "\n".join(f"        <label><name>{label}</name></label>" for label in labels)
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <meta>
    <task>
      <labels>
{label_rows}
      </labels>
    </task>
  </meta>
{image_rows}
</annotations>
"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("annotations.xml", xml)
        for spec in specs:
            archive.writestr(spec["name"], image_buffer.getvalue())
    return buffer.getvalue()


def _box_rows(boxes: list[dict]) -> str:
    return "\n".join(
        f'    <box label="{box.get("label", "object")}" xtl="{box.get("xtl", 10)}" ytl="{box.get("ytl", 20)}" '
        f'xbr="{box.get("xbr", 50)}" ybr="{box.get("ybr", 60)}" />'
        for box in boxes
    )


def _classification_tag_record(task_external_id: str, frame: int, label: str) -> AnnotationRecord:
    return AnnotationRecord(
        external_id=f"classification:{task_external_id}:{frame}:{label}",
        cvat_job_id=f"local:{task_external_id}",
        task_external_id=task_external_id,
        annotation_type="tag",
        cvat_annotation_id=f"tag:{frame}:{label}",
        frame=frame,
        label_name=label,
        shape_type=None,
        source="dataset_import",
        confidence=1.0,
        points=[],
        review_state="accepted",
        raw={"annotation_kind": "classification", "label_name": label},
    )
