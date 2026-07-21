from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AuditEvent,
    CvatLabel,
    JobRecord,
    Project,
    Task,
    TaskDataMeta,
    TaskPreview,
    utcnow,
)
from app.schemas import SyncError, SyncResult
from app.services.annotations import sync_job_annotations
from app.services.cvat_client import CvatClient
from app.services.jobs import JobCanceled


@dataclass
class SyncCounts:
    projects: int = 0
    tasks: int = 0
    jobs: int = 0
    annotations: int = 0
    labels: int = 0
    data_meta: int = 0
    previews: int = 0


def map_cvat_job_state(raw: dict) -> str:
    state = str(raw.get("state") or raw.get("status") or "").lower()
    stage = str(raw.get("stage") or "").lower()
    if state in {"completed", "done"}:
        return "succeeded"
    if state in {"in progress", "started"} or stage in {"annotation", "validation", "acceptance"}:
        return "running"
    if state in {"rejected", "failed"}:
        return "failed"
    return "queued"


class CvatSyncService:
    def __init__(self, db: Session, client: CvatClient, job_id: str | None = None):
        self.db = db
        self.client = client
        self.errors: list[SyncError] = []
        self.job_id = job_id

    def sync_all(self) -> SyncResult:
        job = self.db.get(JobRecord, self.job_id) if self.job_id else None
        if job is None:
            job = JobRecord(
                kind="sync",
                status="running",
                progress=0,
                name="CVAT sync",
                detail="Synchronizing projects, tasks and jobs from CVAT.",
                started_at=utcnow(),
            )
        else:
            job.status = "running"
            job.progress = max(job.progress, 1)
            job.detail = "Synchronizing projects, tasks and jobs from CVAT."
            job.started_at = job.started_at or utcnow()
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)

        counts = SyncCounts()
        try:
            project_counts = self._sync_projects(self.client.list_projects())
            counts.projects = project_counts.projects
            counts.labels += project_counts.labels
            self._update_job(job, 25, "Synced CVAT projects.")
            task_counts = self._sync_tasks(self.client.list_tasks())
            counts.tasks = task_counts.tasks
            counts.labels += task_counts.labels
            counts.data_meta += task_counts.data_meta
            counts.previews += task_counts.previews
            self._update_job(job, 65, "Synced CVAT tasks, labels and media metadata.")
            job_counts = self._sync_jobs(self.client.list_jobs())
            counts.jobs = job_counts.jobs
            counts.annotations += job_counts.annotations
            self._update_job(job, 90, "Synced CVAT jobs and annotations.")
            self._ensure_not_canceled(job)
            job.status = "succeeded"
            job.progress = 100
            job.detail = (
                f"Synced {counts.projects} projects, {counts.tasks} tasks, {counts.jobs} jobs, "
                f"{counts.annotations} annotations, {counts.labels} labels, "
                f"{counts.data_meta} media meta records and "
                f"{counts.previews} previews."
            )
            if self.errors:
                job.detail = f"{job.detail} Partial errors: {len(self.errors)}."
            job.finished_at = utcnow()
            self.db.add(
                AuditEvent(
                    actor="system",
                    action="cvat_sync_completed",
                    target=job.id,
                    payload={
                        "projects": counts.projects,
                        "tasks": counts.tasks,
                        "jobs": counts.jobs,
                        "annotations": counts.annotations,
                        "labels": counts.labels,
                        "data_meta": counts.data_meta,
                        "previews": counts.previews,
                        "errors": [error.model_dump() for error in self.errors],
                    },
                )
            )
        except JobCanceled as exc:
            job.status = "canceled"
            job.detail = str(exc)
            job.finished_at = utcnow()
            self.db.add(
                AuditEvent(
                    actor="system",
                    action="cvat_sync_canceled",
                    target=job.id,
                    reason=str(exc),
                )
            )
            self.db.add(job)
            self.db.commit()
            raise
        except Exception as exc:
            job.status = "failed"
            job.detail = str(exc)
            job.finished_at = utcnow()
            self.db.add(
                AuditEvent(
                    actor="system",
                    action="cvat_sync_failed",
                    target=job.id,
                    reason=str(exc),
                )
            )
        self.db.commit()
        self.db.refresh(job)
        return SyncResult(
            job=job,
            projects_synced=counts.projects,
            tasks_synced=counts.tasks,
            jobs_synced=counts.jobs,
            annotations_synced=counts.annotations,
            labels_synced=counts.labels,
            data_meta_synced=counts.data_meta,
            previews_synced=counts.previews,
            errors=self.errors,
        )

    def _update_job(self, job: JobRecord, progress: float, detail: str) -> None:
        self._ensure_not_canceled(job)
        job.progress = progress
        job.detail = detail
        self.db.add(job)
        self.db.commit()
        self.db.refresh(job)

    def _ensure_not_canceled(self, job: JobRecord) -> None:
        current = self.db.get(JobRecord, job.id)
        if current is not None and current.status == "canceled":
            raise JobCanceled(f"Job {job.id} was canceled")

    def _sync_projects(self, projects: list[dict]) -> SyncCounts:
        counts = SyncCounts()
        for raw in projects:
            external_id = str(raw.get("id"))
            row = self.db.scalar(select(Project).where(Project.external_id == external_id))
            if row is None:
                row = Project(external_id=external_id, name=raw.get("name") or f"Project {external_id}")
            row.name = raw.get("name") or row.name
            row.status = str(raw.get("status") or "active")
            row.raw = raw
            self.db.add(row)
            counts.projects += 1
            counts.labels += self._sync_labels(
                self._project_labels(external_id, raw.get("labels")),
                project_external_id=external_id,
            )
        self.db.commit()
        return counts

    def _sync_tasks(self, tasks: list[dict]) -> SyncCounts:
        counts = SyncCounts()
        for raw in tasks:
            external_id = str(raw.get("id"))
            enriched = self._task_detail(external_id, raw)
            row = self.db.scalar(select(Task).where(Task.external_id == external_id))
            if row is None:
                row = Task(external_id=external_id, name=enriched.get("name") or f"Task {external_id}")
            project_id = enriched.get("project_id") or enriched.get("project")
            row.project_external_id = str(project_id) if project_id is not None else None
            row.name = enriched.get("name") or row.name
            row.status = str(enriched.get("status") or "unknown")
            row.size = int(enriched.get("size") or enriched.get("data_chunk_size") or 0)
            labels = self._task_labels(external_id, enriched.get("labels"))
            row.labels = self._normalized_labels(labels, task_external_id=external_id)
            row.preview_url = f"/api/v1/tasks/{external_id}/preview"
            row.raw = enriched
            self.db.add(row)
            counts.tasks += 1
            counts.labels += self._sync_labels(
                labels,
                project_external_id=row.project_external_id,
                task_external_id=external_id,
            )
            if self._sync_task_data_meta(external_id, row):
                counts.data_meta += 1
            if self._sync_task_preview(external_id):
                counts.previews += 1
        self.db.commit()
        return counts

    def _sync_jobs(self, jobs: list[dict]) -> SyncCounts:
        counts = SyncCounts()
        for raw in jobs:
            external_id = f"cvat:{raw.get('id')}"
            row = self.db.scalar(select(JobRecord).where(JobRecord.external_id == external_id))
            if row is None:
                row = JobRecord(
                    external_id=external_id,
                    kind="cvat_job",
                    name=f"CVAT job {raw.get('id')}",
                )
            task_id = raw.get("task_id") or raw.get("task")
            row.task_external_id = str(task_id) if task_id is not None else None
            row.status = map_cvat_job_state(raw)
            row.progress = 100 if row.status == "succeeded" else 0
            row.name = raw.get("name") or f"CVAT job {raw.get('id')}"
            row.detail = f"stage={raw.get('stage')} state={raw.get('state')}"
            row.raw = raw
            self.db.add(row)
            self.db.flush()
            counts.jobs += 1
            try:
                annotation_result = sync_job_annotations(self.db, self.client, row)
                counts.annotations += annotation_result.annotations_synced
                for message in annotation_result.errors or []:
                    self.errors.append(
                        SyncError(scope="job_annotations", external_id=external_id, message=message)
                    )
            except Exception as exc:
                self._record_error("job_annotations", external_id, exc)
        self.db.commit()
        return counts

    def _task_detail(self, external_id: str, raw: dict) -> dict:
        try:
            detail = self.client.retrieve_task(external_id)
            return {**raw, **detail}
        except Exception as exc:
            self._record_error("task_detail", external_id, exc)
            return raw

    def _project_labels(self, external_id: str, labels: Any) -> list[Any]:
        if isinstance(labels, list):
            return labels
        try:
            return self.client.list_labels(project_id=external_id)
        except Exception as exc:
            self._record_error("project_labels", external_id, exc)
            return []

    def _task_labels(self, external_id: str, labels: Any) -> list[Any]:
        if isinstance(labels, list):
            return labels
        try:
            return self.client.list_labels(task_id=external_id)
        except Exception as exc:
            self._record_error("task_labels", external_id, exc)
            return []

    def _sync_labels(
        self,
        labels: list[Any],
        *,
        project_external_id: str | None = None,
        task_external_id: str | None = None,
    ) -> int:
        normalized = self._normalized_labels(
            labels,
            project_external_id=project_external_id,
            task_external_id=task_external_id,
        )
        for label in normalized:
            row = self.db.scalar(select(CvatLabel).where(CvatLabel.external_id == label["external_id"]))
            if row is None:
                row = CvatLabel(external_id=label["external_id"], name=label["name"])
            row.name = label["name"]
            row.color = label.get("color")
            row.project_external_id = project_external_id
            row.task_external_id = task_external_id
            row.attributes = label.get("attributes") or []
            row.raw = label.get("raw") or {}
            self.db.add(row)
        return len(normalized)

    def _normalized_labels(
        self,
        labels: list[Any],
        *,
        project_external_id: str | None = None,
        task_external_id: str | None = None,
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for raw_label in labels:
            raw = raw_label if isinstance(raw_label, dict) else {"name": str(raw_label)}
            name = str(raw.get("name") or raw.get("label") or raw.get("id") or "unknown")
            raw_id = raw.get("id")
            if task_external_id:
                external_id = f"task:{task_external_id}:label:{raw_id or name}"
            elif project_external_id:
                external_id = f"project:{project_external_id}:label:{raw_id or name}"
            elif raw_id is not None:
                external_id = f"cvat_label:{raw_id}"
            else:
                external_id = f"label:{name}"
            normalized.append(
                {
                    "external_id": external_id,
                    "name": name,
                    "color": raw.get("color") or raw.get("svg_color"),
                    "attributes": raw.get("attributes") or [],
                    "raw": raw,
                }
            )
        return normalized

    def _sync_task_data_meta(self, external_id: str, task: Task) -> bool:
        try:
            meta = self.client.retrieve_task_data_meta(external_id)
        except Exception as exc:
            self._record_error("task_data_meta", external_id, exc)
            return False

        frames = meta.get("frames") if isinstance(meta.get("frames"), list) else []
        frame_count = int(meta.get("size") or meta.get("frame_count") or len(frames) or task.size or 0)
        row = self.db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == external_id))
        if row is None:
            row = TaskDataMeta(task_external_id=external_id)
        row.frame_count = frame_count
        row.chunk_size = _int_or_none(meta.get("chunk_size"))
        row.start_frame = _int_or_none(meta.get("start_frame"))
        row.stop_frame = _int_or_none(meta.get("stop_frame"))
        row.frame_filter = meta.get("frame_filter")
        row.frames = frames
        row.deleted_frames = meta.get("deleted_frames") or []
        row.raw = meta
        self.db.add(row)
        task.size = frame_count or task.size
        return True

    def _sync_task_preview(self, external_id: str) -> bool:
        row = self.db.scalar(select(TaskPreview).where(TaskPreview.task_external_id == external_id))
        if row is None:
            row = TaskPreview(task_external_id=external_id, url=f"/api/v1/tasks/{external_id}/preview")
        row.url = f"/api/v1/tasks/{external_id}/preview"
        row.content_type = "image/*"
        row.raw = {"source": "cvat", "endpoint": f"/api/tasks/{external_id}/preview"}
        self.db.add(row)
        return True

    def _record_error(self, scope: str, external_id: str | None, exc: Exception) -> None:
        message = str(exc)
        self.errors.append(SyncError(scope=scope, external_id=external_id, message=message))
        self.db.add(
            AuditEvent(
                actor="system",
                action="cvat_sync_partial_error",
                target=external_id or scope,
                reason=message,
                payload={"scope": scope, "external_id": external_id},
            )
        )


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
