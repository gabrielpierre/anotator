import io
import zipfile

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.database import Base
from app.models import AuditEvent, DatasetRelease, ModelVersion, TrainingRun
from app.services.artifacts import ArtifactBlob
from app.services.training import (
    ensure_training_device_available,
    mlflow_safe_metrics,
    normalize_training_device,
    prepare_training_dataset,
    run_training,
    training_history_from_results_csv_text,
)


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


def test_run_training_treats_resource_policy_auto_as_auto_device() -> None:
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
                "epochs": 1,
                "image_size": 320,
                "batch_size": 2,
                "device": "0,1",
                "workers": 0,
                "resource_policy": {"device": "auto"},
            },
        )
        db.add(run)
        db.commit()

        def fake_runner(context, progress_callback=None):
            assert context["payload"].device is None
            return {"metrics": {}, "artifacts": []}

        run_training(db, run_id=run.id, settings=Settings(), runner=fake_runner)


def test_normalize_training_device() -> None:
    assert normalize_training_device(None) is None
    assert normalize_training_device("") is None
    assert normalize_training_device("auto") is None
    assert normalize_training_device("CPU") == "cpu"
    assert normalize_training_device("0") == "0"
    assert normalize_training_device("0,1") == "0,1"


def test_training_device_validation_rejects_unavailable_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.training.available_training_device_ids", lambda: {"cpu"})

    with pytest.raises(ValueError, match="Device 0 nao esta disponivel"):
        ensure_training_device_available("0")


def test_prepare_training_dataset_rewrites_prepared_yaml_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    class FakeStore:
        def __init__(self, settings):
            pass

        def get(self, uri: str) -> ArtifactBlob:
            return ArtifactBlob(_prepared_yolo_zip(), "application/zip")

    monkeypatch.setattr("app.services.training.S3ArtifactStore", FakeStore)
    data_yaml = prepare_training_dataset(
        {
            "settings": Settings(),
            "dataset_snapshot": {
                "prepared_dataset": {
                    "artifact_uri": "s3://bucket/prepared.zip",
                }
            },
        },
        tmp_path,
    )

    assert data_yaml.parent == tmp_path / "prepared-dataset"
    assert f'path: "{data_yaml.parent.as_posix()}"' in data_yaml.read_text(encoding="utf-8")


def test_mlflow_safe_metrics_sanitizes_ultralytics_keys() -> None:
    metrics = mlflow_safe_metrics(
        {
            "metrics/mAP50-95(B)": 0.42,
            "metrics/precision(B)": 0.8,
            "bad(metric)": 1,
            "bad_metric_": 2,
            "ignored": float("nan"),
        }
    )

    assert metrics["metrics/mAP50-95_B_"] == 0.42
    assert metrics["metrics/precision_B_"] == 0.8
    assert metrics["bad_metric_"] == 1.0
    assert metrics["bad_metric__2"] == 2.0
    assert "ignored" not in metrics


def test_training_history_from_results_csv_text_normalizes_epoch_metrics() -> None:
    history = training_history_from_results_csv_text(
        "\n".join(
            [
                "epoch,time,train/box_loss,train/cls_loss,train/dfl_loss,"
                "metrics/precision(B),metrics/recall(B),metrics/mAP50(B),metrics/mAP50-95(B),lr/pg0",
                "1,5.4,2.0,3.0,1.0,0.25,0.50,0.75,0.40,0.001",
                "2,10.1,1.0,2.0,0.5,0.30,0.55,0.80,0.45,0.0009",
            ]
        )
    )

    assert history == [
        {
            "epoch": 1.0,
            "time": 5.4,
            "precision": 0.25,
            "recall": 0.5,
            "map50": 0.75,
            "map5095": 0.4,
            "learning_rate": 0.001,
            "train_box_loss": 2.0,
            "train_cls_loss": 3.0,
            "train_dfl_loss": 1.0,
            "loss": 6.0,
        },
        {
            "epoch": 2.0,
            "time": 10.1,
            "precision": 0.3,
            "recall": 0.55,
            "map50": 0.8,
            "map5095": 0.45,
            "learning_rate": 0.0009,
            "train_box_loss": 1.0,
            "train_cls_loss": 2.0,
            "train_dfl_loss": 0.5,
            "loss": 3.5,
        },
    ]


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


def _prepared_yolo_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "data.yaml",
            "\n".join(
                [
                    "path: .",
                    "train: images/train",
                    "val: images/val",
                    "names:",
                    '  0: "car"',
                    "",
                ]
            ),
        )
        archive.writestr("images/train/frame.jpg", b"image")
        archive.writestr("labels/train/frame.txt", "0 0.5 0.5 0.5 0.5\n")
    return buffer.getvalue()
