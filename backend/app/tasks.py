import threading
from typing import Any

from app.core.celery_app import celery_app
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import DatasetRelease, PipelineRun, TrainingRun, utcnow
from app.schemas import DatasetReleaseCreate, InferenceRunCreate
from app.services.artifacts import S3ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.imports import run_import_task_job
from app.services.inference import run_inference
from app.services.json_safety import sanitize_json_dict, sanitize_json_payload
from app.services.jobs import (
    JobCanceled,
    ensure_not_canceled,
    fail_job,
    heartbeat_job,
    mark_job_running,
    require_job,
    succeed_job,
    update_job_progress,
)
from app.services.pipelines import run_pipeline
from app.services.releases import build_dataset_release
from app.services.sync import CvatSyncService
from app.services.training import run_training


@celery_app.task(name="app.tasks.sync_cvat")
def sync_cvat_task(job_id: str | None = None) -> dict[str, Any]:
    db = SessionLocal()
    try:
        if job_id:
            mark_job_running(db, job_id, "Synchronizing CVAT.")
        result = CvatSyncService(db, CvatClient(get_settings()), job_id=job_id).sync_all()
        payload = result.model_dump(mode="json")
        if job_id:
            if result.job.status == "succeeded":
                succeed_job(db, job_id, detail=result.job.detail, raw_update={"sync_result": payload})
            else:
                fail_job(db, job_id, reason=result.job.detail or "CVAT sync failed", raw_update={"sync_result": payload})
        return payload
    except JobCanceled:
        return {"status": "canceled"}
    except Exception as exc:
        if job_id:
            fail_job(db, job_id, reason=str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name="app.tasks.import_task")
def import_task_job_task(job_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        settings = get_settings()
        job = run_import_task_job(
            db,
            job_id=job_id,
            settings=settings,
            artifact_store=S3ArtifactStore(settings),
            client=CvatClient(settings),
        )
        return {"status": job.status, "job_id": job.id, "cvat_task_id": (job.raw or {}).get("cvat_task_id")}
    except JobCanceled:
        return {"status": "canceled", "job_id": job_id}
    except Exception as exc:
        fail_job(db, job_id, reason=str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name="app.tasks.build_dataset_release")
def build_dataset_release_task(job_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job = mark_job_running(db, job_id, "Building dataset release.")
        release_id = str((job.raw or {}).get("dataset_release_id"))
        payload = DatasetReleaseCreate.model_validate((job.raw or {}).get("payload") or {})

        def report_progress(
            progress: float,
            detail: str | None = None,
            metrics: dict[str, Any] | None = None,
        ) -> None:
            del metrics
            ensure_not_canceled(db, job_id)
            update_job_progress(db, job_id, progress, detail=detail)

        settings = get_settings()
        release = build_dataset_release(
            db,
            release_id=release_id,
            payload=payload,
            settings=settings,
            client=CvatClient(settings),
            artifact_store=S3ArtifactStore(settings),
            progress_callback=report_progress,
        )
        if release.status == "ready":
            succeed_job(
                db,
                job_id,
                detail=f"Dataset release {release.name} is ready.",
                raw_update={"dataset_release_id": release.id, "artifact_uri": release.artifact_uri},
            )
        elif release.status == "canceled":
            return {"status": "canceled", "release_id": release.id}
        else:
            fail_job(
                db,
                job_id,
                reason=str((release.snapshot or {}).get("error") or "Dataset release failed"),
                raw_update={"dataset_release_id": release.id},
            )
        return {"status": release.status, "release_id": release.id, "artifact_uri": release.artifact_uri}
    except JobCanceled:
        return {"status": "canceled"}
    except Exception as exc:
        fail_job(db, job_id, reason=str(exc))
        raise
    finally:
        db.close()


@celery_app.task(name="app.tasks.training_run")
def training_run_task(job_id: str) -> dict[str, Any]:
    heartbeat_stop: threading.Event | None = None
    heartbeat_thread: threading.Thread | None = None
    db = SessionLocal()
    try:
        settings = get_settings()
        job = mark_job_running(db, job_id, "Preparing training run.")
        run_id = str((job.raw or {}).get("training_run_id"))
        run = db.get(TrainingRun, run_id)
        if run is None:
            raise LookupError(f"TrainingRun {run_id} not found")
        heartbeat_stop, heartbeat_thread = _start_training_heartbeat(
            job_id,
            run_id,
            interval_seconds=settings.training_heartbeat_seconds,
        )

        def report_progress(
            progress: float,
            detail: str | None = None,
            metrics: dict[str, Any] | None = None,
        ) -> None:
            try:
                ensure_not_canceled(db, job_id)
                update_job_progress(db, job_id, progress, detail=detail)
                live_run = db.get(TrainingRun, run_id)
                if live_run is not None:
                    existing_metrics = live_run.metrics if isinstance(live_run.metrics, dict) else {}
                    incoming_metrics = sanitize_json_dict(metrics)
                    incoming_artifacts = incoming_metrics.pop("artifacts", None)
                    logs = existing_metrics.get("logs") if isinstance(existing_metrics.get("logs"), list) else []
                    if detail:
                        incoming_metrics["logs"] = [
                            *logs,
                            _training_log_entry(progress, detail, incoming_metrics),
                        ][-500:]
                    if isinstance(incoming_artifacts, list):
                        live_run.artifacts = sanitize_json_payload(
                            _merge_training_artifacts(live_run.artifacts, incoming_artifacts)
                        )
                    if progress >= 100:
                        live_run.progress = 100
                    else:
                        live_run.status = "running"
                        live_run.progress = min(99, max(0, progress))
                    mlflow_run_id = incoming_metrics.get("mlflow_run_id")
                    if isinstance(mlflow_run_id, str) and mlflow_run_id:
                        live_run.mlflow_run_id = mlflow_run_id
                    live_run.metrics = sanitize_json_dict({**existing_metrics, **incoming_metrics})
                    db.add(live_run)
                    db.commit()
            except JobCanceled:
                db.rollback()
                raise
            except Exception as exc:
                db.rollback()
                raise RuntimeError(f"Failed to persist training progress: {exc}") from exc

        completed = run_training(
            db,
            run_id=run.id,
            settings=settings,
            progress_callback=report_progress,
        )
        succeed_job(
            db,
            job_id,
            detail=f"Training run {completed.id} completed.",
            raw_update={
                "training_run_id": completed.id,
                "mlflow_run_id": completed.mlflow_run_id,
                "metrics": completed.metrics,
                "artifacts": completed.artifacts,
            },
        )
        return {"status": completed.status, "training_run_id": completed.id, "mlflow_run_id": completed.mlflow_run_id}
    except JobCanceled:
        db.rollback()
        _mark_training_canceled(db, job_id)
        return {"status": "canceled"}
    except Exception as exc:
        db.rollback()
        fail_job(db, job_id, reason=str(exc))
        _mark_training_failed(db, job_id, str(exc))
        raise
    finally:
        if heartbeat_stop is not None:
            heartbeat_stop.set()
        if heartbeat_thread is not None:
            heartbeat_thread.join(timeout=2)
        db.close()


def _start_training_heartbeat(
    job_id: str,
    run_id: str,
    *,
    interval_seconds: int,
) -> tuple[threading.Event | None, threading.Thread | None]:
    if interval_seconds <= 0:
        return None, None

    stop = threading.Event()

    def _beat() -> None:
        while not stop.wait(interval_seconds):
            heartbeat_at = utcnow().isoformat()
            heartbeat_db = SessionLocal()
            try:
                job = heartbeat_job(
                    heartbeat_db,
                    job_id,
                    raw_update={"training_run_id": run_id},
                    metrics={"training_worker_alive": True},
                )
                if job.status in {"failed", "canceled", "succeeded"}:
                    return
                run = heartbeat_db.get(TrainingRun, run_id)
                if run is not None and run.status == "running":
                    existing_metrics = run.metrics if isinstance(run.metrics, dict) else {}
                    run.metrics = sanitize_json_dict({**existing_metrics, "heartbeat_at": heartbeat_at})
                    run.updated_at = utcnow()
                    heartbeat_db.add(run)
                    heartbeat_db.commit()
            except Exception:
                heartbeat_db.rollback()
            finally:
                heartbeat_db.close()

    thread = threading.Thread(target=_beat, name=f"training-heartbeat-{job_id[:8]}", daemon=True)
    thread.start()
    return stop, thread


@celery_app.task(name="app.tasks.pipeline_run")
def pipeline_run_task(job_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job = mark_job_running(db, job_id, "Starting pipeline.")
        run_id = str((job.raw or {}).get("pipeline_run_id"))
        run = db.get(PipelineRun, run_id)
        if run is None:
            raise LookupError(f"PipelineRun {run_id} not found")

        def report_progress(progress: float, detail: str | None = None) -> None:
            ensure_not_canceled(db, job_id)
            update_job_progress(db, job_id, progress, detail=detail)

        completed = run_pipeline(
            db,
            run_id=run.id,
            settings=get_settings(),
            artifact_store=S3ArtifactStore(get_settings()),
            progress_callback=report_progress,
        )
        succeed_job(
            db,
            job_id,
            detail=f"Pipeline {completed.name} completed.",
            raw_update={
                "pipeline_run_id": completed.id,
                "derived_release_id": (completed.lineage or {}).get("derived_release_id"),
                "derived_asset_count": (completed.lineage or {}).get("derived_asset_count"),
                "manifest_uri": (completed.lineage or {}).get("manifest_uri"),
            },
        )
        return {
            "status": completed.status,
            "pipeline_run_id": completed.id,
            "derived_release_id": (completed.lineage or {}).get("derived_release_id"),
        }
    except JobCanceled:
        _mark_pipeline_canceled(db, job_id)
        return {"status": "canceled"}
    except Exception as exc:
        fail_job(db, job_id, reason=str(exc))
        _mark_pipeline_failed(db, job_id, str(exc))
        raise
    finally:
        db.close()


def _mark_training_canceled(db, job_id: str) -> None:
    job = require_job(db, job_id)
    run_id = (job.raw or {}).get("training_run_id")
    if run_id:
        run = db.get(TrainingRun, str(run_id))
        if run is not None:
            run.status = "canceled"
            run.progress = job.progress
            db.add(run)
            db.commit()


def _mark_training_failed(db, job_id: str, reason: str) -> None:
    job = require_job(db, job_id)
    run_id = (job.raw or {}).get("training_run_id")
    if run_id:
        run = db.get(TrainingRun, str(run_id))
        if run is not None:
            run.status = "failed"
            existing_metrics = run.metrics if isinstance(run.metrics, dict) else {}
            logs = existing_metrics.get("logs") if isinstance(existing_metrics.get("logs"), list) else []
            run.metrics = sanitize_json_dict({
                **existing_metrics,
                "error": reason,
                "logs": [*logs, _training_log_entry(run.progress, f"Training failed: {reason}", {"level": "ERROR"})][-500:],
            })
            db.add(run)
            db.commit()


def _mark_pipeline_canceled(db, job_id: str) -> None:
    job = require_job(db, job_id)
    run_id = (job.raw or {}).get("pipeline_run_id")
    if run_id:
        run = db.get(PipelineRun, str(run_id))
        if run is not None:
            run.status = "canceled"
            run.progress = job.progress
            db.add(run)
            release_id = (run.lineage or {}).get("derived_release_id")
            if release_id:
                release = db.get(DatasetRelease, str(release_id))
                if release is not None and release.status not in {"ready", "failed", "canceled"}:
                    release.status = "canceled"
                    release.snapshot = sanitize_json_dict(
                        {**(release.snapshot or {}), "error": "Pipeline job canceled"}
                    )
                    db.add(release)
            db.commit()


def _mark_pipeline_failed(db, job_id: str, reason: str) -> None:
    job = require_job(db, job_id)
    run_id = (job.raw or {}).get("pipeline_run_id")
    if run_id:
        run = db.get(PipelineRun, str(run_id))
        if run is not None:
            run.status = "failed"
            run.lineage = sanitize_json_dict({**(run.lineage or {}), "error": reason})
            db.add(run)
            release_id = (run.lineage or {}).get("derived_release_id")
            if release_id:
                release = db.get(DatasetRelease, str(release_id))
                if release is not None and release.status not in {"ready", "failed", "canceled"}:
                    release.status = "failed"
                    release.snapshot = sanitize_json_dict({**(release.snapshot or {}), "error": reason})
                    db.add(release)
            db.commit()


def _training_log_entry(
    progress: float,
    detail: str,
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = metrics or {}
    epoch = _number_from_metrics(payload, "epoch")
    epochs = _number_from_metrics(payload, "epochs")
    parts = [_training_log_metric(payload, "mAP50-95", "map5095", "metrics/mAP50-95(B)", "box_map", "fitness")]
    parts.append(_training_log_metric(payload, "mAP50", "map50", "metrics/mAP50(B)", "box_map50"))
    parts.append(_training_log_metric(payload, "precision", "precision", "metrics/precision(B)"))
    parts.append(_training_log_metric(payload, "recall", "recall", "metrics/recall(B)"))
    parts.append(_training_log_metric(payload, "loss", "loss", "train_loss"))
    metric_summary = " ".join(part for part in parts if part)
    message = detail
    if metric_summary:
        message = f"{message} | {metric_summary}"

    return {
        "t": utcnow().isoformat(),
        "lvl": str(payload.get("level") or "INFO"),
        "msg": message,
        "progress": round(float(progress), 2),
        "epoch": epoch,
        "epochs": epochs,
    }


def _training_log_metric(payload: dict[str, Any], label: str, *keys: str) -> str | None:
    value = _number_from_metrics(payload, *keys)
    if value is None:
        return None
    return f"{label}={value:.4f}"


def _number_from_metrics(payload: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)):
            parsed = float(value)
            return parsed if parsed == parsed and parsed not in {float("inf"), float("-inf")} else None
        if isinstance(value, str):
            try:
                parsed = float(value)
                return parsed if parsed == parsed and parsed not in {float("inf"), float("-inf")} else None
            except ValueError:
                continue
    return None


def _merge_training_artifacts(existing: Any, incoming: list[Any]) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for source in (existing if isinstance(existing, list) else []):
        if isinstance(source, dict):
            key = str(source.get("path") or source.get("uri") or source.get("name") or len(rows))
            rows[key] = source
    for source in incoming:
        if isinstance(source, dict):
            key = str(source.get("path") or source.get("uri") or source.get("name") or len(rows))
            rows[key] = source
    return list(rows.values())


@celery_app.task(name="app.tasks.inference_run")
def inference_run_task(job_id: str) -> dict[str, Any]:
    db = SessionLocal()
    try:
        job = mark_job_running(db, job_id, "Preparing inference job.")
        payload = InferenceRunCreate.model_validate((job.raw or {}).get("payload") or {})

        def report_progress(progress: float, detail: str | None = None) -> None:
            ensure_not_canceled(db, job_id)
            update_job_progress(db, job_id, progress, detail=detail)

        suggestions = run_inference(
            db,
            payload=payload,
            settings=get_settings(),
            client=CvatClient(get_settings()),
            progress_callback=report_progress,
        )
        succeed_job(
            db,
            job_id,
            detail=f"Inference completed with {len(suggestions)} suggestions.",
            raw_update={"suggestions_created": len(suggestions)},
        )
        return {"status": "succeeded", "suggestions_created": len(suggestions)}
    except JobCanceled:
        return {"status": "canceled"}
    except Exception as exc:
        fail_job(db, job_id, reason=str(exc))
        raise
    finally:
        db.close()
