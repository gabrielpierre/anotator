from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.models import (
    ArtifactRecord,
    DatasetRelease,
    DerivedAsset,
    JobRecord,
    ModelVersion,
    PipelineRun,
    Project,
    Task,
    TrainingRun,
)
from app.services.artifacts import ArtifactStore, parse_s3_uri
from app.services.tasks import delete_local_task_records


def purge_project_derived_data(
    db: Session,
    project: Project,
    *,
    task_external_ids: Iterable[str] = (),
    artifact_store: ArtifactStore | None = None,
) -> dict[str, Any]:
    """Delete data and objects whose ownership resolves to a deleted project.

    A project deletion is destructive by design. Releases, training runs, models,
    pipeline outputs and their artifacts must not survive as inaccessible storage
    leaks after the project itself is gone.
    """
    task_ids = {str(task_id) for task_id in task_external_ids if task_id}
    releases = list(
        db.scalars(select(DatasetRelease).where(DatasetRelease.project_id == project.id)).all()
    )
    release_ids = {release.id for release in releases}
    for release in releases:
        if isinstance(release.task_external_ids, list):
            task_ids.update(str(task_id) for task_id in release.task_external_ids if task_id)

    # A project can have been partially deleted by an older version of the
    # application. Clear task-owned records even when the Task row is already
    # gone, otherwise its annotations remain addressable by an old task ID.
    orphan_task_records: dict[str, int] = {}
    for task_external_id in sorted(task_ids):
        deleted = delete_local_task_records(db, task_external_id)
        for name, count in deleted.items():
            orphan_task_records[name] = orphan_task_records.get(name, 0) + count
    if task_ids:
        for task in db.scalars(
            select(Task).where(Task.external_id.in_(task_ids))
        ).all():
            db.delete(task)

    runs = (
        list(
            db.scalars(select(TrainingRun).where(TrainingRun.dataset_release_id.in_(release_ids))).all()
        )
        if release_ids
        else []
    )
    run_ids = {run.id for run in runs}
    models = list(
        db.scalars(select(ModelVersion)).all()
    )
    models = [
        model
        for model in models
        if model.dataset_release_id in release_ids or model.training_run_id in run_ids
    ]
    model_ids = {model.id for model in models}

    assets = list(db.scalars(select(DerivedAsset)).all())
    assets = [
        asset
        for asset in assets
        if asset.dataset_release_id in release_ids
        or asset.source_task_external_id in task_ids
        or _contains_reference(asset.lineage, release_ids | task_ids)
    ]
    pipeline_ids = {asset.pipeline_run_id for asset in assets if asset.pipeline_run_id}
    pipelines = list(db.scalars(select(PipelineRun)).all())
    pipelines = [
        pipeline
        for pipeline in pipelines
        if pipeline.id in pipeline_ids
        or _contains_reference(pipeline.definition, release_ids | task_ids)
        or _contains_reference(pipeline.lineage, release_ids | task_ids)
    ]
    pipeline_ids.update(pipeline.id for pipeline in pipelines)

    scopes = {
        project.id,
        project.external_id,
        *task_ids,
        *release_ids,
        *run_ids,
        *model_ids,
        *pipeline_ids,
        *(asset.id for asset in assets),
    }
    artifact_uris = _artifact_uris(releases, runs, models, assets, pipelines)
    artifact_records = [
        record
        for record in db.scalars(select(ArtifactRecord)).all()
        if record.uri in artifact_uris
        or record.owner_id in scopes
        or _contains_reference(record.raw, scopes)
    ]
    artifact_uris.update(record.uri for record in artifact_records if record.uri)

    jobs = [
        job
        for job in db.scalars(select(JobRecord)).all()
        if job.task_external_id in task_ids
        or _contains_reference(job.raw, scopes)
    ]
    canceled_jobs = _revoke_active_jobs(jobs)

    storage = _delete_artifacts(artifact_store, artifact_uris, releases, runs)

    for record in artifact_records:
        db.delete(record)
    for asset in assets:
        db.delete(asset)
    for pipeline in pipelines:
        db.delete(pipeline)
    for model in models:
        db.delete(model)
    for run in runs:
        db.delete(run)
    for job in jobs:
        db.delete(job)
    for release in releases:
        db.delete(release)
    db.flush()

    return {
        "releases": len(releases),
        "training_runs": len(runs),
        "models": len(models),
        "pipeline_runs": len(pipelines),
        "derived_assets": len(assets),
        "artifact_records": len(artifact_records),
        "orphan_task_records": orphan_task_records,
        "jobs": len(jobs),
        "canceled_jobs": canceled_jobs,
        **storage,
    }


def cleanup_inactive_import_uploads(
    db: Session,
    artifact_store: ArtifactStore,
) -> dict[str, Any]:
    """Remove temporary imports once their jobs are no longer active.

    Uploads under ``imports/.../uploads`` are transport files. They are not a
    source of truth after an import succeeds and cannot be resumed after a failed
    import, so retaining them only consumes project storage.
    """
    result: dict[str, Any] = {
        "jobs": 0,
        "prefixes": 0,
        "deleted_objects": 0,
        "errors": [],
    }
    for job in db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all():
        if job.status in {"queued", "running", "paused"}:
            continue
        raw = dict(job.raw or {})
        uploads = raw.get("upload_artifacts")
        prefixes = _upload_prefixes(uploads)
        if not prefixes:
            continue
        result["jobs"] += 1
        result["prefixes"] += len(prefixes)
        for prefix in prefixes:
            try:
                result["deleted_objects"] += artifact_store.delete_prefix(prefix)
            except Exception as exc:  # Cleanup should not block historical job reads.
                result["errors"].append(f"{prefix}: {exc}")
        raw["upload_artifacts"] = []
        raw["upload_storage_bytes"] = 0
        raw["upload_cleanup"] = {
            "deleted_objects": result["deleted_objects"],
            "errors": list(result["errors"]),
        }
        job.raw = raw
        db.add(job)
    db.flush()
    return result


def _artifact_uris(
    releases: Iterable[DatasetRelease],
    runs: Iterable[TrainingRun],
    models: Iterable[ModelVersion],
    assets: Iterable[DerivedAsset],
    pipelines: Iterable[PipelineRun],
) -> set[str]:
    values: list[Any] = []
    for release in releases:
        values.extend((release.artifact_uri, release.snapshot))
    for run in runs:
        values.append(run.artifacts)
    for model in models:
        values.extend((model.artifact_uri, model.params, model.metrics))
    for asset in assets:
        values.extend((asset.crop_uri, asset.preview_url, asset.lineage))
    for pipeline in pipelines:
        values.extend((pipeline.definition, pipeline.lineage))
    return {value for value in _nested_strings(values) if value.startswith("s3://")}


def _delete_artifacts(
    artifact_store: ArtifactStore | None,
    artifact_uris: set[str],
    releases: Iterable[DatasetRelease],
    runs: Iterable[TrainingRun],
) -> dict[str, Any]:
    result: dict[str, Any] = {"artifact_prefixes": 0, "deleted_objects": 0, "artifact_errors": []}
    if artifact_store is None:
        return result

    prefixes: set[str] = set()
    for release in releases:
        prefixes.update(_prefixes_for_identifier(artifact_uris, release.id))
    for run in runs:
        prefixes.update(_prefixes_for_identifier(artifact_uris, run.id))

    result["artifact_prefixes"] = len(prefixes)
    for prefix in sorted(prefixes):
        try:
            result["deleted_objects"] += artifact_store.delete_prefix(prefix)
        except Exception as exc:
            result["artifact_errors"].append(f"{prefix}: {exc}")
    for uri in sorted(artifact_uris):
        if any(_uri_under_prefix(uri, prefix) for prefix in prefixes):
            continue
        try:
            artifact_store.delete(uri)
            result["deleted_objects"] += 1
        except Exception as exc:
            result["artifact_errors"].append(f"{uri}: {exc}")
    return result


def _prefixes_for_identifier(uris: Iterable[str], identifier: str) -> set[str]:
    prefixes: set[str] = set()
    marker = f"/{identifier}/"
    for uri in uris:
        try:
            bucket, key = parse_s3_uri(uri)
        except ValueError:
            continue
        position = f"/{key}".find(marker)
        if position < 0:
            continue
        prefix_key = f"/{key}"[: position + len(marker)].lstrip("/")
        prefixes.add(f"s3://{bucket}/{prefix_key}")
    return prefixes


def _upload_prefixes(uploads: Any) -> set[str]:
    prefixes: set[str] = set()
    if not isinstance(uploads, list):
        return prefixes
    for upload in uploads:
        if not isinstance(upload, dict):
            continue
        uri = upload.get("uri")
        if not isinstance(uri, str) or not uri.startswith("s3://"):
            continue
        before, marker, _after = uri.partition("/uploads/")
        if marker:
            prefixes.add(f"{before}{marker}")
    return prefixes


def _revoke_active_jobs(jobs: Iterable[JobRecord]) -> list[str]:
    canceled: list[str] = []
    for job in jobs:
        if job.status not in {"queued", "running", "paused"}:
            continue
        task_id = (job.raw or {}).get("celery_task_id")
        if task_id:
            try:
                celery_app.control.revoke(str(task_id), terminate=True)
            except Exception:
                pass
        canceled.append(job.id)
    return canceled


def _contains_reference(value: Any, references: set[str]) -> bool:
    return any(item in references for item in _nested_strings(value))


def _nested_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _nested_strings(nested)
    elif isinstance(value, (list, tuple, set)):
        for nested in value:
            yield from _nested_strings(nested)


def _uri_under_prefix(uri: str, prefix: str) -> bool:
    return uri.removeprefix("s3://").startswith(prefix.removeprefix("s3://"))
