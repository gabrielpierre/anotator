from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AuditEvent, DatasetRelease, ModelVersion, TrainingRun
from app.schemas import TrainingRunCreate

ProgressCallback = Callable[[float, str | None], None]
TrainingRunner = Callable[[dict[str, Any], ProgressCallback | None], dict[str, Any]]


def run_training(
    db: Session,
    *,
    run_id: str,
    settings: Settings,
    runner: TrainingRunner | None = None,
    progress_callback: ProgressCallback | None = None,
) -> TrainingRun:
    run = db.get(TrainingRun, run_id)
    if run is None:
        raise ValueError(f"TrainingRun {run_id} not found")
    release = db.get(DatasetRelease, run.dataset_release_id)
    if release is None:
        raise ValueError(f"DatasetRelease {run.dataset_release_id} not found")
    if not release.immutable or release.status != "ready" or not release.artifact_uri:
        raise ValueError("Training requires an immutable ready DatasetRelease with exported artifacts")

    payload = _payload_from_run(run)
    train_context = {
        "run_id": run.id,
        "dataset_release": release,
        "artifact_uri": release.artifact_uri,
        "dataset_snapshot": release.snapshot or {},
        "payload": payload,
        "settings": settings,
    }

    _update_run(db, run, status="running", progress=5, metrics={"stage": "preparing"})
    _report(progress_callback, 5, "Preparing training dataset.")
    result = (runner or ultralytics_training_runner)(train_context, progress_callback)

    metrics = _normalize_metrics(result.get("metrics") or {})
    artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), list) else []
    run.mlflow_run_id = result.get("mlflow_run_id")
    run.status = "succeeded"
    run.progress = 100
    run.metrics = {**(run.metrics or {}), **metrics, "status": "completed"}
    run.artifacts = artifacts
    db.add(run)

    model_version = register_model_version(db, run, release, result)
    db.add(
        AuditEvent(
            actor="system",
            action="training_run_completed",
            target=run.id,
            payload={
                "dataset_release_id": release.id,
                "mlflow_run_id": run.mlflow_run_id,
                "model_version_id": model_version.id,
                "metrics": metrics,
                "artifacts": artifacts,
            },
        )
    )
    db.commit()
    db.refresh(run)
    _report(progress_callback, 100, "Training completed.")
    return run


def ultralytics_training_runner(
    context: dict[str, Any],
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    import mlflow
    from ultralytics import YOLO

    settings: Settings = context["settings"]
    payload: TrainingRunCreate = context["payload"]
    release: DatasetRelease = context["dataset_release"]

    mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
    mlflow.set_experiment("anotator-training")

    params = training_params(payload, release)
    with TemporaryDirectory(prefix="anotator-train-") as tmpdir:
        tmp_path = Path(tmpdir)
        data_yaml = prepare_training_dataset(context, tmp_path)
        train_args = {
            "data": str(data_yaml),
            "epochs": payload.epochs,
            "imgsz": payload.image_size,
            "batch": payload.batch_size,
            "workers": payload.workers,
            "seed": payload.seed,
            "project": str(tmp_path / "runs"),
            "name": f"train-{context['run_id']}",
            "exist_ok": True,
        }
        if payload.device:
            train_args["device"] = payload.device
        if payload.patience is not None:
            train_args["patience"] = payload.patience
        train_args.update(payload.config.get("ultralytics", {}))

        with mlflow.start_run(run_name=f"{payload.base_model}-{context['run_id']}") as mlflow_run:
            mlflow.log_params(params)
            mlflow.log_param("dataset_release_id", release.id)
            mlflow.log_param("dataset_release_name", release.name)
            _report(progress_callback, 20, "Starting Ultralytics training.")
            model = YOLO(payload.base_model)
            results = model.train(**train_args)
            _report(progress_callback, 90, "Collecting training metrics and artifacts.")
            metrics = extract_ultralytics_metrics(results)
            if metrics:
                mlflow.log_metrics(metrics)
            save_dir = getattr(results, "save_dir", None)
            artifacts: list[dict[str, Any]] = []
            if save_dir:
                save_path = Path(save_dir)
                mlflow.log_artifacts(str(save_path), artifact_path="ultralytics")
                artifacts = _artifact_rows(save_path, mlflow_run.info.artifact_uri)
            return {
                "mlflow_run_id": mlflow_run.info.run_id,
                "artifact_uri": mlflow_run.info.artifact_uri,
                "metrics": metrics,
                "artifacts": artifacts,
                "params": params,
            }


def prepare_training_dataset(context: dict[str, Any], tmp_path: Path) -> Path:
    snapshot = context["dataset_snapshot"] if isinstance(context.get("dataset_snapshot"), dict) else {}
    labels = snapshot.get("labels") if isinstance(snapshot.get("labels"), list) else []
    class_names = [str(label.get("name")) for label in labels if isinstance(label, dict) and label.get("name")]
    if not class_names:
        class_names = ["object"]

    dataset_dir = tmp_path / "dataset"
    for split in ("train", "val", "test"):
        (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)
    data_yaml = tmp_path / "data.yaml"
    data_yaml.write_text(
        "\n".join(
            [
                f"path: {dataset_dir.as_posix()}",
                "train: images/train",
                "val: images/val",
                "test: images/test",
                "names:",
                *[f"  {index}: {name}" for index, name in enumerate(class_names)],
                "",
            ]
        ),
        encoding="utf-8",
    )
    return data_yaml


def register_model_version(
    db: Session,
    run: TrainingRun,
    release: DatasetRelease,
    result: dict[str, Any],
) -> ModelVersion:
    name = str(run.config.get("model_name") or run.base_model.rsplit(".", 1)[0])
    version = str(run.config.get("model_version") or f"run-{run.id[:8]}")
    existing = db.query(ModelVersion).filter_by(name=name, version=version).one_or_none()
    model = existing or ModelVersion(name=name, version=version, family=run.model_family, base_model=run.base_model)
    model.family = run.model_family
    model.base_model = run.base_model
    model.training_run_id = run.id
    model.dataset_release_id = release.id
    model.mlflow_run_id = run.mlflow_run_id
    model.artifact_uri = result.get("artifact_uri") or _best_artifact_uri(result.get("artifacts") or [])
    model.metrics = _normalize_metrics(result.get("metrics") or run.metrics or {})
    model.params = result.get("params") or training_params(_payload_from_run(run), release)
    model.status = "registered"
    db.add(model)
    db.flush()
    return model


def training_params(payload: TrainingRunCreate, release: DatasetRelease) -> dict[str, Any]:
    return {
        "base_model": payload.base_model,
        "model_family": payload.model_family,
        "epochs": payload.epochs,
        "image_size": payload.image_size,
        "batch_size": payload.batch_size,
        "workers": payload.workers,
        "patience": payload.patience,
        "seed": payload.seed,
        "device": payload.device or "auto",
        "dataset_release_id": release.id,
        "dataset_artifact_uri": release.artifact_uri,
    }


def extract_ultralytics_metrics(results: Any) -> dict[str, float]:
    metrics: dict[str, float] = {}
    source = getattr(results, "results_dict", None)
    if isinstance(source, dict):
        for key, value in source.items():
            _put_float(metrics, key, value)
    for key in ("box.map", "box.map50", "box.map75", "fitness"):
        obj = results
        for part in key.split("."):
            obj = getattr(obj, part, None)
            if obj is None:
                break
        _put_float(metrics, key.replace(".", "_"), obj)
    return metrics


def _payload_from_run(run: TrainingRun) -> TrainingRunCreate:
    return TrainingRunCreate(
        dataset_release_id=run.dataset_release_id,
        base_model=run.base_model,
        model_family=run.model_family,
        epochs=int(run.config.get("epochs", 100)),
        image_size=int(run.config.get("image_size", run.config.get("imgsz", 640))),
        batch_size=int(run.config.get("batch_size", run.config.get("batch", 16))),
        device=run.config.get("device"),
        workers=int(run.config.get("workers", 8)),
        patience=run.config.get("patience", 30),
        seed=int(run.config.get("seed", 42)),
        config=run.config,
    )


def _update_run(
    db: Session,
    run: TrainingRun,
    *,
    status: str,
    progress: float,
    metrics: dict[str, Any] | None = None,
) -> None:
    run.status = status
    run.progress = progress
    if metrics:
        run.metrics = {**(run.metrics or {}), **metrics}
    db.add(run)
    db.commit()
    db.refresh(run)


def _normalize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in metrics.items():
        if isinstance(value, (int, float)):
            normalized[str(key)] = float(value)
        else:
            normalized[str(key)] = value
    return normalized


def _artifact_rows(path: Path, base_uri: str) -> list[dict[str, Any]]:
    rows = []
    for file in path.rglob("*"):
        if file.is_file():
            rows.append(
                {
                    "name": file.name,
                    "path": str(file.relative_to(path)),
                    "uri": f"{base_uri.rstrip('/')}/ultralytics/{file.relative_to(path).as_posix()}",
                    "size_bytes": file.stat().st_size,
                }
            )
    return rows


def _best_artifact_uri(artifacts: list[dict[str, Any]]) -> str | None:
    for artifact in artifacts:
        if artifact.get("name") == "best.pt":
            return str(artifact.get("uri"))
    return str(artifacts[0].get("uri")) if artifacts else None


def _put_float(metrics: dict[str, float], key: str, value: Any) -> None:
    try:
        metrics[key] = float(value)
    except (TypeError, ValueError):
        return


def _report(callback: ProgressCallback | None, progress: float, detail: str) -> None:
    if callback is not None:
        callback(progress, detail)
