from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_admin, current_user, db_session, require_project_access
from app.api.project_scope import require_task_access
from app.core.config import get_settings
from app.models import (
    AnnotationRecord,
    AuditEvent,
    CvatLabel,
    JobRecord,
    Project,
    ProjectMember,
    Task,
    TaskDataMeta,
    User,
)
from app.schemas import (
    TaskAssigneeUpdate,
    TaskDataMetaRead,
    TaskDeleteImpactRead,
    TaskDeleteResultRead,
    TaskRead,
)
from app.services.cvat_client import CvatClient, CvatClientError
from app.services.frame_previews import retrieve_annotation_frame_preview
from app.services.tasks import (
    ActiveTaskJobsError,
    build_task_delete_impact,
    delete_task_with_dependencies,
)

router = APIRouter()


@router.get("", response_model=list[TaskRead])
def list_tasks(
    project_external_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[Task]:
    query = select(Task)
    if project_external_id:
        require_project_access(db, user, project_external_id)
        query = query.where(Task.project_external_id == project_external_id)
    elif user.role == "admin":
        query = query.where(Task.project_external_id == "__none__")
    elif user.role != "admin":
        project_external_ids = _accessible_project_external_ids(db, user)
        query = (
            query.where(Task.project_external_id.in_(project_external_ids))
            if project_external_ids
            else query.where(Task.project_external_id == "__none__")
        )
    tasks = list(db.scalars(query.order_by(Task.updated_at.desc())).all())
    _backfill_import_assignees(db, tasks)
    _attach_annotation_progress(db, tasks)
    return tasks


@router.get("/{task_id}", response_model=TaskRead)
def get_task(
    task_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Task:
    task = require_task_access(db, user, task_id)
    _backfill_import_assignees(db, [task])
    _attach_annotation_progress(db, [task])
    return task


@router.patch("/{task_id}/assignee", response_model=TaskRead)
def update_task_assignee(
    task_id: str,
    payload: TaskAssigneeUpdate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> Task:
    task = require_task_access(db, actor, task_id)

    assignee_payload: dict | None = None
    if payload.user_id:
        assignee = db.get(User, payload.user_id)
        if assignee is None or assignee.status != "active":
            raise HTTPException(status_code=404, detail="Active user not found")
        if assignee.role != "anotador":
            raise HTTPException(status_code=400, detail="Only annotators can be assigned to a task")
        _ensure_project_membership(db, task, assignee)
        assignee_payload = {
            "user_id": assignee.id,
            "name": assignee.name,
            "email": assignee.email,
            "role": assignee.role,
        }

    raw = dict(task.raw or {})
    previous = raw.get("local_assignee")
    if assignee_payload is None:
        raw.pop("local_assignee", None)
    else:
        raw["local_assignee"] = assignee_payload
    task.raw = raw
    db.add(task)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="task_assignee_updated",
            target=task.id,
            payload={
                "task_id": task.id,
                "task_external_id": task.external_id,
                "previous": previous,
                "assignee": assignee_payload,
            },
        )
    )
    db.commit()
    db.refresh(task)
    _attach_annotation_progress(db, [task])
    return task


@router.get("/{task_id}/delete-impact", response_model=TaskDeleteImpactRead)
def get_task_delete_impact(
    task_id: str,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> TaskDeleteImpactRead:
    task = require_task_access(db, _, task_id)
    return build_task_delete_impact(db, task)


@router.delete("/{task_id}", response_model=TaskDeleteResultRead)
def delete_task(
    task_id: str,
    delete_cvat: bool = Query(default=True),
    db: Session = Depends(db_session),
    actor: User = Depends(current_admin),
) -> TaskDeleteResultRead:
    task = require_task_access(db, actor, task_id)
    try:
        return delete_task_with_dependencies(
            db,
            task=task,
            actor_email=actor.email,
            client=CvatClient(get_settings()) if delete_cvat else None,
            delete_cvat=delete_cvat,
        )
    except ActiveTaskJobsError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Task has active related jobs",
                "impact": exc.impact.model_dump(mode="json"),
            },
        ) from exc
    except CvatClientError as exc:
        raise HTTPException(status_code=502, detail=f"CVAT task delete failed: {exc}") from exc


@router.get("/{task_id}/data-meta", response_model=TaskDataMetaRead)
def get_task_data_meta(
    task_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> TaskDataMeta:
    task = require_task_access(db, user, task_id)
    external_id = task.external_id
    meta = db.scalar(select(TaskDataMeta).where(TaskDataMeta.task_external_id == external_id))
    if meta is None:
        raise HTTPException(status_code=404, detail="Task data meta not found")
    return meta


@router.get("/{task_id}/preview")
def get_task_preview(
    task_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Response:
    task = require_task_access(db, user, task_id)
    external_id = task.external_id
    client = CvatClient(get_settings())
    try:
        preview = client.retrieve_task_preview(external_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CVAT preview unavailable: {exc}") from exc
    return Response(content=preview.content, media_type=preview.content_type or "image/jpeg")


@router.get("/{task_id}/frame/{frame}")
def get_task_frame(
    task_id: str,
    frame: int,
    variant: str = Query(default="annotation", pattern="^(annotation|original)$"),
    max_side: int | None = Query(default=None, ge=256, le=8192),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Response:
    task = require_task_access(db, user, task_id)
    external_id = task.external_id
    if frame < 0:
        raise HTTPException(status_code=400, detail="Frame must be greater than or equal to zero")
    if task and task.size and frame >= task.size:
        raise HTTPException(status_code=404, detail="Frame not found")

    settings = get_settings()
    client = CvatClient(settings)
    try:
        if variant == "original":
            image = client.retrieve_task_frame(external_id, frame, quality="original")
            return Response(
                content=image.content,
                media_type=image.content_type or "image/jpeg",
                headers={"Cache-Control": "private, max-age=3600"},
            )

        preview = retrieve_annotation_frame_preview(
            client=client,
            settings=settings,
            task_id=external_id,
            frame=frame,
            max_side=max_side,
        )
        return Response(
            content=preview.content,
            media_type=preview.content_type,
            headers={
                "Cache-Control": "private, max-age=86400",
                "X-Frame-Variant": "annotation",
                "X-Frame-Preview-Source": preview.source,
            },
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"CVAT frame unavailable: {exc}") from exc


def _resolve_task(db: Session, task_id: str) -> Task | None:
    return db.get(Task, task_id) or db.scalar(select(Task).where(Task.external_id == task_id))


def _accessible_project_external_ids(db: Session, user: User) -> list[str]:
    if user.role == "admin":
        return [project.external_id for project in db.scalars(select(Project)).all()]
    return [
        project.external_id
        for project in db.scalars(
            select(Project)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user.id)
        ).all()
    ]


def _attach_annotation_progress(db: Session, tasks: list[Task]) -> None:
    external_ids = [task.external_id for task in tasks if task.external_id]
    if not external_ids:
        return
    active_annotation = ~AnnotationRecord.review_state.in_(
        ["deleted_by_reviewer", "needs_annotation", "rejected", "incorrect"]
    )
    annotation_counts = {
        str(task_external_id): int(count or 0)
        for task_external_id, count in db.execute(
            select(AnnotationRecord.task_external_id, func.count(AnnotationRecord.id))
            .where(AnnotationRecord.task_external_id.in_(external_ids), active_annotation)
            .group_by(AnnotationRecord.task_external_id)
        ).all()
        if task_external_id is not None
    }
    annotated_frame_counts = {
        str(task_external_id): int(count or 0)
        for task_external_id, count in db.execute(
            select(
                AnnotationRecord.task_external_id, func.count(func.distinct(AnnotationRecord.frame))
            )
            .where(
                AnnotationRecord.task_external_id.in_(external_ids),
                AnnotationRecord.frame.is_not(None),
                active_annotation,
            )
            .group_by(AnnotationRecord.task_external_id)
        ).all()
        if task_external_id is not None
    }

    for task in tasks:
        total_images = max(int(task.size or 0), 0)
        annotation_count = annotation_counts.get(task.external_id, 0)
        annotated_images = min(total_images, annotated_frame_counts.get(task.external_id, 0))
        if total_images == 1 and annotation_count and annotated_images == 0:
            annotated_images = 1
        percent = round((annotated_images / total_images) * 100) if total_images else 0
        raw = dict(task.raw or {})
        raw["annotation_progress"] = {
            "total_images": total_images,
            "annotated_images": annotated_images,
            "annotations": annotation_count,
            "percent": max(0, min(100, percent)),
        }
        task.raw = raw


def _backfill_import_assignees(db: Session, tasks: list[Task]) -> None:
    candidates = [task for task in tasks if task.external_id and not _local_assignee(task)]
    if not candidates:
        return
    external_ids = {task.external_id for task in candidates}
    import_jobs = db.scalars(
        select(JobRecord)
        .where(JobRecord.kind == "import", JobRecord.status == "succeeded")
        .order_by(JobRecord.updated_at.desc())
    ).all()
    jobs_by_task: dict[str, JobRecord] = {}
    for job in import_jobs:
        for cvat_task_id in _job_cvat_task_ids(job):
            if cvat_task_id in external_ids and cvat_task_id not in jobs_by_task:
                jobs_by_task[cvat_task_id] = job

    changed = False
    for task in candidates:
        job = jobs_by_task.get(task.external_id)
        if job is None:
            continue
        assignee = _import_job_actor(db, job)
        if assignee is None:
            continue
        assignee_payload = _assignee_payload(assignee)
        task.raw = {**(task.raw or {}), "local_assignee": assignee_payload}
        db.add(task)
        _ensure_project_membership(db, task, assignee)
        db.add(
            AuditEvent(
                actor="system",
                action="task_assignee_backfilled",
                target=task.id,
                payload={
                    "task_id": task.id,
                    "task_external_id": task.external_id,
                    "import_job_id": job.id,
                    "assignee": assignee_payload,
                },
            )
        )
        changed = True
    if changed:
        db.commit()


def _merge_task_labels(current_labels: list, task_labels: list[CvatLabel]) -> list:
    next_labels = list(current_labels)
    existing_names = {
        str(item.get("name") or item.get("label")).casefold()
        for item in next_labels
        if isinstance(item, dict) and (item.get("name") or item.get("label"))
    }
    for label in task_labels:
        name = label.name.strip()
        if not name or name.casefold() in existing_names:
            continue
        existing_names.add(name.casefold())
        next_labels.append(
            {
                "name": name,
                "color": label.color,
                "raw": {
                    **(label.raw or {}),
                    "project_external_id": label.project_external_id,
                    "task_external_id": label.task_external_id,
                },
            }
        )
    return next_labels


def _job_cvat_task_ids(job: JobRecord) -> list[str]:
    raw = job.raw if isinstance(job.raw, dict) else {}
    task_ids: list[str] = []
    raw_task_ids = raw.get("cvat_task_ids")
    if isinstance(raw_task_ids, list):
        task_ids.extend(str(task_id) for task_id in raw_task_ids if task_id)
    raw_task_id = raw.get("cvat_task_id")
    if raw_task_id:
        task_ids.append(str(raw_task_id))
    deduped: list[str] = []
    seen: set[str] = set()
    for task_id in task_ids:
        if task_id not in seen:
            seen.add(task_id)
            deduped.append(task_id)
    return deduped


def _local_assignee(task: Task) -> dict | None:
    assignee = (task.raw or {}).get("local_assignee")
    return assignee if isinstance(assignee, dict) else None


def _import_job_actor(db: Session, job: JobRecord) -> User | None:
    raw = job.raw or {}
    payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    assignee_user_id = payload.get("assignee_user_id")
    if assignee_user_id:
        user = db.get(User, str(assignee_user_id))
        if user is not None and user.status == "active" and user.role == "anotador":
            return user

    created_by = raw.get("created_by") if isinstance(raw.get("created_by"), dict) else {}
    actor_email = created_by.get("email")
    if not actor_email:
        event = db.scalar(
            select(AuditEvent)
            .where(AuditEvent.target == job.id, AuditEvent.action == "import_task_queued")
            .order_by(AuditEvent.created_at.desc())
        )
        actor_email = event.actor if event is not None else None
    if not actor_email:
        return None
    return db.scalar(
        select(User).where(
            User.email == str(actor_email), User.status == "active", User.role == "anotador"
        )
    )


def _assignee_payload(assignee: User) -> dict[str, str]:
    return {
        "user_id": assignee.id,
        "name": assignee.name,
        "email": assignee.email,
        "role": assignee.role,
    }


def _ensure_project_membership(db: Session, task: Task, assignee: User) -> None:
    if not task.project_external_id:
        return
    project = db.scalar(select(Project).where(Project.external_id == task.project_external_id))
    if project is None:
        return
    membership = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == assignee.id
        )
    )
    if membership is not None:
        return
    db.add(
        ProjectMember(
            project_id=project.id,
            user_id=assignee.id,
            role="anotador",
            raw={
                "source": "task_assignment",
                "task_id": task.id,
                "task_external_id": task.external_id,
            },
        )
    )
