import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.database import Base
from app.models import AuditEvent, DatasetRelease, ModelVersion, TrainingRun
from app.services.training import run_training


def session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_run_training_registers_model_version_and_audit_event() -> None:
    factory = session_factory()

    with factory() as db:
        release = DatasetRelease(
            name="release_train",
            status="ready",
            artifact_uri="s3://bucket/dataset-releases/release_train.zip",
            immutable=True,
            snapshot={"labels": [{"name": "car"}]},
        )
        db.add(release)
        db.flush()
        run = TrainingRun(
            dataset_release_id=release.id,
            model_family="detection",
            base_model="yolo11n.pt",
            status="queued",
            progress=0,
            config={
                "model_name": "fleet-detector",
                "epochs": 3,
                "image_size": 320,
                "batch_size": 2,
                "workers": 0,
                "seed": 7,
                "patience": 1,
            },
        )
        db.add(run)
        db.commit()
        progress_events: list[tuple[float, str | None]] = []

        def fake_runner(context, progress_callback=None):
            assert context["artifact_uri"] == release.artifact_uri
            assert context["payload"].epochs == 3
            if progress_callback is not None:
                progress_callback(60, "fake epoch")
            return {
                "mlflow_run_id": "mlflow-1",
                "artifact_uri": "s3://bucket/mlflow/model",
                "metrics": {"metrics/mAP50-95(B)": 0.42, "epoch": 3},
                "artifacts": [{"name": "best.pt", "uri": "s3://bucket/best.pt", "size_bytes": 5}],
                "params": {"epochs": 3},
            }

        completed = run_training(
            db,
            run_id=run.id,
            settings=Settings(),
            runner=fake_runner,
            progress_callback=lambda progress, detail=None: progress_events.append((progress, detail)),
        )

        model_version = db.scalar(select(ModelVersion).where(ModelVersion.training_run_id == completed.id))
        audit_event = db.scalar(select(AuditEvent).where(AuditEvent.action == "training_run_completed"))

        assert completed.status == "succeeded"
        assert completed.progress == 100
        assert completed.mlflow_run_id == "mlflow-1"
        assert completed.metrics["metrics/mAP50-95(B)"] == 0.42
        assert completed.artifacts[0]["name"] == "best.pt"
        assert model_version is not None
        assert model_version.name == "fleet-detector"
        assert model_version.dataset_release_id == release.id
        assert model_version.mlflow_run_id == "mlflow-1"
        assert audit_event is not None
        assert progress_events[0][0] == 5
        assert progress_events[-1][0] == 100


def test_run_training_rejects_live_or_incomplete_dataset_release() -> None:
    factory = session_factory()

    with factory() as db:
        release = DatasetRelease(name="live_release", status="building", immutable=True)
        db.add(release)
        db.flush()
        run = TrainingRun(dataset_release_id=release.id, model_family="detection", base_model="yolo11n.pt")
        db.add(run)
        db.commit()

        with pytest.raises(ValueError, match="immutable ready DatasetRelease"):
            run_training(db, run_id=run.id, settings=Settings(), runner=lambda context, progress_callback=None: {})
