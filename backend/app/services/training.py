import csv
import io
import math
import multiprocessing
import os
import queue
import time
import traceback
import zipfile
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AuditEvent, DatasetRelease, ModelVersion, Project, TrainingRun
from app.schemas import TrainingRunCreate
from app.services.artifacts import S3ArtifactStore
from app.services.compute import available_training_device_ids
from app.services.json_safety import sanitize_json_dict, sanitize_json_payload

ProgressCallback = Callable[[float, str | None, dict[str, Any] | None], None]
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
    _update_run(db, run, status="running", progress=5, metrics={"stage": "preparing"})
    _report(progress_callback, 5, "Preparing training dataset.")
    if runner is None:
        release = ensure_prepared_training_dataset(db, release, settings)

    train_context = {
        "run_id": run.id,
        "dataset_release": release,
        "artifact_uri": release.artifact_uri,
        "dataset_snapshot": release.snapshot or {},
        "payload": payload,
        "settings": settings,
    }
    default_runner = isolated_ultralytics_training_runner if settings.training_isolate_process else ultralytics_training_runner
    result = (runner or default_runner)(train_context, progress_callback)

    metrics = _normalize_metrics(result.get("metrics") or {})
    artifacts = sanitize_json_payload(result.get("artifacts")) if isinstance(result.get("artifacts"), list) else []
    run.mlflow_run_id = result.get("mlflow_run_id")
    run.status = "succeeded"
    run.progress = 100
    run.metrics = sanitize_json_dict({**(run.metrics or {}), **metrics, "stage": "completed", "status": "completed"})
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
        device = normalize_training_device(payload.device)
        if device:
            ensure_training_device_available(device)
            train_args["device"] = device
        if payload.patience is not None:
            train_args["patience"] = payload.patience
        train_args.update(payload.config.get("ultralytics", {}))
        params.update(_apply_training_resource_policy(train_args, payload, settings))
        _configure_cuda_memory_budget(payload.device, settings)

        with mlflow.start_run(run_name=f"{payload.base_model}-{context['run_id']}") as mlflow_run:
            mlflow.log_params(params)
            mlflow.log_param("dataset_release_id", release.id)
            mlflow.log_param("dataset_release_name", release.name)
            _report(
                progress_callback,
                20,
                "Starting Ultralytics training.",
                {"stage": "training", "mlflow_run_id": mlflow_run.info.run_id},
            )
            model = YOLO(payload.base_model)
            _attach_ultralytics_progress_callbacks(
                model,
                epochs=payload.epochs,
                progress_callback=progress_callback,
                mlflow_run_id=mlflow_run.info.run_id,
                artifact_base_uri=mlflow_run.info.artifact_uri,
            )
            results = model.train(**train_args)
            _report(progress_callback, 90, "Collecting training metrics and artifacts.")
            metrics = extract_ultralytics_metrics(results)
            if metrics:
                mlflow.log_metrics(mlflow_safe_metrics(metrics))
            save_dir = getattr(results, "save_dir", None)
            artifacts: list[dict[str, Any]] = []
            if save_dir:
                save_path = Path(save_dir)
                history = training_history_from_results_csv(save_path / "results.csv")
                if history:
                    metrics["history"] = history
                    metrics["epoch"] = int(history[-1]["epoch"])
                mlflow.log_artifacts(str(save_path), artifact_path="ultralytics")
                artifacts = _artifact_rows(save_path, mlflow_run.info.artifact_uri)
            return {
                "mlflow_run_id": mlflow_run.info.run_id,
                "artifact_uri": mlflow_run.info.artifact_uri,
                "metrics": metrics,
                "artifacts": artifacts,
                "params": params,
            }


def isolated_ultralytics_training_runner(
    context: dict[str, Any],
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    if multiprocessing.current_process().daemon:
        return ultralytics_training_runner(context, progress_callback)

    try:
        process_context = multiprocessing.get_context("fork")
    except ValueError:
        return ultralytics_training_runner(context, progress_callback)

    events: multiprocessing.Queue = process_context.Queue()
    process = process_context.Process(
        target=_ultralytics_training_process,
        args=(context, events),
        daemon=False,
        name=f"training-run-{str(context.get('run_id', 'unknown'))[:8]}",
    )
    process.start()

    last_progress = 20.0
    next_cancel_probe = time.monotonic() + 5
    result: dict[str, Any] | None = None
    child_error: str | None = None
    try:
        while process.is_alive() or not events.empty():
            try:
                event = events.get(timeout=1)
            except queue.Empty:
                if time.monotonic() >= next_cancel_probe:
                    _probe_training_cancel(progress_callback, last_progress)
                    next_cancel_probe = time.monotonic() + 5
                continue

            event_type = event.get("type") if isinstance(event, dict) else None
            if event_type == "progress":
                last_progress = float(event.get("progress") or last_progress)
                _report(progress_callback, last_progress, event.get("detail"), event.get("metrics"))
            elif event_type == "result":
                event_result = event.get("result")
                result = event_result if isinstance(event_result, dict) else {}
            elif event_type == "error":
                error = str(event.get("error") or "Training process failed.")
                child_traceback = str(event.get("traceback") or "").strip()
                child_error = f"{error}\n\n{child_traceback}" if child_traceback else error

        process.join(timeout=2)
        if child_error:
            raise RuntimeError(child_error)
        if result is not None:
            return result
        if process.exitcode not in (0, None):
            raise RuntimeError(f"Training process exited with code {process.exitcode}.")
        raise RuntimeError("Training process finished without returning a result.")
    except BaseException:
        if process.is_alive():
            process.terminate()
            process.join(timeout=10)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        raise
    finally:
        events.close()
        events.join_thread()


def _ultralytics_training_process(
    context: dict[str, Any],
    events: multiprocessing.Queue,
) -> None:
    def report(progress: float, detail: str | None = None, metrics: dict[str, Any] | None = None) -> None:
        events.put({"type": "progress", "progress": progress, "detail": detail, "metrics": metrics})

    try:
        result = ultralytics_training_runner(context, report)
        events.put({"type": "result", "result": result})
    except BaseException as exc:
        events.put({"type": "error", "error": str(exc), "traceback": traceback.format_exc()})
    finally:
        _release_cuda_memory()


def _probe_training_cancel(callback: ProgressCallback | None, progress: float) -> None:
    if callback is None:
        return
    try:
        callback(progress, None, None)
    except TypeError:
        callback(progress, None)  # type: ignore[misc]


def _release_cuda_memory() -> None:
    try:
        import gc

        gc.collect()
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        return


def _configure_cuda_memory_budget(device: str | None, settings: Settings) -> None:
    normalized_device = normalize_training_device(device)
    if _is_effective_cpu_device(normalized_device):
        return
    try:
        import torch

        if not torch.cuda.is_available():
            return
        fraction = min(0.95, max(0.25, float(settings.training_gpu_target_memory_fraction or 0.7)))
        torch.cuda.set_per_process_memory_fraction(fraction, device=_first_cuda_index(normalized_device))
    except Exception:
        return


def effective_training_workers(
    requested_workers: Any,
    device: Any,
    settings: Settings,
    *,
    in_daemon_process: bool | None = None,
    shared_memory_mb: int | None = None,
) -> tuple[int, dict[str, Any]]:
    try:
        workers = max(0, int(requested_workers or 0))
    except (TypeError, ValueError):
        workers = 0

    daemon_process = multiprocessing.current_process().daemon if in_daemon_process is None else in_daemon_process
    if daemon_process:
        return 0, {
            "dataloader_policy": "single_process",
            "requested_workers": workers,
            "effective_workers": 0,
            "reason": "daemon_process_cannot_spawn_dataloader_processes",
        }

    normalized_device = normalize_training_device(device)
    if _is_effective_cpu_device(normalized_device):
        max_workers = max(0, settings.training_cpu_max_workers)
        effective_workers = min(workers, max_workers)
        return effective_workers, {
            "dataloader_policy": "cpu_limited",
            "requested_workers": workers,
            "effective_workers": effective_workers,
            "max_workers": max_workers,
        }

    max_workers = max(0, settings.training_gpu_max_workers)
    shm_mb = _shared_memory_mb() if shared_memory_mb is None else shared_memory_mb
    min_shm_per_worker_mb = max(0, settings.training_min_shm_per_worker_mb)
    shm_limited_workers: int | None = None
    if shm_mb is not None and min_shm_per_worker_mb > 0:
        shm_limited_workers = max(0, int(shm_mb // min_shm_per_worker_mb))

    limits = [workers, max_workers]
    if shm_limited_workers is not None:
        limits.append(shm_limited_workers)
    effective_workers = min(limits)
    reduced = effective_workers < workers
    policy = {
        "dataloader_policy": "gpu_limited" if reduced else "as_requested",
        "requested_workers": workers,
        "effective_workers": effective_workers,
        "max_workers": max_workers,
    }
    if shm_mb is not None:
        policy["shared_memory_mb"] = shm_mb
    if shm_limited_workers is not None:
        policy["shm_limited_workers"] = shm_limited_workers
        policy["min_shm_per_worker_mb"] = min_shm_per_worker_mb
    if reduced:
        policy["reason"] = "gpu_worker_or_shared_memory_limit"
    return effective_workers, policy


def effective_training_batch_size(
    requested_batch_size: Any,
    base_model: Any,
    image_size: Any,
    device: Any,
    settings: Settings,
    *,
    gpu_memory_bytes: int | None = None,
) -> tuple[int, dict[str, Any]]:
    try:
        requested = max(1, int(requested_batch_size or 1))
    except (TypeError, ValueError):
        requested = 1

    normalized_device = normalize_training_device(device)
    if _is_effective_cpu_device(normalized_device):
        return requested, {
            "batch_policy": "as_requested",
            "requested_batch_size": requested,
            "effective_batch_size": requested,
            "device": "cpu",
        }

    configured_limit = max(1, int(settings.training_gpu_max_batch_size or 1))
    total_memory = gpu_memory_bytes if gpu_memory_bytes is not None else _cuda_device_total_memory_bytes(normalized_device)
    memory_limited_batch: int | None = None
    memory_gb: float | None = None
    per_sample_gb = _estimated_yolo_sample_memory_gb(base_model, image_size)
    target_fraction = min(0.95, max(0.25, float(settings.training_gpu_target_memory_fraction or 0.7)))
    if total_memory:
        memory_gb = total_memory / (1024**3)
        usable_gb = memory_gb * target_fraction
        memory_limited_batch = max(1, int(usable_gb // per_sample_gb))

    limits = [requested, configured_limit]
    if memory_limited_batch is not None:
        limits.append(memory_limited_batch)
    effective = max(1, min(limits))
    policy = {
        "batch_policy": "gpu_limited" if effective < requested else "as_requested",
        "requested_batch_size": requested,
        "effective_batch_size": effective,
        "configured_max_batch_size": configured_limit,
        "device": normalized_device or "auto",
        "model_scale": _yolo_model_scale(base_model),
        "image_size": _positive_int(image_size) or 640,
        "estimated_memory_per_sample_gb": round(per_sample_gb, 2),
        "target_memory_fraction": target_fraction,
    }
    if memory_gb is not None:
        policy["gpu_total_memory_gb"] = round(memory_gb, 2)
    if memory_limited_batch is not None:
        policy["memory_limited_batch_size"] = memory_limited_batch
    if effective < requested:
        policy["reason"] = "gpu_memory_or_configured_batch_limit"
    return effective, policy


def _is_effective_cpu_device(normalized_device: str | None) -> bool:
    if normalized_device == "cpu":
        return True
    if normalized_device is not None:
        return False
    try:
        return available_training_device_ids() == {"cpu"}
    except Exception:
        return False


def _cuda_device_total_memory_bytes(normalized_device: str | None) -> int | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        index = _first_cuda_index(normalized_device)
        return int(torch.cuda.get_device_properties(index).total_memory)
    except Exception:
        return None


def _first_cuda_index(normalized_device: str | None) -> int:
    if normalized_device:
        for part in str(normalized_device).split(","):
            try:
                return max(0, int(part.strip()))
            except (TypeError, ValueError):
                continue
    return 0


def _estimated_yolo_sample_memory_gb(base_model: Any, image_size: Any) -> float:
    scale = _yolo_model_scale(base_model)
    base_by_scale = {
        "n": 0.45,
        "s": 0.75,
        "m": 1.25,
        "l": 1.85,
        "x": 2.6,
    }
    size = _positive_int(image_size) or 640
    image_factor = (size / 640) ** 2
    return max(0.25, base_by_scale.get(scale, 1.25) * image_factor)


def _yolo_model_scale(base_model: Any) -> str:
    stem = Path(str(base_model or "")).stem.lower().replace("-", "").replace("_", "")
    for scale in ("x", "l", "m", "s", "n"):
        if stem.endswith(scale):
            return scale
        if f"yolo11{scale}" in stem or f"yolov8{scale}" in stem:
            return scale
    return "m"


def _shared_memory_mb() -> int | None:
    shm_path = Path("/dev/shm")
    try:
        stat = os.statvfs(shm_path)
    except OSError:
        return None
    return int((stat.f_frsize * stat.f_blocks) / (1024 * 1024))


def _apply_training_resource_policy(
    train_args: dict[str, Any],
    payload: TrainingRunCreate,
    settings: Settings,
    *,
    in_daemon_process: bool | None = None,
) -> dict[str, Any]:
    device = normalize_training_device(payload.device)
    effective_workers, dataloader_policy = effective_training_workers(
        train_args.get("workers", payload.workers),
        device,
        settings,
        in_daemon_process=in_daemon_process,
    )
    train_args["workers"] = effective_workers

    effective_batch, batch_policy = effective_training_batch_size(
        train_args.get("batch", payload.batch_size),
        payload.base_model,
        train_args.get("imgsz", payload.image_size),
        device,
        settings,
    )
    train_args["batch"] = effective_batch

    flat_batch_policy = {
        "requested_batch_size": batch_policy["requested_batch_size"],
        "effective_batch_size": batch_policy["effective_batch_size"],
        "batch_policy": batch_policy["batch_policy"],
    }
    if "gpu_total_memory_gb" in batch_policy:
        flat_batch_policy["gpu_total_memory_gb"] = batch_policy["gpu_total_memory_gb"]

    if device != "cpu":
        return {**dataloader_policy, **flat_batch_policy}

    max_threads = max(1, settings.training_cpu_max_threads)
    os.environ.setdefault("OMP_NUM_THREADS", str(max_threads))
    os.environ.setdefault("MKL_NUM_THREADS", str(max_threads))
    try:
        import torch

        torch.set_num_threads(max_threads)
        try:
            torch.set_num_interop_threads(max(1, min(2, max_threads)))
        except RuntimeError:
            pass
    except Exception:
        pass
    return {
        "resource_policy": "cpu_limited",
        **dataloader_policy,
        **flat_batch_policy,
        "cpu_threads": max_threads,
    }


def prepare_training_dataset(context: dict[str, Any], tmp_path: Path) -> Path:
    snapshot = context["dataset_snapshot"] if isinstance(context.get("dataset_snapshot"), dict) else {}
    prepared = snapshot.get("prepared_dataset") if isinstance(snapshot.get("prepared_dataset"), dict) else {}
    prepared_uri = prepared.get("artifact_uri") if isinstance(prepared, dict) else None
    if prepared_uri:
        settings: Settings = context["settings"]
        blob = S3ArtifactStore(settings).get(str(prepared_uri))
        dataset_dir = tmp_path / "prepared-dataset"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(blob.content)) as archive:
            archive.extractall(dataset_dir)
        data_yaml = dataset_dir / "data.yaml"
        if not data_yaml.exists():
            matches = list(dataset_dir.rglob("data.yaml"))
            if matches:
                data_yaml = matches[0]
        if data_yaml.exists():
            _rewrite_data_yaml_path(data_yaml)
            return data_yaml

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
    model.params = sanitize_json_dict(
        {**(result.get("params") or training_params(_payload_from_run(run), release)), **_release_project_payload(db, release)}
    )
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
        "device": normalize_training_device(payload.device) or "auto",
        "dataset_release_id": release.id,
        "dataset_artifact_uri": release.artifact_uri,
    }


def _release_project_payload(db: Session, release: DatasetRelease) -> dict[str, str]:
    if not release.project_id:
        return {}
    project = db.get(Project, release.project_id)
    if project is None:
        return {}
    return {"project_id": project.id, "project_external_id": project.external_id}


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


def training_history_from_results_csv(path: Path) -> list[dict[str, float]]:
    if not path.exists():
        return []
    return training_history_from_results_csv_text(path.read_text(encoding="utf-8"))


def training_history_from_results_csv_text(content: str) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    reader = csv.DictReader(io.StringIO(content))
    for raw_row in reader:
        source = {str(key).strip(): value for key, value in raw_row.items() if key is not None}
        row: dict[str, float] = {}
        _put_alias(row, "epoch", source, "epoch")
        _put_alias(row, "time", source, "time")
        _put_alias(row, "precision", source, "metrics/precision(B)", "precision")
        _put_alias(row, "recall", source, "metrics/recall(B)", "recall")
        _put_alias(row, "map50", source, "metrics/mAP50(B)", "map50", "mAP50")
        _put_alias(row, "map5095", source, "metrics/mAP50-95(B)", "map5095", "mAP50-95")
        _put_alias(row, "learning_rate", source, "lr/pg0", "lr/pg1", "lr/pg2")
        _put_float(row, "train_box_loss", source.get("train/box_loss"))
        _put_float(row, "train_cls_loss", source.get("train/cls_loss"))
        _put_float(row, "train_dfl_loss", source.get("train/dfl_loss"))
        _put_float(row, "val_box_loss", source.get("val/box_loss"))
        _put_float(row, "val_cls_loss", source.get("val/cls_loss"))
        _put_float(row, "val_dfl_loss", source.get("val/dfl_loss"))
        train_losses = [row.get("train_box_loss"), row.get("train_cls_loss"), row.get("train_dfl_loss")]
        if all(value is not None for value in train_losses):
            row["loss"] = float(sum(value for value in train_losses if value is not None))
        if "epoch" in row:
            rows.append(row)
    return rows


def _attach_ultralytics_progress_callbacks(
    model: Any,
    *,
    epochs: int,
    progress_callback: ProgressCallback | None,
    mlflow_run_id: str | None,
    artifact_base_uri: str | None,
) -> None:
    history: list[dict[str, float]] = []
    visual_artifact_state: dict[str, str] = {}
    visual_artifact_rows: dict[str, dict[str, Any]] = {}

    def enable_live_validation_plots(validator: Any) -> None:
        # Ultralytics disables validation plots during normal epoch validation and
        # only enables them near early stopping or at final validation. The UI
        # expects validation examples and confusion matrices while training runs.
        args = getattr(validator, "args", None)
        if args is not None:
            try:
                args.plots = True
            except AttributeError:
                pass

    def report_epoch(trainer: Any) -> None:
        epoch = _trainer_epoch(trainer)
        progress = 20 + (min(epoch, max(epochs, 1)) / max(epochs, 1)) * 70
        metrics = _trainer_metrics(trainer)
        metrics.update({"stage": "training", "epoch": epoch, "epochs": epochs})
        if mlflow_run_id:
            metrics["mlflow_run_id"] = mlflow_run_id
        row = {"epoch": float(epoch)}
        row.update({key: value for key, value in metrics.items() if isinstance(value, (int, float))})
        history.append(row)
        metrics["history"] = history[-200:]
        save_dir = getattr(trainer, "save_dir", None)
        if save_dir and artifact_base_uri:
            visual_artifacts = _log_live_visual_artifacts(
                Path(save_dir),
                artifact_base_uri,
                visual_artifact_state,
                visual_artifact_rows,
            )
            if visual_artifacts:
                metrics["artifacts"] = visual_artifacts
        _report(progress_callback, progress, f"Epoch {epoch}/{epochs} completed.", metrics)

    try:
        model.add_callback("on_val_start", enable_live_validation_plots)
        model.add_callback("on_fit_epoch_end", report_epoch)
    except AttributeError:
        return


def _trainer_epoch(trainer: Any) -> int:
    epoch = getattr(trainer, "epoch", None)
    try:
        return max(int(epoch) + 1, 0)
    except (TypeError, ValueError):
        return 0


def _trainer_metrics(trainer: Any) -> dict[str, float]:
    metrics: dict[str, float] = {}
    source = getattr(trainer, "metrics", None)
    if isinstance(source, dict):
        for key, value in source.items():
            _put_float(metrics, str(key), value)
    _put_float(metrics, "learning_rate", _trainer_learning_rate(trainer))
    _put_loss_metrics(metrics, trainer)
    return metrics


def _log_live_visual_artifacts(
    save_dir: Path,
    artifact_base_uri: str,
    visual_artifact_state: dict[str, str],
    visual_artifact_rows: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if not save_dir.exists():
        return list(visual_artifact_rows.values())

    import mlflow

    for file in sorted(save_dir.rglob("*")):
        if not file.is_file() or not _is_training_visual_artifact(file):
            continue
        try:
            stat = file.stat()
        except OSError:
            continue
        relative_path = file.relative_to(save_dir).as_posix()
        state = f"{stat.st_size}:{stat.st_mtime_ns}"
        if visual_artifact_state.get(relative_path) != state:
            parent_path = file.parent.relative_to(save_dir).as_posix()
            artifact_path = "ultralytics" if parent_path == "." else f"ultralytics/{parent_path}"
            try:
                mlflow.log_artifact(str(file), artifact_path=artifact_path)
            except Exception:
                continue
            visual_artifact_state[relative_path] = state
            visual_artifact_rows[relative_path] = {
                "name": file.name,
                "path": relative_path,
                "uri": f"{artifact_base_uri.rstrip('/')}/ultralytics/{relative_path}",
                "size_bytes": stat.st_size,
            }
    return list(visual_artifact_rows.values())


def _is_training_visual_artifact(file: Path) -> bool:
    name = file.name.lower()
    if file.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
        return False
    if name.startswith("confusion_matrix"):
        return True
    return name.startswith("val_batch") and ("_pred" in name or "_labels" in name)


def _trainer_learning_rate(trainer: Any) -> Any:
    lr = getattr(trainer, "lr", None)
    if isinstance(lr, dict):
        values = [value for value in lr.values() if isinstance(value, (int, float))]
        return values[0] if values else None
    if isinstance(lr, (list, tuple)):
        values = [value for value in lr if isinstance(value, (int, float))]
        return values[0] if values else None
    return lr


def _put_loss_metrics(metrics: dict[str, float], trainer: Any) -> None:
    losses = getattr(trainer, "tloss", None)
    if losses is None:
        losses = getattr(trainer, "loss_items", None)
    names = getattr(trainer, "loss_names", None)
    if losses is None:
        return
    try:
        raw_values = losses.detach().cpu().tolist()
    except AttributeError:
        raw_values = losses
    if not isinstance(raw_values, (list, tuple)):
        return
    loss_names = list(names) if isinstance(names, (list, tuple)) else []
    for index, value in enumerate(raw_values):
        key = str(loss_names[index]) if index < len(loss_names) else f"loss_{index + 1}"
        _put_float(metrics, key, value)


def _put_alias(
    target: dict[str, float],
    key: str,
    source: dict[str, Any],
    *aliases: str,
) -> None:
    for alias in aliases:
        before = key in target
        _put_float(target, key, source.get(alias))
        if key in target and not before:
            return


def mlflow_safe_metrics(metrics: dict[str, Any]) -> dict[str, float]:
    safe: dict[str, float] = {}
    for key, value in metrics.items():
        try:
            metric_value = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(metric_value):
            continue
        metric_key = _mlflow_safe_metric_key(str(key))
        unique_key = metric_key
        suffix = 2
        while unique_key in safe:
            suffix_text = f"_{suffix}"
            unique_key = f"{metric_key[: 250 - len(suffix_text)]}{suffix_text}"
            suffix += 1
        safe[unique_key] = metric_value
    return safe


def _mlflow_safe_metric_key(key: str) -> str:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-. /:")
    cleaned = "".join(char if char in allowed else "_" for char in key.strip())
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    cleaned = cleaned.strip()
    return cleaned[:250] or "metric"


def _payload_from_run(run: TrainingRun) -> TrainingRunCreate:
    return TrainingRunCreate(
        dataset_release_id=run.dataset_release_id,
        base_model=run.base_model,
        model_family=run.model_family,
        epochs=int(run.config.get("epochs", 100)),
        image_size=int(run.config.get("image_size", run.config.get("imgsz", 640))),
        batch_size=int(run.config.get("batch_size", run.config.get("batch", 16))),
        device=_device_from_run_config(run.config),
        workers=int(run.config.get("workers", 8)),
        patience=run.config.get("patience", 30),
        seed=int(run.config.get("seed", 42)),
        config=run.config,
    )


def _device_from_run_config(config: dict[str, Any]) -> str | None:
    resource_policy = config.get("resource_policy")
    if isinstance(resource_policy, dict) and "device" in resource_policy:
        return normalize_training_device(resource_policy.get("device"))
    return normalize_training_device(config.get("device"))


def normalize_training_device(device: Any) -> str | None:
    if device is None:
        return None
    value = str(device).strip()
    if not value or value.lower() == "auto":
        return None
    if value.lower().startswith("cpu"):
        return "cpu"
    return value


def ensure_training_device_available(device: Any) -> str | None:
    normalized = normalize_training_device(device)
    if normalized in {None, "cpu"}:
        return normalized

    available = available_training_device_ids()
    requested = {part.strip() for part in normalized.split(",") if part.strip()}
    if requested and requested.issubset(available):
        return normalized

    available_text = ", ".join(sorted(available)) or "nenhum"
    raise ValueError(
        f"Device {normalized} nao esta disponivel para treinamento. "
        f"Dispositivos disponiveis: {available_text}."
    )


def ensure_prepared_training_dataset(
    db: Session,
    release: DatasetRelease,
    settings: Settings,
) -> DatasetRelease:
    snapshot = release.snapshot if isinstance(release.snapshot, dict) else {}
    prepared = snapshot.get("prepared_dataset") if isinstance(snapshot.get("prepared_dataset"), dict) else {}
    if _prepared_dataset_usable_for_training(prepared):
        return release

    from app.services.datasets import prepare_yolo_dataset

    prepare_yolo_dataset(db, release_id=release.id, artifact_store=S3ArtifactStore(settings))
    refreshed = db.get(DatasetRelease, release.id)
    return refreshed or release


def _prepared_dataset_usable_for_training(prepared: dict[str, Any]) -> bool:
    if prepared.get("status") != "ready" or not prepared.get("artifact_uri"):
        return False
    manifest = prepared.get("manifest") if isinstance(prepared.get("manifest"), dict) else {}
    splits = manifest.get("splits") if isinstance(manifest.get("splits"), dict) else {}
    data_yaml = prepared.get("data_yaml") if isinstance(prepared.get("data_yaml"), dict) else {}
    train_count = _positive_int(splits.get("train"))
    val_count = _positive_int(splits.get("val"))
    val_path = str(data_yaml.get("val") or "")
    return train_count > 0 and (val_count > 0 or val_path == "images/train")


def _rewrite_data_yaml_path(data_yaml: Path) -> None:
    absolute_path = data_yaml.parent.as_posix().replace('"', '\\"')
    path_line = f'path: "{absolute_path}"'
    lines = data_yaml.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith("path:"):
            lines[index] = path_line
            break
    else:
        lines.insert(0, path_line)
    data_yaml.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _positive_int(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(parsed, 0)


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
        run.metrics = sanitize_json_dict({**(run.metrics or {}), **metrics})
    db.add(run)
    db.commit()
    db.refresh(run)


def _normalize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return sanitize_json_dict(metrics)


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
        parsed = float(value)
    except (TypeError, ValueError):
        return
    if not math.isfinite(parsed):
        return
    metrics[key] = parsed


def _report(
    callback: ProgressCallback | None,
    progress: float,
    detail: str,
    metrics: dict[str, Any] | None = None,
) -> None:
    if callback is not None:
        safe_metrics = sanitize_json_dict(metrics) if metrics is not None else None
        try:
            callback(progress, detail, safe_metrics)
        except TypeError:
            callback(progress, detail)  # type: ignore[misc]
