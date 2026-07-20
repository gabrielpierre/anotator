import time
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import (
    AnnotationRecord,
    AuditEvent,
    CvatLabel,
    DatasetRelease,
    JobRecord,
    Project,
    Task,
)
from app.schemas import DatasetReleaseCreate
from app.services.artifacts import ArtifactStore
from app.services.cvat_client import CvatClient
from app.services.jobs import JobCanceled


def create_dataset_release(
    db: Session,
    *,
    payload: DatasetReleaseCreate,
    settings: Settings,
    client: CvatClient,
    artifact_store: ArtifactStore,
) -> DatasetRelease:
    release = prepare_dataset_release(db, payload=payload, settings=settings)
    return build_dataset_release(
        db,
        release_id=release.id,
        payload=payload,
        settings=settings,
        client=client,
        artifact_store=artifact_store,
    )


def prepare_dataset_release(
    db: Session,
    *,
    payload: DatasetReleaseCreate,
    settings: Settings,
) -> DatasetRelease:
    task_external_ids = _resolve_task_ids(db, payload)
    if not task_external_ids:
        raise ValueError("DatasetRelease requires at least one synchronized CVAT task")
    project = _resolve_project(db, payload.project_id)
    _ensure_project_storage_quota(db, project, task_external_ids, payload)
    export_format = payload.export_format or settings.dataset_export_format
    release = DatasetRelease(
        name=payload.name,
        status="building",
        project_id=project.id if project is not None else payload.project_id,
        task_external_ids=task_external_ids,
        snapshot={
            **payload.snapshot,
            "export_format": export_format,
            "include_images": payload.include_images,
            "splits": payload.splits,
            "source": "cvat",
            "mutable_source_blocked": True,
        },
        immutable=True,
    )
    db.add(release)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="dataset_release_queued",
            target=release.id,
            payload={"release_id": release.id, "task_external_ids": task_external_ids},
        )
    )
    db.commit()
    db.refresh(release)
    return release


def build_dataset_release(
    db: Session,
    *,
    release_id: str,
    payload: DatasetReleaseCreate,
    settings: Settings,
    client: CvatClient,
    artifact_store: ArtifactStore,
    progress_callback: Callable[[float, str | None], None] | None = None,
) -> DatasetRelease:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise ValueError(f"DatasetRelease {release_id} not found")
    task_external_ids = list(release.task_external_ids or _resolve_task_ids(db, payload))
    export_format = payload.export_format or settings.dataset_export_format
    _report_progress(progress_callback, 5, "Preparing immutable dataset release.")

    try:
        snapshot = _build_snapshot(db, payload, task_external_ids, export_format)
        _report_progress(progress_callback, 15, "Snapshot created.")
        artifacts = []
        total_tasks = max(len(task_external_ids), 1)
        for index, task_id in enumerate(task_external_ids, start=1):
            artifacts.append(
                _export_task_artifact(
                    client=client,
                    artifact_store=artifact_store,
                    release=release,
                    task_external_id=task_id,
                    export_format=export_format,
                    include_images=payload.include_images,
                    settings=settings,
                )
            )
            export_progress = 15 + (70 * index / total_tasks)
            _report_progress(progress_callback, export_progress, f"Exported task {task_id}.")
        snapshot["artifacts"] = artifacts
        _report_progress(progress_callback, 90, "Collecting QA snapshot.")
        snapshot["qa"] = _quality_snapshot(db, client, task_external_ids)
        _record_project_storage_usage(db, release, artifacts)
        release.snapshot = {**release.snapshot, **snapshot}
        release.artifact_uri = artifacts[0]["uri"] if artifacts else None
        release.status = "ready"
        _report_progress(progress_callback, 98, "Release artifacts stored.")
        db.add(
            AuditEvent(
                actor="system",
                action="dataset_release_ready",
                target=release.id,
                payload={
                    "release_id": release.id,
                    "task_external_ids": task_external_ids,
                    "artifact_uris": [artifact["uri"] for artifact in artifacts],
                },
            )
        )
    except JobCanceled:
        release.status = "canceled"
        release.snapshot = {**release.snapshot, "error": "Release job canceled"}
        db.add(
            AuditEvent(
                actor="system",
                action="dataset_release_canceled",
                target=release.id,
                payload={"release_id": release.id, "task_external_ids": task_external_ids},
            )
        )
        db.add(release)
        db.commit()
        db.refresh(release)
        raise
    except Exception as exc:
        release.status = "failed"
        release.snapshot = {**release.snapshot, "error": str(exc)}
        db.add(
            AuditEvent(
                actor="system",
                action="dataset_release_failed",
                target=release.id,
                reason=str(exc),
                payload={"release_id": release.id, "task_external_ids": task_external_ids},
            )
        )

    db.add(release)
    db.commit()
    db.refresh(release)
    return release


def _resolve_task_ids(db: Session, payload: DatasetReleaseCreate) -> list[str]:
    if payload.task_external_ids:
        return payload.task_external_ids
    query = select(Task)
    if payload.project_id:
        project = db.get(Project, payload.project_id) or db.scalar(
            select(Project).where(Project.external_id == payload.project_id)
        )
        if project:
            query = query.where(Task.project_external_id == project.external_id)
    return [task.external_id for task in db.scalars(query.order_by(Task.created_at)).all()]


def _resolve_project(db: Session, project_id: str | None) -> Project | None:
    if project_id:
        return db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))
    projects = list(db.scalars(select(Project).order_by(Project.created_at)).all())
    return projects[0] if len(projects) == 1 else None


def _ensure_project_storage_quota(
    db: Session,
    project: Project | None,
    task_external_ids: list[str],
    payload: DatasetReleaseCreate,
) -> None:
    if project is None:
        return
    storage = project.raw.get("storage") if isinstance(project.raw, dict) else None
    if not isinstance(storage, dict) or storage.get("enforce_quota") is False:
        return
    quota_bytes = _int_value(storage.get("quota_bytes"))
    if not quota_bytes:
        quota_gb = _int_value(storage.get("quota_gb"))
        quota_bytes = quota_gb * 1024**3 if quota_gb else 0
    if not quota_bytes:
        return
    used_bytes = _int_value(storage.get("used_bytes")) or 0
    estimated_bytes = _estimate_release_bytes(db, task_external_ids, payload, storage)
    if used_bytes + estimated_bytes > quota_bytes:
        used_gb = used_bytes / 1024**3
        estimate_gb = estimated_bytes / 1024**3
        quota_gb = quota_bytes / 1024**3
        raise ValueError(
            "Dataset release exceeds project storage quota "
            f"({used_gb:.1f} GB used + {estimate_gb:.1f} GB estimated > {quota_gb:.1f} GB quota)"
        )


def _estimate_release_bytes(
    db: Session,
    task_external_ids: list[str],
    payload: DatasetReleaseCreate,
    storage: dict,
) -> int:
    snapshot_estimate = payload.snapshot.get("estimated_bytes") if isinstance(payload.snapshot, dict) else None
    estimate = _int_value(snapshot_estimate)
    if estimate is not None:
        return estimate
    tasks = list(db.scalars(select(Task).where(Task.external_id.in_(task_external_ids))).all())
    if not payload.include_images:
        return max(len(tasks), 1) * 1024**2
    average_image_bytes = _int_value(storage.get("average_image_bytes")) or 5 * 1024**2
    return sum(max(task.size, 0) for task in tasks) * average_image_bytes


def _record_project_storage_usage(db: Session, release: DatasetRelease, artifacts: list[dict]) -> None:
    if not release.project_id:
        return
    project = db.get(Project, release.project_id)
    if project is None or not isinstance(project.raw, dict):
        return
    storage = project.raw.get("storage")
    if not isinstance(storage, dict):
        return
    added_bytes = sum(_int_value(artifact.get("size_bytes")) or 0 for artifact in artifacts)
    used_bytes = (_int_value(storage.get("used_bytes")) or 0) + added_bytes
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    percent = round((used_bytes / quota_bytes) * 100, 2) if quota_bytes else 0
    project.raw = {
        **project.raw,
        "storage": {
            **storage,
            "used_bytes": used_bytes,
            "used_gb": round(used_bytes / 1024**3, 3),
            "used_percent": percent,
        },
    }
    db.add(project)


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _build_snapshot(
    db: Session,
    payload: DatasetReleaseCreate,
    task_external_ids: list[str],
    export_format: str,
) -> dict[str, Any]:
    tasks = list(db.scalars(select(Task).where(Task.external_id.in_(task_external_ids))).all())
    jobs = list(db.scalars(select(JobRecord).where(JobRecord.task_external_id.in_(task_external_ids))).all())
    labels = list(db.scalars(select(CvatLabel).where(CvatLabel.task_external_id.in_(task_external_ids))).all())
    if not labels:
        labels = list(db.scalars(select(CvatLabel)).all())
    annotation_count = db.scalar(
        select(func.count(AnnotationRecord.id)).where(AnnotationRecord.task_external_id.in_(task_external_ids))
    )
    return {
        "export_format": export_format,
        "include_images": payload.include_images,
        "splits": payload.splits,
        "tasks": [
            {
                "id": task.id,
                "external_id": task.external_id,
                "name": task.name,
                "status": task.status,
                "size": task.size,
                "project_external_id": task.project_external_id,
            }
            for task in tasks
        ],
        "jobs": [
            {
                "id": job.id,
                "external_id": job.external_id,
                "task_external_id": job.task_external_id,
                "status": job.status,
                "kind": job.kind,
                "raw_type": job.raw.get("type"),
                "raw_stage": job.raw.get("stage"),
                "raw_state": job.raw.get("state"),
            }
            for job in jobs
        ],
        "labels": [
            {
                "external_id": label.external_id,
                "name": label.name,
                "color": label.color,
                "task_external_id": label.task_external_id,
                "project_external_id": label.project_external_id,
                "raw": label.raw,
            }
            for label in labels
        ],
        "counts": {
            "tasks": len(tasks),
            "jobs": len(jobs),
            "labels": len(labels),
            "annotations": annotation_count or 0,
            "images": sum(task.size for task in tasks),
        },
    }


def _export_task_artifact(
    *,
    client: CvatClient,
    artifact_store: ArtifactStore,
    release: DatasetRelease,
    task_external_id: str,
    export_format: str,
    include_images: bool,
    settings: Settings,
) -> dict[str, Any]:
    filename = f"{release.name}_task_{task_external_id}.zip"
    request_payload = client.create_task_dataset_export(
        task_external_id,
        export_format=export_format,
        filename=filename,
        save_images=include_images,
    )
    result_url = _result_url_from_payload(request_payload)
    request_id = _request_id_from_payload(request_payload)
    request_status: dict[str, Any] = {}
    if request_id:
        request_status = _wait_for_request(client, request_id, settings)
        result_url = _result_url_from_payload(request_status) or result_url
    if not result_url:
        raise RuntimeError(f"CVAT export did not return a result URL for task {task_external_id}")

    binary = client.get_url_bytes(result_url)
    key = f"dataset-releases/{release.id}/task-{task_external_id}/{filename}"
    uri = artifact_store.put_bytes(key, binary.content, binary.content_type or "application/zip")
    return {
        "task_external_id": task_external_id,
        "format": export_format,
        "filename": filename,
        "uri": uri,
        "content_type": binary.content_type,
        "size_bytes": len(binary.content),
        "cvat_request_id": request_id,
        "cvat_request_status": request_status,
    }


def _quality_snapshot(db: Session, client: CvatClient, task_external_ids: list[str]) -> dict[str, Any]:
    gt_jobs = []
    quality_reports = []
    quality_errors = []
    for task_id in task_external_ids:
        jobs = list(db.scalars(select(JobRecord).where(JobRecord.task_external_id == task_id)).all())
        for job in jobs:
            raw_type = str(job.raw.get("type") or "").lower()
            if "ground" in raw_type or "truth" in raw_type:
                gt_jobs.append(
                    {
                        "external_id": job.external_id,
                        "task_external_id": job.task_external_id,
                        "status": job.status,
                        "stage": job.raw.get("stage"),
                        "state": job.raw.get("state"),
                        "configured": str(job.raw.get("stage")).lower() == "acceptance"
                        and str(job.raw.get("state")).lower() in {"completed", "done"},
                    }
                )
        try:
            for report in client.list_quality_reports(task_id=task_id):
                report_data = None
                report_id = report.get("id")
                if report_id is not None:
                    try:
                        report_data = client.retrieve_quality_report_data(report_id)
                    except Exception as exc:
                        quality_errors.append({"task_external_id": task_id, "report_id": report_id, "error": str(exc)})
                quality_reports.append(
                    {
                        "task_external_id": task_id,
                        "report": report,
                        "data": report_data,
                    }
                )
        except Exception as exc:
            quality_errors.append({"task_external_id": task_id, "error": str(exc)})
    return {
        "ground_truth_jobs": gt_jobs,
        "quality_reports": quality_reports,
        "quality_errors": quality_errors,
    }


def _wait_for_request(client: CvatClient, request_id: str, settings: Settings) -> dict[str, Any]:
    last_payload: dict[str, Any] = {}
    terminal_statuses = {"finished", "completed", "succeeded", "failed", "error"}
    for _ in range(settings.cvat_request_poll_attempts):
        payload = client.retrieve_request(request_id)
        last_payload = payload if isinstance(payload, dict) else {}
        status = str(
            last_payload.get("status")
            or last_payload.get("state")
            or last_payload.get("result", {}).get("status")
            or ""
        ).lower()
        if _result_url_from_payload(last_payload) or status in terminal_statuses:
            if status in {"failed", "error"}:
                raise RuntimeError(f"CVAT request {request_id} failed: {last_payload}")
            return last_payload
        time.sleep(settings.cvat_request_poll_interval_seconds)
    raise TimeoutError(f"Timed out waiting for CVAT request {request_id}: {last_payload}")


def _request_id_from_payload(payload: dict[str, Any]) -> str | None:
    for key in ("rq_id", "request_id", "id"):
        value = payload.get(key)
        if value:
            return str(value)
    result = payload.get("result")
    if isinstance(result, dict):
        return _request_id_from_payload(result)
    return None


def _result_url_from_payload(payload: dict[str, Any]) -> str | None:
    for key in ("result_url", "download_url", "url"):
        value = payload.get(key)
        if value:
            return str(value)
    result = payload.get("result")
    if isinstance(result, dict):
        return _result_url_from_payload(result)
    return None


def _report_progress(
    callback: Callable[[float, str | None], None] | None,
    progress: float,
    detail: str,
) -> None:
    if callback is not None:
        callback(progress, detail)
