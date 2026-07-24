import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session, require_project_access
from app.api.project_scope import job_matches_project, project_for_release
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AuditEvent,
    CvatLabel,
    DatasetRelease,
    FrameWorkflowState,
    JobRecord,
    Project,
    ProjectMember,
    Task,
    TrainingRun,
    User,
)
from app.schemas import (
    ClassDistribution,
    DashboardStats,
    ProjectCreate,
    ProjectDashboardRead,
    ProjectMemberRead,
    ProjectMembersPut,
    ProjectRead,
    ProjectUpdate,
)
from app.services.cvat_client import CvatClient, CvatClientError
from app.services.artifacts import S3ArtifactStore
from app.services.project_cleanup import purge_project_derived_data
from app.services.project_storage import refresh_project_storage
from app.services.tasks import cleanup_task_import_uploads, delete_local_task_records

router = APIRouter()


@router.get("", response_model=list[ProjectRead])
def list_projects(
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[Project]:
    query = select(Project).where(Project.status == "active")
    if user.role != "admin":
        project_ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
        query = query.where(Project.id.in_(project_ids))
    try:
        return list(db.scalars(query.order_by(Project.name)).all())
    except OperationalError:
        if user.id == "internal-api-key":
            return []
        raise


@router.post("", response_model=ProjectRead, dependencies=[Depends(current_admin)])
def create_project(payload: ProjectCreate, db: Session = Depends(db_session)) -> Project:
    external_id = (
        payload.external_id.strip()
        if payload.external_id
        else _unique_external_id(db, payload.name)
    )
    if db.scalar(select(Project).where(Project.external_id == external_id)) is not None:
        raise HTTPException(status_code=409, detail="Project external_id already exists")

    quota_bytes = payload.storage_quota_gb * 1024**3
    project = Project(
        external_id=external_id,
        name=payload.name.strip(),
        status="active",
        raw={
            "source": "local",
            "storage": {
                "path": payload.storage_path.strip(),
                "quota_gb": payload.storage_quota_gb,
                "quota_bytes": quota_bytes,
                "used_bytes": 0,
                "used_gb": 0,
                "warn_at_percent": payload.warn_at_percent,
                "enforce_quota": True,
            },
        },
    )
    db.add(project)
    db.flush()
    db.add(
        AuditEvent(
            actor="system",
            action="project_created",
            target=project.id,
            payload={
                "project_id": project.id,
                "external_id": project.external_id,
                "storage_path": payload.storage_path,
                "storage_quota_gb": payload.storage_quota_gb,
            },
        )
    )
    db.commit()
    db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectRead, dependencies=[Depends(current_admin)])
def update_project(
    project_id: str, payload: ProjectUpdate, db: Session = Depends(db_session)
) -> Project:
    project = db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    changes: dict[str, Any] = {}

    if payload.name is not None and payload.name.strip():
        project.name = payload.name.strip()
        changes["name"] = project.name

    raw = dict(project.raw or {})
    storage = dict(raw.get("storage") or {})
    if payload.storage_path is not None and payload.storage_path.strip():
        storage["path"] = payload.storage_path.strip()
        changes["storage_path"] = storage["path"]
    if payload.storage_quota_gb is not None:
        storage["quota_gb"] = payload.storage_quota_gb
        storage["quota_bytes"] = payload.storage_quota_gb * 1024**3
        changes["storage_quota_gb"] = payload.storage_quota_gb
    if payload.warn_at_percent is not None:
        storage["warn_at_percent"] = payload.warn_at_percent
        changes["warn_at_percent"] = payload.warn_at_percent
    if storage:
        raw["storage"] = storage
        project.raw = raw

    if changes:
        db.add(
            AuditEvent(
                actor="system",
                action="project_updated",
                target=project.id,
                payload={"project_id": project.id, "external_id": project.external_id, **changes},
            )
        )
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", response_model=ProjectRead)
def delete_project(
    project_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> Project:
    project = db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )
    if project is None or project.status == "deleted":
        raise HTTPException(status_code=404, detail="Project not found")

    artifact_store = S3ArtifactStore(get_settings())
    task_cleanup = _delete_project_tasks(db, project, artifact_store=artifact_store)
    db.flush()
    derived_cleanup = purge_project_derived_data(
        db,
        project,
        task_external_ids=task_cleanup["task_external_ids"],
        artifact_store=artifact_store,
    )
    raw = dict(project.raw or {})
    raw["deleted_at"] = datetime_iso()
    raw["deleted_by"] = actor.email
    raw["deleted_tasks"] = task_cleanup
    raw["deleted_derived_data"] = derived_cleanup
    project.status = "deleted"
    project.raw = raw
    for member in db.scalars(
        select(ProjectMember).where(ProjectMember.project_id == project.id)
    ).all():
        db.delete(member)
    db.add(project)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="project_deleted",
            target=project.id,
            payload={
                "project_id": project.id,
                "external_id": project.external_id,
                "name": project.name,
                "task_cleanup": task_cleanup,
                "derived_cleanup": derived_cleanup,
            },
        )
    )
    db.commit()
    db.refresh(project)
    return project


def _delete_project_tasks(
    db: Session,
    project: Project,
    *,
    artifact_store: S3ArtifactStore,
) -> dict[str, Any]:
    tasks = _project_tasks_for_cleanup(db, project)
    if not tasks:
        return {
            "tasks": 0,
            "task_external_ids": [],
            "cvat_deleted": 0,
            "cvat_errors": [],
            "local_deleted": {},
            "upload_cleanup": {"prefixes": 0, "deleted_objects": 0, "errors": []},
        }

    client = CvatClient(get_settings())
    cvat_deleted = 0
    cvat_errors: list[dict[str, str]] = []
    local_deleted: dict[str, int] = {}
    upload_cleanup: dict[str, Any] = {"prefixes": 0, "deleted_objects": 0, "errors": []}

    for task in tasks:
        if task.external_id:
            try:
                client.delete_task(task.external_id)
                cvat_deleted += 1
            except CvatClientError as exc:
                message = str(exc)
                if "404" not in message:
                    cvat_errors.append({"task_external_id": task.external_id, "error": message})
            cleanup = cleanup_task_import_uploads(db, task.external_id, artifact_store)
            upload_cleanup["prefixes"] += cleanup["prefixes"]
            upload_cleanup["deleted_objects"] += cleanup["deleted_objects"]
            upload_cleanup["errors"].extend(cleanup["errors"])
            deleted = delete_local_task_records(db, task.external_id)
            for key, count in deleted.items():
                local_deleted[key] = local_deleted.get(key, 0) + count
        db.delete(task)

    return {
        "tasks": len(tasks),
        "task_external_ids": [task.external_id for task in tasks if task.external_id],
        "cvat_deleted": cvat_deleted,
        "cvat_errors": cvat_errors,
        "local_deleted": local_deleted,
        "upload_cleanup": upload_cleanup,
    }


def _project_tasks_for_cleanup(db: Session, project: Project) -> list[Task]:
    task_by_external_id = {
        task.external_id: task
        for task in db.scalars(
            select(Task).where(Task.project_external_id == project.external_id)
        ).all()
        if task.external_id
    }
    project_refs = {project.id, project.external_id}
    import_jobs = db.scalars(select(JobRecord).where(JobRecord.kind == "import")).all()
    for job in import_jobs:
        raw = job.raw or {}
        payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        refs = {
            str(payload.get("project_id") or ""),
            str(payload.get("project_external_id") or ""),
            str(raw.get("project_id") or ""),
            str(raw.get("project_external_id") or ""),
        }
        if not (project_refs & {ref for ref in refs if ref}):
            continue
        for cvat_task_id in _job_cvat_task_ids(raw, payload):
            task = db.scalar(select(Task).where(Task.external_id == cvat_task_id))
            if task is not None and task.external_id:
                task_by_external_id.setdefault(task.external_id, task)
    return list(task_by_external_id.values())


@router.get("/{project_id}/dashboard", response_model=ProjectDashboardRead)
def project_dashboard(
    project_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> ProjectDashboardRead:
    if project_id == "default":
        if user.role == "admin":
            project = db.scalar(
                select(Project).where(Project.status == "active").order_by(Project.created_at)
            )
        else:
            project = db.scalar(
                select(Project)
                .join(ProjectMember, ProjectMember.project_id == Project.id)
                .where(ProjectMember.user_id == user.id)
                .where(Project.status == "active")
                .order_by(Project.created_at)
            )
    else:
        project = require_project_access(db, user, project_id)
        if project.status != "active":
            raise HTTPException(status_code=404, detail="Project not found")

    if project is None:
        tasks = []
    else:
        tasks = list(
            db.scalars(select(Task).where(Task.project_external_id == project.external_id)).all()
        )

    labels: dict[str, int] = {}
    for task in tasks:
        for label in task.labels or []:
            if isinstance(label, dict):
                name = str(label.get("name") or label.get("label") or "unknown")
                labels[name] = labels.get(name, 0) + 1
    if not labels:
        label_query = select(CvatLabel)
        if project:
            label_query = label_query.where(CvatLabel.project_external_id == project.external_id)
        for label in db.scalars(label_query).all():
            labels[label.name] = labels.get(label.name, 0) + 1

    total_labels = sum(labels.values()) or 1
    class_distribution = [
        ClassDistribution(name=name, count=count, share=round((count / total_labels) * 100, 2))
        for name, count in sorted(labels.items())
    ]
    task_external_ids = [task.external_id for task in tasks]
    pending_review = _pending_review_annotation_count(db, task_external_ids, scoped_to_empty_project=bool(project and not task_external_ids))

    releases = list(db.scalars(select(DatasetRelease)).all())
    project_releases = [
        release
        for release in releases
        if project is not None and _release_belongs_to_project(db, release, project)
    ]
    project_release_ids = {release.id for release in project_releases}
    training_runs = (
        list(
            db.scalars(
                select(TrainingRun).where(TrainingRun.dataset_release_id.in_(project_release_ids))
            ).all()
        )
        if project_release_ids
        else []
    )
    project_jobs = [
        job
        for job in db.scalars(select(JobRecord).order_by(desc(JobRecord.updated_at))).all()
        if project is not None and job_matches_project(db, job, project)
    ]
    if project is not None:
        refresh_project_storage(db, project)

    stats = DashboardStats(
        projects=db.scalar(select(func.count(Project.id)).where(Project.status == "active")) or 0,
        tasks=len(tasks),
        images=sum(task.size for task in tasks),
        jobs_running=sum(1 for job in project_jobs if job.status == "running"),
        pending_review=pending_review,
        dataset_releases=len(project_releases),
        training_runs=len(training_runs),
    )
    recent_jobs = project_jobs[:5]
    return ProjectDashboardRead(
        project=project,
        stats=stats,
        class_distribution=class_distribution,
        recent_jobs=recent_jobs,
    )


@router.get("/{project_id}/members", response_model=list[ProjectMemberRead])
def list_project_members(
    project_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> list[ProjectMember]:
    project = db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return list(
        db.scalars(
            select(ProjectMember)
            .where(ProjectMember.project_id == project.id)
            .order_by(ProjectMember.created_at)
        ).all()
    )


@router.put("/{project_id}/members", response_model=list[ProjectMemberRead])
def put_project_members(
    project_id: str,
    payload: ProjectMembersPut,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> list[ProjectMember]:
    project = db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    users = (
        list(db.scalars(select(User).where(User.id.in_(payload.user_ids))).all())
        if payload.user_ids
        else []
    )
    if len(users) != len(set(payload.user_ids)):
        raise HTTPException(status_code=400, detail="One or more users were not found")

    current = {
        member.user_id: member
        for member in db.scalars(
            select(ProjectMember).where(ProjectMember.project_id == project.id)
        )
    }
    requested = set(payload.user_ids)
    for user_id, member in list(current.items()):
        if user_id not in requested:
            db.delete(member)
    for user_id in requested:
        if user_id not in current:
            db.add(ProjectMember(project_id=project.id, user_id=user_id, role="anotador"))

    _sync_project_annotators(db, project, sorted(requested))
    db.add(
        AuditEvent(
            actor=actor.email,
            action="project_members_updated",
            target=project.id,
            payload={"project_id": project.id, "user_ids": sorted(requested)},
        )
    )
    db.commit()
    return list(
        db.scalars(
            select(ProjectMember)
            .where(ProjectMember.project_id == project.id)
            .order_by(ProjectMember.created_at)
        ).all()
    )


@router.delete("/{project_id}/members/{user_id}")
def delete_project_member(
    project_id: str,
    user_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> dict[str, bool]:
    project = db.get(Project, project_id) or db.scalar(
        select(Project).where(Project.external_id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    member = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == user_id
        )
    )
    if member is not None:
        db.delete(member)
    remaining = [
        row
        for row in db.scalars(
            select(ProjectMember.user_id).where(ProjectMember.project_id == project.id)
        ).all()
        if row != user_id
    ]
    _sync_project_annotators(db, project, remaining)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="project_member_removed",
            target=project.id,
            payload={"project_id": project.id, "user_id": user_id},
        )
    )
    db.commit()
    return {"ok": True}


def _unique_external_id(db: Session, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "project"
    base = base[:48]
    if db.scalar(select(Project).where(Project.external_id == base)) is None:
        return base
    for index in range(2, 1000):
        candidate = f"{base}-{index}"[:64]
        if db.scalar(select(Project).where(Project.external_id == candidate)) is None:
            return candidate
    raise HTTPException(status_code=409, detail="Could not generate unique project external_id")


def _sync_project_annotators(db: Session, project: Project, user_ids: list[str]) -> None:
    raw = dict(project.raw or {})
    raw["annotator_ids"] = user_ids
    project.raw = raw
    db.add(project)


def _pending_review_annotation_count(
    db: Session,
    task_external_ids: list[str],
    *,
    scoped_to_empty_project: bool,
) -> int:
    if scoped_to_empty_project:
        return 0
    query = select(AnnotationRecord).where(
        AnnotationRecord.review_state == "pending",
        AnnotationRecord.task_external_id.is_not(None),
        AnnotationRecord.frame.is_not(None),
    )
    if task_external_ids:
        query = query.where(AnnotationRecord.task_external_id.in_(task_external_ids))
    candidates = [annotation for annotation in db.scalars(query).all() if _is_pending_review_annotation(annotation)]
    statuses = _frame_statuses(db, candidates)
    filtered = [
        annotation
        for annotation in candidates
        if statuses.get((annotation.task_external_id, annotation.frame), "review_pending")
        not in {"approved", "needs_annotation", "annotation_pending"}
    ]
    return len(_dedupe_pending_review_annotations(filtered))


def _frame_statuses(db: Session, annotations: list[AnnotationRecord]) -> dict[tuple[str | None, int | None], str]:
    task_ids = sorted({annotation.task_external_id for annotation in annotations if annotation.task_external_id})
    if not task_ids:
        return {}
    states = db.scalars(select(FrameWorkflowState).where(FrameWorkflowState.task_external_id.in_(task_ids))).all()
    return {(state.task_external_id, state.frame): state.status for state in states}


def _dedupe_pending_review_annotations(annotations: list[AnnotationRecord]) -> list[AnnotationRecord]:
    by_key: dict[tuple, AnnotationRecord] = {}
    order: list[tuple] = []
    for annotation in annotations:
        key = _pending_review_annotation_key(annotation)
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = annotation
            order.append(key)
            continue
        if annotation.external_id.startswith("cvat_job:") and not existing.external_id.startswith("cvat_job:"):
            by_key[key] = annotation
    return [by_key[key] for key in order]


def _pending_review_annotation_key(annotation: AnnotationRecord) -> tuple:
    return (
        annotation.task_external_id,
        annotation.frame,
        (annotation.label_name or "").casefold(),
        (annotation.shape_type or "").casefold(),
        tuple(round(float(value), 3) for value in _pending_review_annotation_points(annotation)),
    )


def _is_pending_review_annotation(annotation: AnnotationRecord) -> bool:
    if annotation.annotation_type == "tag":
        return False
    if annotation.frame is None or not annotation.task_external_id:
        return False
    if (annotation.shape_type or "").lower() not in {"rectangle", "polygon"}:
        return False
    points = _pending_review_annotation_points(annotation)
    return len(points) >= 4 and all(isinstance(value, int | float) for value in points)


def _pending_review_annotation_points(annotation: AnnotationRecord) -> list:
    points = annotation.points if isinstance(annotation.points, list) else []
    if points:
        return points
    raw = annotation.raw if isinstance(annotation.raw, dict) else {}
    points_norm = raw.get("points_norm")
    return points_norm if isinstance(points_norm, list) else []


def datetime_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def _release_belongs_to_project(db: Session, release: DatasetRelease, project: Project) -> bool:
    owner = project_for_release(db, release)
    return owner is not None and owner.id == project.id


def _job_cvat_task_ids(raw: dict[str, Any], payload: dict[str, Any]) -> list[str]:
    task_ids: list[str] = []
    for source in (raw, payload):
        raw_task_ids = source.get("cvat_task_ids")
        if isinstance(raw_task_ids, list):
            task_ids.extend(str(task_id) for task_id in raw_task_ids if task_id)
        raw_task_id = source.get("cvat_task_id")
        if raw_task_id:
            task_ids.append(str(raw_task_id))
    deduped: list[str] = []
    seen: set[str] = set()
    for task_id in task_ids:
        if task_id not in seen:
            seen.add(task_id)
            deduped.append(task_id)
    return deduped
