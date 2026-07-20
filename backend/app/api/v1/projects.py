import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import AuditEvent, CvatLabel, DatasetRelease, JobRecord, Project, ReviewDecision, Task, TrainingRun
from app.schemas import ClassDistribution, DashboardStats, ProjectCreate, ProjectDashboardRead, ProjectRead

router = APIRouter()


@router.get("", response_model=list[ProjectRead])
def list_projects(db: Session = Depends(db_session)) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.name)).all())


@router.post("", response_model=ProjectRead)
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


@router.get("/{project_id}/dashboard", response_model=ProjectDashboardRead)
def project_dashboard(project_id: str, db: Session = Depends(db_session)) -> ProjectDashboardRead:
    if project_id == "default":
        project = db.scalar(select(Project).order_by(Project.created_at))
    else:
        project = db.get(Project, project_id) or db.scalar(
            select(Project).where(Project.external_id == project_id)
        )

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

    stats = DashboardStats(
        projects=db.scalar(select(func.count(Project.id))) or 0,
        tasks=len(tasks),
        images=sum(task.size for task in tasks),
        jobs_running=db.scalar(select(func.count(JobRecord.id)).where(JobRecord.status == "running")) or 0,
        pending_review=db.scalar(select(func.count(ReviewDecision.id)).where(ReviewDecision.decision == "uncertain"))
        or 0,
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
