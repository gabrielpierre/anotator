import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session, require_project_access
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

router = APIRouter()


@router.get("", response_model=list[ProjectRead])
def list_projects(
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[Project]:
    query = select(Project)
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
    external_id = payload.external_id.strip() if payload.external_id else _unique_external_id(db, payload.name)
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
def update_project(project_id: str, payload: ProjectUpdate, db: Session = Depends(db_session)) -> Project:
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


@router.get("/{project_id}/dashboard", response_model=ProjectDashboardRead)
def project_dashboard(
    project_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> ProjectDashboardRead:
    if project_id == "default":
        if user.role == "admin":
            project = db.scalar(select(Project).order_by(Project.created_at))
        else:
            project = db.scalar(
                select(Project)
                .join(ProjectMember, ProjectMember.project_id == Project.id)
                .where(ProjectMember.user_id == user.id)
                .order_by(Project.created_at)
            )
    else:
        project = require_project_access(db, user, project_id)

    task_query = select(Task)
    if project and project_id != "default":
        task_query = task_query.where(Task.project_external_id == project.external_id)
    tasks = list(db.scalars(task_query).all())

    labels: dict[str, int] = {}
    for task in tasks:
        for label in task.labels or []:
            if isinstance(label, dict):
                name = str(label.get("name") or label.get("label") or "unknown")
                labels[name] = labels.get(name, 0) + 1
    if not labels:
        label_query = select(CvatLabel)
        if project and project_id != "default":
            label_query = label_query.where(CvatLabel.project_external_id == project.external_id)
        for label in db.scalars(label_query).all():
            labels[label.name] = labels.get(label.name, 0) + 1

    total_labels = sum(labels.values()) or 1
    class_distribution = [
        ClassDistribution(name=name, count=count, share=round((count / total_labels) * 100, 2))
        for name, count in sorted(labels.items())
    ]
    pending_review_query = select(func.count(AnnotationRecord.id)).where(AnnotationRecord.review_state == "pending")
    task_external_ids = [task.external_id for task in tasks]
    if task_external_ids:
        pending_review_query = pending_review_query.where(AnnotationRecord.task_external_id.in_(task_external_ids))
    elif project and project_id != "default":
        pending_review_query = pending_review_query.where(AnnotationRecord.task_external_id == "__none__")

    stats = DashboardStats(
        projects=db.scalar(select(func.count(Project.id))) or 0,
        tasks=len(tasks),
        images=sum(task.size for task in tasks),
        jobs_running=db.scalar(select(func.count(JobRecord.id)).where(JobRecord.status == "running")) or 0,
        pending_review=db.scalar(pending_review_query) or 0,
        dataset_releases=db.scalar(select(func.count(DatasetRelease.id))) or 0,
        training_runs=db.scalar(select(func.count(TrainingRun.id))) or 0,
    )
    recent_jobs = list(db.scalars(select(JobRecord).order_by(desc(JobRecord.updated_at)).limit(5)).all())
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
    project = db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return list(
        db.scalars(
            select(ProjectMember).where(ProjectMember.project_id == project.id).order_by(ProjectMember.created_at)
        ).all()
    )


@router.put("/{project_id}/members", response_model=list[ProjectMemberRead])
def put_project_members(
    project_id: str,
    payload: ProjectMembersPut,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> list[ProjectMember]:
    project = db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    users = list(db.scalars(select(User).where(User.id.in_(payload.user_ids))).all()) if payload.user_ids else []
    if len(users) != len(set(payload.user_ids)):
        raise HTTPException(status_code=400, detail="One or more users were not found")

    current = {member.user_id: member for member in db.scalars(select(ProjectMember).where(ProjectMember.project_id == project.id))}
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
            select(ProjectMember).where(ProjectMember.project_id == project.id).order_by(ProjectMember.created_at)
        ).all()
    )


@router.delete("/{project_id}/members/{user_id}")
def delete_project_member(
    project_id: str,
    user_id: str,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> dict[str, bool]:
    project = db.get(Project, project_id) or db.scalar(select(Project).where(Project.external_id == project_id))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    member = db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == user_id)
    )
    if member is not None:
        db.delete(member)
    remaining = [
        row
        for row in db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == project.id)).all()
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
