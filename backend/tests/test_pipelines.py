from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.database import Base
from app.models import AnnotationRecord, AuditEvent, DatasetRelease, DerivedAsset, PipelineDefinition, PipelineRun
from app.services.artifacts import ArtifactStore
from app.services.pipelines import run_pipeline


class FakeArtifactStore(ArtifactStore):
    def __init__(self) -> None:
        self.objects: list[dict] = []

    def put_bytes(self, key: str, content: bytes, content_type: str | None = None) -> str:
        self.objects.append({"key": key, "content": content, "content_type": content_type})
        return f"s3://bucket/{key}"


def session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_pipeline_materializes_classification_dataset_with_track_split_lock() -> None:
    factory = session_factory()
    store = FakeArtifactStore()

    with factory() as db:
        source_release = DatasetRelease(
            name="release_source",
            status="ready",
            task_external_ids=["21"],
            artifact_uri="s3://bucket/source.zip",
            immutable=True,
            snapshot={"splits": {"train": 0.8, "val": 0.1, "test": 0.1}},
        )
        db.add(source_release)
        db.flush()
        definition = PipelineDefinition(
            name="det-to-cls",
            version="v1",
            graph={"steps": ["detect", "filter", "crop", "classification", "review", "release"]},
            config={
                "source_release_id": source_release.id,
                "target_release_name": "crops_cls_test",
                "sample_policy": {"max_assets": 10},
                "splits": {"train": 0.7, "val": 0.2, "test": 0.1},
                "padding": {"mode": "relative", "value": 0.12},
                "model": {"id": "yolo11m", "version": "v18"},
            },
        )
        db.add(definition)
        db.flush()
        db.add_all(
            [
                AnnotationRecord(
                    external_id="cvat_job:99:track:501:frame:0",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="track",
                    cvat_annotation_id="501",
                    frame=0,
                    label_id=7,
                    label_name="car",
                    shape_type="rectangle",
                    source="manual",
                    confidence=0.93,
                    points=[10, 20, 110, 90],
                    review_state="accepted",
                ),
                AnnotationRecord(
                    external_id="cvat_job:99:track:501:frame:4",
                    cvat_job_id="99",
                    task_external_id="21",
                    annotation_type="track",
                    cvat_annotation_id="501",
                    frame=4,
                    label_id=7,
                    label_name="car",
                    shape_type="rectangle",
                    source="manual",
                    confidence=0.89,
                    points=[12, 22, 112, 92],
                    review_state="accepted",
                ),
            ]
        )
        run = PipelineRun(
            name="Pipeline crops classificacao",
            status="queued",
            definition={"definition_id": definition.id},
            lineage={"definition_id": definition.id},
        )
        db.add(run)
        db.commit()

        completed = run_pipeline(db, run_id=run.id, settings=Settings(), artifact_store=store)
        assets = list(db.scalars(select(DerivedAsset).where(DerivedAsset.pipeline_run_id == run.id)).all())
        derived_release = db.get(DatasetRelease, completed.lineage["derived_release_id"])

        assert completed.status == "succeeded"
        assert completed.progress == 100
        assert completed.lineage["derived_asset_count"] == 2
        assert derived_release is not None
        assert derived_release.status == "ready"
        assert derived_release.immutable is True
        assert derived_release.artifact_uri is not None
        assert derived_release.snapshot["source"] == "derived_pipeline"
        assert derived_release.snapshot["counts"]["derived_assets"] == 2
        assert len(assets) == 2
        assert {asset.split for asset in assets} == {assets[0].split}
        assert all(asset.source_track_id == "501" for asset in assets)
        assert all(asset.padding["value"] == 0.12 for asset in assets)
        assert any(obj["key"].endswith("manifest.json") for obj in store.objects)
        assert db.scalar(select(AuditEvent).where(AuditEvent.action == "pipeline_run_completed")) is not None


def test_pipeline_creates_empty_ready_release_when_no_annotations_match() -> None:
    factory = session_factory()
    store = FakeArtifactStore()

    with factory() as db:
        run = PipelineRun(
            name="Pipeline vazio",
            status="queued",
            definition={"task_external_ids": ["missing"], "target_release_name": "empty_cls"},
        )
        db.add(run)
        db.commit()

        completed = run_pipeline(db, run_id=run.id, settings=Settings(), artifact_store=store)
        derived_release = db.get(DatasetRelease, completed.lineage["derived_release_id"])

        assert completed.status == "succeeded"
        assert completed.lineage["derived_asset_count"] == 0
        assert derived_release is not None
        assert derived_release.status == "ready"
        assert derived_release.snapshot["counts"]["derived_assets"] == 0
