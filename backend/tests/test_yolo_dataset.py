import io
import zipfile

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import AnnotationRecord, DatasetRelease
from app.services.artifacts import ArtifactBlob, ArtifactStore
from app.services.datasets import prepare_yolo_dataset


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


def _cvat_export_zip(count: int = 1, include_boxes: bool = True, label: str = "car") -> bytes:
    image = Image.new("RGB", (100, 80), color=(255, 255, 255))
    image_buffer = io.BytesIO()
    image.save(image_buffer, format="JPEG")
    box_row = f'    <box label="{label}" xtl="10" ytl="20" xbr="50" ybr="60" />' if include_boxes else ""
    image_rows = "\n".join(
        f"""  <image id="{index}" name="images/frame_{index:06d}.jpg" width="100" height="80">
{box_row}
  </image>"""
        for index in range(count)
    )
    xml = """<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <meta>
    <task>
      <labels>
        <label><name>%s</name></label>
      </labels>
    </task>
  </meta>
%s
</annotations>
""" % (label, image_rows)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("annotations.xml", xml)
        for index in range(count):
            archive.writestr(f"images/frame_{index:06d}.jpg", image_buffer.getvalue())
    return buffer.getvalue()
