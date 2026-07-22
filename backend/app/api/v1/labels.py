import hashlib
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.models import CvatLabel, Task, User
from app.schemas import CvatLabelRead, LabelColorUpdate

router = APIRouter()


@router.get("", response_model=list[CvatLabelRead])
def list_labels(db: Session = Depends(db_session)) -> list[CvatLabel]:
    return list(db.scalars(select(CvatLabel).order_by(CvatLabel.name)).all())


@router.patch("/color", response_model=list[CvatLabelRead])
def update_label_color(
    payload: LabelColorUpdate,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[CvatLabel]:
    name = payload.name.strip()
    color = _clean_hex_color(payload.color)
    if color is None:
        raise HTTPException(status_code=422, detail="Color must be a hex value like #4f8cff")

    task = None
    project_external_id = payload.project_external_id
    if payload.task_external_id:
        task = db.scalar(select(Task).where(Task.external_id == payload.task_external_id))
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        project_external_id = project_external_id or task.project_external_id

    if project_external_id:
        require_project_access(db, user, project_external_id)
    elif user.role != "admin":
        raise HTTPException(status_code=403, detail="Project access required")

    labels: list[CvatLabel] = []
    if project_external_id:
        tasks = list(db.scalars(select(Task).where(Task.project_external_id == project_external_id)).all())
        task_external_ids = [row.external_id for row in tasks]
        label_filters = [CvatLabel.project_external_id == project_external_id]
        if task_external_ids:
            label_filters.append(CvatLabel.task_external_id.in_(task_external_ids))
        labels = list(
            db.scalars(
                select(CvatLabel).where(CvatLabel.name == name, or_(*label_filters))
            ).all()
        )
        project_label = next(
            (label for label in labels if label.project_external_id == project_external_id and label.task_external_id is None),
            None,
        )
        if project_label is None:
            project_label = CvatLabel(
                external_id=f"manual:project:{project_external_id}:label:{_label_digest(project_external_id, name)}",
                name=name,
                color=color,
                project_external_id=project_external_id,
                task_external_id=None,
                raw={
                    "origin": "cvat-plus",
                    "manual": True,
                    "scope": "project",
                    "color": color,
                    "project_external_id": project_external_id,
                },
            )
            db.add(project_label)
            labels.append(project_label)
        for row_task in tasks:
            _upsert_task_label_color(row_task, name, color, project_external_id)
            db.add(row_task)
    elif task is not None:
        labels = list(
            db.scalars(
                select(CvatLabel).where(CvatLabel.name == name, CvatLabel.task_external_id == task.external_id)
            ).all()
        )
        if not labels:
            labels.append(
                CvatLabel(
                    external_id=f"manual:{task.external_id}:label:{_label_digest(task.external_id, name)}",
                    name=name,
                    color=color,
                    project_external_id=None,
                    task_external_id=task.external_id,
                    raw={"origin": "cvat-plus", "manual": True, "scope": "task", "color": color},
                )
            )
            db.add(labels[-1])
        _upsert_task_label_color(task, name, color, None)
        db.add(task)

    for label in labels:
        label.color = color
        label.raw = {**(label.raw or {}), "color": color}
        db.add(label)

    db.commit()
    for label in labels:
        db.refresh(label)
    return sorted(labels, key=lambda label: (label.task_external_id or "", label.external_id))


def _clean_hex_color(color: str) -> str | None:
    value = color.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return f"#{value[1]}{value[1]}{value[2]}{value[2]}{value[3]}{value[3]}".lower()
    return None


def _label_digest(scope: str, name: str) -> str:
    return hashlib.sha1(f"{scope}:label:{name}".encode()).hexdigest()[:16]


def _upsert_task_label_color(task: Task, name: str, color: str, project_external_id: str | None) -> None:
    labels = list(task.labels or [])
    updated = False
    for index, item in enumerate(labels):
        if not isinstance(item, dict):
            continue
        item_name = str(item.get("name") or item.get("label") or "").strip()
        if item_name.lower() != name.lower():
            continue
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        labels[index] = {**item, "name": name, "color": color, "raw": {**raw, "color": color}}
        updated = True
    if not updated:
        labels.append(
            {
                "name": name,
                "color": color,
                "raw": {
                    "origin": "cvat-plus",
                    "manual": True,
                    "scope": "project" if project_external_id else "task",
                    "color": color,
                    "project_external_id": project_external_id,
                },
            }
        )
    task.labels = labels
