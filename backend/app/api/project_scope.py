from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_project_access
from app.models import (
    AnnotationRecord,
    ArtifactRecord,
    DatasetRelease,
    DerivedAsset,
    InferenceSuggestion,
    JobRecord,
    ModelVersion,
    PipelineRun,
    Project,
    ProjectMember,
    ReviewDecision,
    Task,
    TrainingRun,
    User,
)


def resolve_project(db: Session, project_id: str | None) -> Project | None:
    if not project_id:
        return None
    return db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )


def project_values(project: Project | None) -> set[str]:
    return {
        value
        for value in {project.id if project else None, project.external_id if project else None}
        if value
    }


def project_payload(project: Project | None) -> dict[str, str]:
    if project is None:
        return {}
    return {"project_id": project.id, "project_external_id": project.external_id}


def accessible_projects(db: Session, user: User) -> list[Project]:
    query = select(Project).where(Project.status == "active")
    if user.role == "admin":
        return list(db.scalars(query).all())
    return list(
        db.scalars(
            query.join(ProjectMember, ProjectMember.project_id == Project.id).where(
                ProjectMember.user_id == user.id
            )
        ).all()
    )


def accessible_project_values(db: Session, user: User) -> set[str]:
    values: set[str] = set()
    for project in accessible_projects(db, user):
        values.update(project_values(project))
    return values


def require_project_for_user(
    db: Session,
    user: User,
    project: Project | None,
    *,
    orphan_detail: str = "Project ownership could not be resolved",
) -> Project | None:
    if project is None:
        if user.role == "admin":
            return None
        raise HTTPException(status_code=403, detail=orphan_detail)
    return require_project_access(db, user, project.id)


def resolve_task(db: Session, task_id: str | None) -> Task | None:
    if not task_id:
        return None
    return db.get(Task, task_id) or db.scalar(select(Task).where(Task.external_id == task_id))


def project_for_task(db: Session, task: Task | None) -> Project | None:
    if task is None or not task.project_external_id:
        return None
    return resolve_project(db, task.project_external_id)


def require_task_access(db: Session, user: User, task_id: str) -> Task:
    task = resolve_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.project_external_id:
        raise HTTPException(status_code=404, detail="Task not found")
    require_project_for_user(
        db, user, project_for_task(db, task), orphan_detail="Task has no project ownership"
    )
    return task


def visible_task_external_ids(
    db: Session,
    user: User,
    project_external_id: str | None = None,
) -> list[str] | None:
    if project_external_id:
        project = require_project_access(db, user, project_external_id)
        return [
            task.external_id
            for task in db.scalars(
                select(Task).where(Task.project_external_id == project.external_id)
            ).all()
        ]
    if user.role == "admin":
        return []
    project_external_ids = [project.external_id for project in accessible_projects(db, user)]
    if not project_external_ids:
        return []
    return [
        task.external_id
        for task in db.scalars(
            select(Task).where(Task.project_external_id.in_(project_external_ids))
        ).all()
    ]


def resolve_annotation(db: Session, annotation_id: str | None) -> AnnotationRecord | None:
    if not annotation_id:
        return None
    return db.get(AnnotationRecord, annotation_id) or db.scalar(
        select(AnnotationRecord).where(AnnotationRecord.external_id == annotation_id)
    )


def project_for_annotation(db: Session, annotation: AnnotationRecord | None) -> Project | None:
    if annotation is None:
        return None
    return project_for_task(db, resolve_task(db, annotation.task_external_id))


def require_annotation_access(db: Session, user: User, annotation_id: str) -> AnnotationRecord:
    annotation = resolve_annotation(db, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")
    require_project_for_user(
        db,
        user,
        project_for_annotation(db, annotation),
        orphan_detail="Annotation has no project ownership",
    )
    return annotation


def annotation_visible(db: Session, user: User, annotation: AnnotationRecord | None) -> bool:
    try:
        require_project_for_user(db, user, project_for_annotation(db, annotation))
        return annotation is not None
    except HTTPException:
        return False


def resolve_suggestion(db: Session, suggestion_id: str | None) -> InferenceSuggestion | None:
    if not suggestion_id:
        return None
    return db.get(InferenceSuggestion, suggestion_id) or db.scalar(
        select(InferenceSuggestion).where(InferenceSuggestion.external_id == suggestion_id)
    )


def project_for_suggestion(db: Session, suggestion: InferenceSuggestion | None) -> Project | None:
    if suggestion is None:
        return None
    return project_for_task(db, resolve_task(db, suggestion.task_external_id))


def require_suggestion_access(db: Session, user: User, suggestion_id: str) -> InferenceSuggestion:
    suggestion = resolve_suggestion(db, suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    require_project_for_user(
        db,
        user,
        project_for_suggestion(db, suggestion),
        orphan_detail="Suggestion has no project ownership",
    )
    return suggestion


def project_for_release(db: Session, release: DatasetRelease | None) -> Project | None:
    if release is None:
        return None
    project = resolve_project(db, release.project_id)
    if project is not None:
        return project
    task_ids = [str(task_id) for task_id in release.task_external_ids or [] if task_id]
    return _single_task_project(db, task_ids)


def require_release_access(db: Session, user: User, release_id: str) -> DatasetRelease:
    release = db.get(DatasetRelease, release_id)
    if release is None:
        raise HTTPException(status_code=404, detail="Dataset release not found")
    require_project_for_user(
        db,
        user,
        project_for_release(db, release),
        orphan_detail="Dataset release has no project ownership",
    )
    return release


def project_for_training(db: Session, run: TrainingRun | None) -> Project | None:
    if run is None:
        return None
    return project_for_release(db, db.get(DatasetRelease, run.dataset_release_id))


def require_training_access(db: Session, user: User, run_id: str) -> TrainingRun:
    run = db.get(TrainingRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Training run not found")
    require_project_for_user(
        db,
        user,
        project_for_training(db, run),
        orphan_detail="Training run has no project ownership",
    )
    return run


def project_for_model(db: Session, model: ModelVersion | None) -> Project | None:
    if model is None:
        return None
    project = (
        project_for_release(db, db.get(DatasetRelease, model.dataset_release_id))
        if model.dataset_release_id
        else None
    )
    if project is not None:
        return project
    project = (
        project_for_training(db, db.get(TrainingRun, model.training_run_id))
        if model.training_run_id
        else None
    )
    if project is not None:
        return project
    params = model.params if isinstance(model.params, dict) else {}
    return resolve_project(db, _first_str(params, "project_id", "project_external_id"))


def require_model_access(db: Session, user: User, model_id: str) -> ModelVersion:
    model = db.get(ModelVersion, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")
    require_project_for_user(
        db,
        user,
        project_for_model(db, model),
        orphan_detail="Model has no project ownership",
    )
    return model


def project_for_pipeline(db: Session, run: PipelineRun | None) -> Project | None:
    if run is None:
        return None
    lineage = run.lineage if isinstance(run.lineage, dict) else {}
    definition = run.definition if isinstance(run.definition, dict) else {}
    project = resolve_project(db, _first_str(lineage, "project_id", "project_external_id"))
    if project is not None:
        return project
    project = resolve_project(db, _first_str(definition, "project_id", "project_external_id"))
    if project is not None:
        return project
    for source_key in ("source_release_id", "derived_release_id"):
        release_id = _first_str(lineage, source_key) or _first_str(definition, source_key)
        project = (
            project_for_release(db, db.get(DatasetRelease, release_id)) if release_id else None
        )
        if project is not None:
            return project
    task_ids = _list_str(definition.get("task_external_ids")) or _list_str(
        lineage.get("task_external_ids")
    )
    return _single_task_project(db, task_ids)


def require_pipeline_access(db: Session, user: User, run_id: str) -> PipelineRun:
    run = db.get(PipelineRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Pipeline run not found")
    require_project_for_user(
        db,
        user,
        project_for_pipeline(db, run),
        orphan_detail="Pipeline run has no project ownership",
    )
    return run


def project_for_asset(db: Session, asset: DerivedAsset | None) -> Project | None:
    if asset is None:
        return None
    project = (
        project_for_release(db, db.get(DatasetRelease, asset.dataset_release_id))
        if asset.dataset_release_id
        else None
    )
    if project is not None:
        return project
    project = project_for_task(db, resolve_task(db, asset.source_task_external_id))
    if project is not None:
        return project
    return project_for_pipeline(db, db.get(PipelineRun, asset.pipeline_run_id))


def require_asset_access(db: Session, user: User, asset_id: str) -> DerivedAsset:
    asset = db.get(DerivedAsset, asset_id) or db.scalar(
        select(DerivedAsset).where(DerivedAsset.external_id == asset_id)
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="Derived asset not found")
    require_project_for_user(
        db,
        user,
        project_for_asset(db, asset),
        orphan_detail="Derived asset has no project ownership",
    )
    return asset


def project_for_artifact(db: Session, artifact: ArtifactRecord | None) -> Project | None:
    if artifact is None:
        return None
    raw = artifact.raw if isinstance(artifact.raw, dict) else {}
    project = resolve_project(db, _first_str(raw, "project_id", "project_external_id"))
    if project is not None:
        return project
    if artifact.owner_type == "dataset_release" and artifact.owner_id:
        return project_for_release(db, db.get(DatasetRelease, artifact.owner_id))
    if artifact.owner_type == "training_run" and artifact.owner_id:
        return project_for_training(db, db.get(TrainingRun, artifact.owner_id))
    if artifact.owner_type == "model" and artifact.owner_id:
        return project_for_model(db, db.get(ModelVersion, artifact.owner_id))
    if artifact.owner_type == "pipeline_run" and artifact.owner_id:
        return project_for_pipeline(db, db.get(PipelineRun, artifact.owner_id))
    if artifact.owner_type == "derived_asset" and artifact.owner_id:
        return project_for_asset(db, db.get(DerivedAsset, artifact.owner_id))
    return None


def require_artifact_access(db: Session, user: User, artifact: ArtifactRecord) -> ArtifactRecord:
    require_project_for_user(
        db,
        user,
        project_for_artifact(db, artifact),
        orphan_detail="Artifact has no project ownership",
    )
    return artifact


def project_values_for_job(db: Session, job: JobRecord) -> set[str]:
    raw = job.raw if isinstance(job.raw, dict) else {}
    values = {
        _first_str(raw, "project_id", "project_external_id"),
        _nested_first_str(raw, "payload", "project_id", "project_external_id"),
        _nested_first_str(raw, "lineage", "project_id", "project_external_id"),
    }
    projects: list[Project | None] = []
    task_ids = {
        job.task_external_id,
        _first_str(raw, "task_external_id", "cvat_task_id"),
        _nested_first_str(raw, "payload", "task_external_id"),
        _nested_first_str(raw, "lineage", "task_external_id"),
    }
    task_ids.update(_list_str(raw.get("cvat_task_ids")))
    for task_id in task_ids:
        projects.append(project_for_task(db, resolve_task(db, task_id)))
    for release_id in {
        _first_str(
            raw, "dataset_release_id", "release_id", "source_release_id", "derived_release_id"
        ),
        _nested_first_str(raw, "payload", "dataset_release_id", "release_id", "source_release_id"),
        _nested_first_str(raw, "lineage", "source_release_id", "derived_release_id"),
    }:
        projects.append(
            project_for_release(db, db.get(DatasetRelease, release_id)) if release_id else None
        )
    training_id = _first_str(raw, "training_run_id") or _nested_first_str(
        raw, "payload", "training_run_id"
    )
    projects.append(
        project_for_training(db, db.get(TrainingRun, training_id)) if training_id else None
    )
    pipeline_id = _first_str(raw, "pipeline_run_id") or _nested_first_str(
        raw, "payload", "pipeline_run_id"
    )
    projects.append(
        project_for_pipeline(db, db.get(PipelineRun, pipeline_id)) if pipeline_id else None
    )
    model_id = _first_str(raw, "model_id") or _nested_first_str(raw, "payload", "model_id")
    projects.append(project_for_model(db, db.get(ModelVersion, model_id)) if model_id else None)

    resolved_values = {str(value) for value in values if value}
    for project in projects:
        resolved_values.update(project_values(project))
    return resolved_values


def job_visible(db: Session, user: User, job: JobRecord) -> bool:
    if user.role == "admin":
        return True
    return bool(project_values_for_job(db, job) & accessible_project_values(db, user))


def job_matches_project(db: Session, job: JobRecord, project: Project) -> bool:
    return bool(project_values_for_job(db, job) & project_values(project))


def filter_visible_models(
    db: Session, user: User, models: Iterable[ModelVersion]
) -> list[ModelVersion]:
    return [model for model in models if _project_visible(db, user, project_for_model(db, model))]


def filter_visible_training_runs(
    db: Session, user: User, runs: Iterable[TrainingRun]
) -> list[TrainingRun]:
    return [run for run in runs if _project_visible(db, user, project_for_training(db, run))]


def filter_visible_pipelines(
    db: Session, user: User, runs: Iterable[PipelineRun]
) -> list[PipelineRun]:
    return [run for run in runs if _project_visible(db, user, project_for_pipeline(db, run))]


def filter_visible_assets(
    db: Session, user: User, assets: Iterable[DerivedAsset]
) -> list[DerivedAsset]:
    return [asset for asset in assets if _project_visible(db, user, project_for_asset(db, asset))]


def review_decision_visible(db: Session, user: User, decision: ReviewDecision) -> bool:
    annotation = resolve_annotation(db, decision.external_annotation_id)
    return annotation_visible(db, user, annotation)


def annotation_revision_visible(db: Session, user: User, annotation_external_id: str) -> bool:
    return annotation_visible(db, user, resolve_annotation(db, annotation_external_id))


def track_revision_visible(db: Session, user: User, track_external_id: str) -> bool:
    annotation = db.scalar(
        select(AnnotationRecord).where(
            AnnotationRecord.annotation_type == "track",
            (AnnotationRecord.cvat_annotation_id == track_external_id)
            | (AnnotationRecord.external_id == track_external_id),
        )
    )
    return annotation_visible(db, user, annotation)


def _project_visible(db: Session, user: User, project: Project | None) -> bool:
    if user.role == "admin":
        return True
    return bool(project_values(project) & accessible_project_values(db, user))


def _single_task_project(db: Session, task_external_ids: list[str]) -> Project | None:
    if not task_external_ids:
        return None
    tasks = list(db.scalars(select(Task).where(Task.external_id.in_(task_external_ids))).all())
    projects = {task.project_external_id for task in tasks if task.project_external_id}
    if len(projects) != 1:
        return None
    return resolve_project(db, next(iter(projects)))


def _first_str(source: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = source.get(key)
        if value is not None and value != "":
            return str(value)
    return None


def _nested_first_str(source: dict[str, Any], parent: str, *keys: str) -> str | None:
    nested = source.get(parent)
    if not isinstance(nested, dict):
        return None
    return _first_str(nested, *keys)


def _list_str(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(row) for row in value if row]
