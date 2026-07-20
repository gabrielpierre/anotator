from typing import Any

from app.core.celery_app import celery_app
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models import DatasetRelease, PipelineRun, TrainingRun
from app.schemas import DatasetReleaseCreate, InferenceRunCreate
from app.services.artifacts import S3ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.imports import run_import_task_job
from app.services.inference import run_inference
from app.services.jobs import (
    JobCanceled,
    ensure_not_canceled,
    fail_job,
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

        def report_progress(progress: float, detail: str | None = None) -> None:
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
    db = SessionLocal()
    try:
        job = mark_job_running(db, job_id, "Preparing training run.")
        run_id = str((job.raw or {}).get("training_run_id"))
        run = db.get(TrainingRun, run_id)
        if run is None:
            raise LookupError(f"TrainingRun {run_id} not found")

        def report_progress(progress: float, detail: str | None = None) -> None:
            ensure_not_canceled(db, job_id)
            update_job_progress(db, job_id, progress, detail=detail)

        completed = run_training(
            db,
            run_id=run.id,
            settings=get_settings(),
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
        _mark_training_canceled(db, job_id)
        return {"status": "canceled"}
    except Exception as exc:
        fail_job(db, job_id, reason=str(exc))
        _mark_training_failed(db, job_id, str(exc))
        raise
    finally:
        db.close()


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
            run.metrics = {**(run.metrics or {}), "error": reason}
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
                    release.snapshot = {**(release.snapshot or {}), "error": "Pipeline job canceled"}
                    db.add(release)
            db.commit()


def _mark_pipeline_failed(db, job_id: str, reason: str) -> None:
    job = require_job(db, job_id)
    run_id = (job.raw or {}).get("pipeline_run_id")
    if run_id:
        run = db.get(PipelineRun, str(run_id))
        if run is not None:
            run.status = "failed"
            run.lineage = {**(run.lineage or {}), "error": reason}
            db.add(run)
            release_id = (run.lineage or {}).get("derived_release_id")
            if release_id:
                release = db.get(DatasetRelease, str(release_id))
                if release is not None and release.status not in {"ready", "failed", "canceled"}:
                    release.status = "failed"
                    release.snapshot = {**(release.snapshot or {}), "error": reason}
                    db.add(release)
            db.commit()


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
