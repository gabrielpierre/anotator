from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import (
    AnnotationRecord,
    AnnotationRevision,
    AuditEvent,
    CvatLabel,
    DatasetRelease,
    DerivedAsset,
    FrameWorkflowState,
    InferenceSuggestion,
    JobRecord,
    PipelineRun,
    Project,
    ReviewDecision,
    Task,
    TaskDataMeta,
    TaskPreview,
    TrackRevision,
    TrainingRun,
)
from app.schemas import TaskDeleteBlockingJob, TaskDeleteImpactRead, TaskDeleteResultRead
from app.services.artifacts import ArtifactStore
from app.services.jobs import ACTIVE_JOB_STATUSES
from app.services.project_storage import refresh_project_storage

TASK_OWNED_JOB_KINDS = {"cvat_job", "import", "inference"}


class ActiveTaskJobsError(RuntimeError):
    def __init__(self, impact: TaskDeleteImpactRead):
        super().__init__("Task has active related jobs")
        self.impact = impact


def resolve_task(db: Session, task_id: str) -> Task | None:
    return db.get(Task, task_id) or db.scalar(select(Task).where(Task.external_id == task_id))


def build_task_delete_impact(db: Session, task: Task) -> TaskDeleteImpactRead:
    external_id = task.external_id
    releases = _dataset_releases_for_task(db, external_id)
    derived_assets = _count(DerivedAsset, DerivedAsset.source_task_external_id == external_id, db=db)
    pipeline_runs = _pipeline_runs_for_task(db, external_id)
    active_jobs = [
        TaskDeleteBlockingJob(
            id=job.id,
            kind=job.kind,
            status=job.status,
            name=job.name,
            detail=job.detail,
        )
        for job in _active_jobs_for_task(db, external_id)
    ]
    warnings: list[str] = []
    if releases:
        warnings.append(
            f"{len(releases)} dataset release(s) preservados continuam referenciando este lote no historico."
        )
    if derived_assets:
        warnings.append(
            f"{derived_assets} crop(s)/asset(s) derivados serao preservados como artefatos historicos."
        )
    if pipeline_runs:
        warnings.append(
            f"{pipeline_runs} pipeline(s) derivados continuam mantendo linhagem deste lote."
        )
    if active_jobs:
        warnings.append("Existem jobs ativos relacionados; finalize ou cancele esses jobs antes de apagar.")

    return TaskDeleteImpactRead(
        task_id=task.id,
        task_external_id=external_id,
        task_name=task.name,
        image_count=task.size,
        annotations=_count(AnnotationRecord, AnnotationRecord.task_external_id == external_id, db=db),
        inference_suggestions=_count(
            InferenceSuggestion,
            InferenceSuggestion.task_external_id == external_id,
            db=db,
        ),
        labels=_count(CvatLabel, CvatLabel.task_external_id == external_id, db=db),
        cvat_jobs=_count(
            JobRecord,
            (JobRecord.kind == "cvat_job") & (JobRecord.task_external_id == external_id),
            db=db,
        ),
        dataset_releases=len(releases),
        derived_assets=derived_assets,
        pipeline_runs=pipeline_runs,
        active_jobs=active_jobs,
        warnings=warnings,
        blocking=bool(active_jobs),
    )


def delete_task_with_dependencies(
    db: Session,
    *,
    task: Task,
    actor_email: str,
    client: Any | None = None,
    delete_cvat: bool = True,
    artifact_store: ArtifactStore | None = None,
) -> TaskDeleteResultRead:
    impact = build_task_delete_impact(db, task)
    if impact.blocking:
        raise ActiveTaskJobsError(impact)

    if delete_cvat:
        if client is None:
            raise RuntimeError("CVAT client is required when delete_cvat=true")
        client.delete_task(task.external_id)

    project = db.scalar(select(Project).where(Project.external_id == task.project_external_id))
    upload_cleanup = cleanup_task_import_uploads(db, task.external_id, artifact_store)
    deleted = delete_local_task_records(db, task.external_id)
    task_id = task.id
    task_external_id = task.external_id
    task_name = task.name
    db.delete(task)
    db.flush()
    refresh_project_storage(db, project)

    preserved = {
        "dataset_releases": impact.dataset_releases,
        "derived_assets": impact.derived_assets,
        "pipeline_runs": impact.pipeline_runs,
    }
    warnings = list(impact.warnings)
    if upload_cleanup["errors"]:
        warnings.append("Alguns uploads temporarios nao puderam ser removidos e serao reconciliados depois.")
    if not delete_cvat:
        warnings.append("O lote foi removido apenas localmente e pode voltar no proximo sync do CVAT.")

    result = TaskDeleteResultRead(
        task_id=task_id,
        task_external_id=task_external_id,
        task_name=task_name,
        cvat_deleted=delete_cvat,
        deleted=deleted,
        preserved=preserved,
        warnings=warnings,
    )
    db.add(
        AuditEvent(
            actor=actor_email,
            action="task_deleted",
            target=task_id,
            payload={
                "task_id": task_id,
                "task_external_id": task_external_id,
                "task_name": task_name,
                "delete_cvat": delete_cvat,
                "impact": impact.model_dump(mode="json"),
                "deleted": deleted,
                "upload_cleanup": upload_cleanup,
                "preserved": preserved,
            },
        )
    )
    db.commit()
    return result


def cleanup_task_import_uploads(
    db: Session,
    task_external_id: str,
    artifact_store: ArtifactStore | None,
) -> dict[str, Any]:
    """Remove arquivos de transporte de imports ligados a uma task removida."""
    result: dict[str, Any] = {"prefixes": 0, "deleted_objects": 0, "errors": []}
    if artifact_store is None:
        return result

    prefixes: set[str] = set()
    jobs = db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all()
    for job in jobs:
        if not _job_directly_references_task(job, task_external_id):
            continue
        uploads = (job.raw or {}).get("upload_artifacts")
        if not isinstance(uploads, list):
            continue
        for upload in uploads:
            if not isinstance(upload, dict):
                continue
            uri = upload.get("uri")
            if not isinstance(uri, str) or not uri.startswith("s3://"):
                continue
            before, marker, _after = uri.partition("/uploads/")
            if marker:
                prefixes.add(f"{before}{marker}")

    result["prefixes"] = len(prefixes)
    for prefix in sorted(prefixes):
        try:
            result["deleted_objects"] += artifact_store.delete_prefix(prefix)
        except Exception as exc:
            result["errors"].append(f"{prefix}: {exc}")
    return result


def delete_local_task_records(db: Session, task_external_id: str) -> dict[str, int]:
    annotations = list(
        db.scalars(
            select(AnnotationRecord).where(AnnotationRecord.task_external_id == task_external_id)
        ).all()
    )
    annotation_external_ids = {annotation.external_id for annotation in annotations}
    cvat_job_ids = {annotation.cvat_job_id for annotation in annotations if annotation.cvat_job_id}
    cvat_jobs = _count(
        JobRecord,
        (JobRecord.kind == "cvat_job") & (JobRecord.task_external_id == task_external_id),
        db=db,
    )
    deleted = {
        "annotations": _delete_count(
            db,
            delete(AnnotationRecord).where(AnnotationRecord.task_external_id == task_external_id),
        ),
        "inference_suggestions": _delete_count(
            db,
            delete(InferenceSuggestion).where(InferenceSuggestion.task_external_id == task_external_id),
        ),
        "labels": _delete_count(
            db,
            delete(CvatLabel).where(CvatLabel.task_external_id == task_external_id),
        ),
        "task_data_meta": _delete_count(
            db,
            delete(TaskDataMeta).where(TaskDataMeta.task_external_id == task_external_id),
        ),
        "task_previews": _delete_count(
            db,
            delete(TaskPreview).where(TaskPreview.task_external_id == task_external_id),
        ),
        "cvat_jobs": cvat_jobs,
        "jobs": _delete_task_owned_jobs(db, task_external_id),
    }
    deleted["frame_workflow_states"] = _delete_count(
        db,
        delete(FrameWorkflowState).where(FrameWorkflowState.task_external_id == task_external_id),
    )
    if annotation_external_ids:
        deleted["annotation_revisions"] = _delete_count(
            db,
            delete(AnnotationRevision).where(
                AnnotationRevision.annotation_external_id.in_(annotation_external_ids)
            ),
        )
        deleted["review_decisions"] = _delete_count(
            db,
            delete(ReviewDecision).where(
                ReviewDecision.external_annotation_id.in_(annotation_external_ids)
            ),
        )
    else:
        deleted["annotation_revisions"] = 0
        deleted["review_decisions"] = 0
    deleted["track_revisions"] = (
        _delete_count(
            db,
            delete(TrackRevision).where(TrackRevision.cvat_job_id.in_(cvat_job_ids)),
        )
        if cvat_job_ids
        else 0
    )
    return deleted


def _active_jobs_for_task(db: Session, task_external_id: str) -> list[JobRecord]:
    jobs = db.scalars(
        select(JobRecord)
        .where(JobRecord.status.in_(ACTIVE_JOB_STATUSES), JobRecord.kind != "cvat_job")
        .order_by(JobRecord.created_at)
    ).all()
    return [job for job in jobs if _job_references_task(db, job, task_external_id)]


def _job_references_task(db: Session, job: JobRecord, task_external_id: str) -> bool:
    if job.kind == "sync":
        return True
    if job.task_external_id == task_external_id:
        return True
    raw = job.raw or {}
    if _json_references_task(raw, task_external_id):
        return True

    release_id = _first_nested_value(raw, "dataset_release_id") or _first_nested_value(raw, "release_id")
    if release_id and _release_contains_task(db, str(release_id), task_external_id):
        return True

    training_run_id = _first_nested_value(raw, "training_run_id")
    if training_run_id:
        run = db.get(TrainingRun, str(training_run_id))
        if run is not None and _release_contains_task(db, run.dataset_release_id, task_external_id):
            return True

    pipeline_run_id = _first_nested_value(raw, "pipeline_run_id")
    if pipeline_run_id:
        run = db.get(PipelineRun, str(pipeline_run_id))
        if run is not None and (
            _json_references_task(run.definition or {}, task_external_id)
            or _json_references_task(run.lineage or {}, task_external_id)
        ):
            return True

    return False


def _delete_task_owned_jobs(db: Session, task_external_id: str) -> int:
    jobs = db.scalars(select(JobRecord).where(JobRecord.kind.in_(TASK_OWNED_JOB_KINDS))).all()
    deleted = 0
    for job in jobs:
        if _job_directly_references_task(job, task_external_id):
            db.delete(job)
            deleted += 1
    return deleted


def _job_directly_references_task(job: JobRecord, task_external_id: str) -> bool:
    if job.task_external_id == task_external_id:
        return True
    raw = job.raw or {}
    return _json_references_task(raw, task_external_id)


def _dataset_releases_for_task(db: Session, task_external_id: str) -> list[DatasetRelease]:
    releases = db.scalars(select(DatasetRelease).order_by(DatasetRelease.created_at)).all()
    return [release for release in releases if task_external_id in _string_set(release.task_external_ids)]


def _pipeline_runs_for_task(db: Session, task_external_id: str) -> int:
    runs = db.scalars(select(PipelineRun)).all()
    return sum(
        1
        for run in runs
        if _json_references_task(run.definition or {}, task_external_id)
        or _json_references_task(run.lineage or {}, task_external_id)
    )


def _release_contains_task(db: Session, release_id: str, task_external_id: str) -> bool:
    release = db.get(DatasetRelease, release_id)
    return release is not None and task_external_id in _string_set(release.task_external_ids)


def _json_references_task(value: Any, task_external_id: str, *, parent_key: str = "") -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = str(key).lower()
            if _is_task_key(normalized_key) and _value_contains_task(child, task_external_id):
                return True
            if normalized_key in {"payload", "definition", "lineage", "config", "raw", "origin"}:
                if _json_references_task(child, task_external_id, parent_key=normalized_key):
                    return True
        return False
    if isinstance(value, list) and _is_task_key(parent_key):
        return _value_contains_task(value, task_external_id)
    return False


def _is_task_key(key: str) -> bool:
    return key in {
        "task",
        "tasks",
        "task_id",
        "task_ids",
        "task_external_id",
        "task_external_ids",
        "cvat_task_id",
        "cvat_task_ids",
        "source_task_external_id",
    }


def _value_contains_task(value: Any, task_external_id: str) -> bool:
    if isinstance(value, dict):
        return any(_value_contains_task(child, task_external_id) for child in value.values())
    if isinstance(value, list):
        return any(_value_contains_task(child, task_external_id) for child in value)
    return str(value) == task_external_id


def _first_nested_value(value: Any, key: str) -> Any | None:
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for child in value.values():
            found = _first_nested_value(child, key)
            if found is not None:
                return found
    if isinstance(value, list):
        for child in value:
            found = _first_nested_value(child, key)
            if found is not None:
                return found
    return None


def _string_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item) for item in value}


def _count(model: type, *where_clauses: Any, db: Session) -> int:
    query = select(func.count(model.id))
    for clause in where_clauses:
        query = query.where(clause)
    return db.scalar(query) or 0


def _delete_count(db: Session, statement: Any) -> int:
    result = db.execute(statement)
    return result.rowcount or 0
