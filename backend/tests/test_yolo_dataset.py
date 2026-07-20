import io
import zipfile

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import DatasetRelease
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


def _cvat_export_zip() -> bytes:
    image = Image.new("RGB", (100, 80), color=(255, 255, 255))
    image_buffer = io.BytesIO()
    image.save(image_buffer, format="JPEG")
    xml = """<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <meta>
    <task>
      <labels>
        <label><name>car</name></label>
      </labels>
    </task>
  </meta>
  <image id="0" name="images/frame_000001.jpg" width="100" height="80">
    <box label="car" xtl="10" ytl="20" xbr="50" ybr="60" />
  </image>
</annotations>
"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("annotations.xml", xml)
        archive.writestr("images/frame_000001.jpg", image_buffer.getvalue())
    return buffer.getvalue()
