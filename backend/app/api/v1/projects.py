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
from app.services.tasks import delete_local_task_records

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

    task_cleanup = _delete_project_tasks(db, project)
    raw = dict(project.raw or {})
    raw["deleted_at"] = datetime_iso()
    raw["deleted_by"] = actor.email
    raw["deleted_tasks"] = task_cleanup
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
            },
        )
    )
    db.commit()
    db.refresh(project)
    return project


def _delete_project_tasks(db: Session, project: Project) -> dict[str, Any]:
    tasks = _project_tasks_for_cleanup(db, project)
    if not tasks:
        return {"tasks": 0, "cvat_deleted": 0, "cvat_errors": [], "local_deleted": {}}

    client = CvatClient(get_settings())
    cvat_deleted = 0
    cvat_errors: list[dict[str, str]] = []
    local_deleted: dict[str, int] = {}

    for task in tasks:
        if task.external_id:
            try:
                client.delete_task(task.external_id)
                cvat_deleted += 1
            except CvatClientError as exc:
                message = str(exc)
                if "404" not in message:
                    cvat_errors.append({"task_external_id": task.external_id, "error": message})
            deleted = delete_local_task_records(db, task.external_id)
            for key, count in deleted.items():
                local_deleted[key] = local_deleted.get(key, 0) + count
        db.delete(task)

    return {
        "tasks": len(tasks),
        "cvat_deleted": cvat_deleted,
        "cvat_errors": cvat_errors,
        "local_deleted": local_deleted,
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
    pending_review_query = select(func.count(AnnotationRecord.id)).where(
        AnnotationRecord.review_state == "pending"
    )
    task_external_ids = [task.external_id for task in tasks]
    if task_external_ids:
        pending_review_query = pending_review_query.where(
            AnnotationRecord.task_external_id.in_(task_external_ids)
        )
    elif project:
        pending_review_query = pending_review_query.where(
            AnnotationRecord.task_external_id == "__none__"
        )

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
        project = _project_with_calculated_import_storage(project, project_jobs)

    stats = DashboardStats(
        projects=db.scalar(select(func.count(Project.id)).where(Project.status == "active")) or 0,
        tasks=len(tasks),
        images=sum(task.size for task in tasks),
        jobs_running=sum(1 for job in project_jobs if job.status == "running"),
        pending_review=db.scalar(pending_review_query) or 0,
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


def datetime_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def _release_belongs_to_project(db: Session, release: DatasetRelease, project: Project) -> bool:
    owner = project_for_release(db, release)
    return owner is not None and owner.id == project.id


def _project_with_calculated_import_storage(project: Project, jobs: list[JobRecord]) -> Project:
    raw = dict(project.raw or {})
    storage = raw.get("storage")
    if not isinstance(storage, dict):
        return project
    imported_bytes = sum(_job_uploaded_bytes(job) for job in jobs if job.kind == "import")
    if imported_bytes <= 0:
        return project
    stored_used_bytes = _int_value(storage.get("used_bytes")) or 0
    if stored_used_bytes >= imported_bytes:
        return project
    quota_bytes = _int_value(storage.get("quota_bytes")) or 0
    raw["storage"] = {
        **storage,
        "used_bytes": imported_bytes,
        "used_gb": round(imported_bytes / 1024**3, 3),
        "percent": round((imported_bytes / quota_bytes) * 100, 2) if quota_bytes else 0,
    }
    project.raw = raw
    return project


def _job_uploaded_bytes(job: JobRecord) -> int:
    raw = job.raw or {}
    stored = _int_value(raw.get("upload_storage_bytes"))
    if stored is not None:
        return stored
    artifacts = raw.get("upload_artifacts")
    if not isinstance(artifacts, list):
        return 0
    total = 0
    for artifact in artifacts:
        if isinstance(artifact, dict):
            total += _int_value(artifact.get("size_bytes")) or 0
    return total


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


def _int_value(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None
