import hashlib
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.models import AnnotationRecord, AuditEvent, CvatLabel, DerivedAsset, InferenceSuggestion, Project, ProjectMember, Task, User
from app.schemas import CvatLabelRead, LabelActionResult, LabelColorUpdate, LabelImpactRead, LabelMap, LabelRename

router = APIRouter()


@router.get("", response_model=list[CvatLabelRead])
def list_labels(
    project_external_id: str | None = Query(default=None, max_length=64),
    task_external_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[CvatLabel]:
    if project_external_id or task_external_id:
        scope = _resolve_label_scope(db, user, project_external_id, task_external_id)
        return _labels_for_scope(db, scope)

    query = select(CvatLabel)
    if user.role != "admin":
        project_external_ids = _accessible_project_external_ids(db, user)
        task_external_ids = _task_external_ids_for_projects(db, project_external_ids)
        if not project_external_ids and not task_external_ids:
            return []
        conditions = []
        if project_external_ids:
            conditions.append(CvatLabel.project_external_id.in_(project_external_ids))
        if task_external_ids:
            conditions.append(CvatLabel.task_external_id.in_(task_external_ids))
        query = query.where(or_(*conditions))
    return list(db.scalars(query.order_by(CvatLabel.name, CvatLabel.task_external_id)).all())


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


@router.get("/impact", response_model=LabelImpactRead)
def get_label_impact(
    name: str = Query(min_length=1, max_length=255),
    project_external_id: str | None = Query(default=None, max_length=64),
    task_external_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> LabelImpactRead:
    scope = _resolve_label_scope(db, user, project_external_id, task_external_id)
    return _label_impact(db, name, scope)


@router.patch("/rename", response_model=LabelActionResult)
def rename_label(
    payload: LabelRename,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> LabelActionResult:
    source_name = _clean_label_name(payload.name)
    target_name = _clean_label_name(payload.new_name)
    if source_name.lower() == target_name.lower():
        raise HTTPException(status_code=400, detail="New label name must be different")

    scope = _resolve_label_scope(db, user, payload.project_external_id, payload.task_external_id)
    impact = _label_impact(db, source_name, scope)
    target_impact = _label_impact(db, target_name, scope)
    if _impact_total(target_impact) > 0:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Target label already exists. Use map instead of rename.",
                "impact": target_impact.model_dump(mode="json"),
            },
        )

    _rewrite_label_references(db, source_name, target_name, scope, merge_into_existing=False)
    _audit_label_action(db, user, "label_renamed", source_name, scope, impact, {"new_name": target_name})
    db.commit()
    return LabelActionResult(
        labels=_labels_for_scope(db, scope),
        impact=_label_impact(db, target_name, scope),
        warnings=_cvat_warnings(impact),
    )


@router.post("/map", response_model=LabelActionResult)
def map_label(
    payload: LabelMap,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> LabelActionResult:
    source_name = _clean_label_name(payload.source_name)
    target_name = _clean_label_name(payload.target_name)
    if source_name.lower() == target_name.lower():
        raise HTTPException(status_code=400, detail="Target label must be different")

    scope = _resolve_label_scope(db, user, payload.project_external_id, payload.task_external_id)
    impact = _label_impact(db, source_name, scope)
    _rewrite_label_references(db, source_name, target_name, scope, merge_into_existing=True)
    _audit_label_action(db, user, "label_mapped", source_name, scope, impact, {"target_name": target_name})
    db.commit()
    return LabelActionResult(
        labels=_labels_for_scope(db, scope),
        impact=_label_impact(db, target_name, scope),
        warnings=_cvat_warnings(impact),
    )


@router.delete("/{name}", response_model=LabelActionResult)
def delete_label(
    name: str,
    project_external_id: str | None = Query(default=None, max_length=64),
    task_external_id: str | None = Query(default=None, max_length=64),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> LabelActionResult:
    label_name = _clean_label_name(name)
    scope = _resolve_label_scope(db, user, project_external_id, task_external_id)
    impact = _label_impact(db, label_name, scope)
    if impact.used:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Label is in use. Map it to another label before deleting.",
                "impact": impact.model_dump(mode="json"),
            },
        )

    for label in _label_rows(db, scope, label_name):
        db.delete(label)
    _rewrite_task_labels(db, scope["tasks"], label_name, None, remove=True)
    _audit_label_action(db, user, "label_deleted", label_name, scope, impact, {})
    db.commit()
    return LabelActionResult(labels=_labels_for_scope(db, scope), impact=impact)


def _clean_hex_color(color: str) -> str | None:
    value = color.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return f"#{value[1]}{value[1]}{value[2]}{value[2]}{value[3]}{value[3]}".lower()
    return None


def _clean_label_name(name: str) -> str:
    value = name.strip()
    if not value:
        raise HTTPException(status_code=422, detail="Label name is required")
    return value


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


def _task_external_ids_for_projects(db: Session, project_external_ids: list[str]) -> list[str]:
    if not project_external_ids:
        return []
    return [
        task.external_id
        for task in db.scalars(select(Task).where(Task.project_external_id.in_(project_external_ids))).all()
    ]


def _label_digest(scope: str, name: str) -> str:
    return hashlib.sha1(f"{scope}:label:{name}".encode()).hexdigest()[:16]


def _resolve_label_scope(
    db: Session,
    user: User,
    project_external_id: str | None,
    task_external_id: str | None,
) -> dict:
    task = None
    if task_external_id:
        task = db.scalar(select(Task).where(Task.external_id == task_external_id))
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        if project_external_id and task.project_external_id and task.project_external_id != project_external_id:
            raise HTTPException(status_code=400, detail="Task does not belong to the selected project")
        project_external_id = project_external_id or task.project_external_id

    if project_external_id:
        require_project_access(db, user, project_external_id)
        tasks = list(db.scalars(select(Task).where(Task.project_external_id == project_external_id)).all())
        if task is not None:
            tasks = [task]
    elif task is not None:
        if task.project_external_id:
            require_project_access(db, user, task.project_external_id)
        elif user.role != "admin":
            raise HTTPException(status_code=403, detail="Project access required")
        tasks = [task]
    else:
        if user.role != "admin":
            raise HTTPException(status_code=403, detail="Project access required")
        tasks = list(db.scalars(select(Task)).all())

    return {
        "project_external_id": project_external_id,
        "task_external_id": task_external_id,
        "tasks": tasks,
    }


def _label_impact(db: Session, name: str, scope: dict) -> LabelImpactRead:
    label_name = _clean_label_name(name)
    task_external_ids = _task_external_ids(scope)
    strict_task_scope = _scope_requires_task_filter(scope)
    annotations = _count_label_name(
        db,
        AnnotationRecord,
        label_name,
        task_external_ids,
        "task_external_id",
        strict_empty=strict_task_scope,
    )
    suggestions = _count_label_name(
        db,
        InferenceSuggestion,
        label_name,
        task_external_ids,
        "task_external_id",
        strict_empty=strict_task_scope,
    )
    derived_assets = _count_label_name(
        db,
        DerivedAsset,
        label_name,
        task_external_ids,
        "source_task_external_id",
        strict_empty=strict_task_scope,
    )
    task_labels = sum(1 for task in scope["tasks"] if _task_has_label(task, label_name))
    labels = len(_label_rows(db, scope, label_name))
    return LabelImpactRead(
        name=label_name,
        labels=labels,
        task_labels=task_labels,
        annotations=annotations,
        suggestions=suggestions,
        derived_assets=derived_assets,
        used=(annotations + suggestions + derived_assets) > 0,
    )


def _impact_total(impact: LabelImpactRead) -> int:
    return impact.labels + impact.task_labels + impact.annotations + impact.suggestions + impact.derived_assets


def _count_label_name(
    db: Session,
    model: type,
    name: str,
    task_external_ids: list[str],
    task_field_name: str,
    *,
    strict_empty: bool = False,
) -> int:
    if strict_empty and not task_external_ids:
        return 0
    query = select(func.count(model.id)).where(func.lower(model.label_name) == name.lower())
    if task_external_ids:
        task_field = getattr(model, task_field_name)
        query = query.where(task_field.in_(task_external_ids))
    return int(db.scalar(query) or 0)


def _label_rows(db: Session, scope: dict, name: str | None = None) -> list[CvatLabel]:
    query = select(CvatLabel)
    conditions = []
    project_external_id = scope.get("project_external_id")
    task_external_ids = _task_external_ids(scope)
    if project_external_id:
        conditions.append(CvatLabel.project_external_id == project_external_id)
    if task_external_ids:
        conditions.append(CvatLabel.task_external_id.in_(task_external_ids))
    if conditions:
        query = query.where(or_(*conditions))
    if name is not None:
        query = query.where(func.lower(CvatLabel.name) == name.lower())
    return list(db.scalars(query.order_by(CvatLabel.name, CvatLabel.task_external_id)).all())


def _labels_for_scope(db: Session, scope: dict) -> list[CvatLabel]:
    labels = _label_rows(db, scope)
    for label in labels:
        db.refresh(label)
    return labels


def _task_external_ids(scope: dict) -> list[str]:
    return [task.external_id for task in scope["tasks"] if task.external_id]


def _task_has_label(task: Task, name: str) -> bool:
    return any(_task_label_name(item).lower() == name.lower() for item in task.labels or [])


def _task_label_name(item: object) -> str:
    if isinstance(item, dict):
        return str(item.get("name") or item.get("label") or "").strip()
    return str(item or "").strip()


def _rewrite_label_references(
    db: Session,
    source_name: str,
    target_name: str,
    scope: dict,
    *,
    merge_into_existing: bool,
) -> None:
    source_color = _label_color_for_name(db, scope, source_name)
    target_color = _label_color_for_name(db, scope, target_name) or source_color
    target_label_id = _label_raw_id_for_name(db, scope, target_name) or _label_raw_id_for_name(db, scope, source_name)
    task_external_ids = _task_external_ids(scope)
    strict_task_scope = _scope_requires_task_filter(scope)

    for annotation in _records_with_label(
        db,
        AnnotationRecord,
        source_name,
        task_external_ids,
        "task_external_id",
        strict_empty=strict_task_scope,
    ):
        annotation.label_name = target_name
        if target_label_id is not None:
            annotation.label_id = target_label_id
        annotation.raw = _rewrite_raw_label(annotation.raw, target_name, target_color, target_label_id)
        db.add(annotation)

    for suggestion in _records_with_label(
        db,
        InferenceSuggestion,
        source_name,
        task_external_ids,
        "task_external_id",
        strict_empty=strict_task_scope,
    ):
        suggestion.label_name = target_name
        if target_label_id is not None:
            suggestion.label_id = target_label_id
        suggestion.raw = _rewrite_raw_label(suggestion.raw, target_name, target_color, target_label_id)
        db.add(suggestion)

    for asset in _records_with_label(
        db,
        DerivedAsset,
        source_name,
        task_external_ids,
        "source_task_external_id",
        strict_empty=strict_task_scope,
    ):
        asset.label_name = target_name
        if target_label_id is not None:
            asset.label_id = target_label_id
        asset.human_corrections = _rewrite_raw_label(asset.human_corrections, target_name, target_color, target_label_id)
        db.add(asset)

    _rewrite_label_rows(db, source_name, target_name, scope, target_color, merge_into_existing=merge_into_existing)
    _rewrite_task_labels(db, scope["tasks"], source_name, target_name, color=target_color, remove=False)
    _ensure_catalog_label(db, scope, target_name, target_color)


def _records_with_label(
    db: Session,
    model: type,
    name: str,
    task_external_ids: list[str],
    task_field_name: str,
    *,
    strict_empty: bool = False,
) -> list:
    if strict_empty and not task_external_ids:
        return []
    query = select(model).where(func.lower(model.label_name) == name.lower())
    if task_external_ids:
        query = query.where(getattr(model, task_field_name).in_(task_external_ids))
    return list(db.scalars(query).all())


def _scope_requires_task_filter(scope: dict) -> bool:
    return bool(scope.get("project_external_id") or scope.get("task_external_id"))


def _rewrite_label_rows(
    db: Session,
    source_name: str,
    target_name: str,
    scope: dict,
    color: str | None,
    *,
    merge_into_existing: bool,
) -> None:
    source_rows = _label_rows(db, scope, source_name)
    target_rows = _label_rows(db, scope, target_name)
    should_merge = merge_into_existing and bool(target_rows)
    if should_merge:
        for label in source_rows:
            db.delete(label)
        return

    for label in source_rows:
        label.name = target_name
        if color:
            label.color = color
        label.raw = _rewrite_raw_label(label.raw, target_name, color, _int_or_none((label.raw or {}).get("id")))
        db.add(label)


def _rewrite_task_labels(
    db: Session,
    tasks: list[Task],
    source_name: str,
    target_name: str | None,
    *,
    color: str | None = None,
    remove: bool,
) -> None:
    for task in tasks:
        labels = list(task.labels or [])
        target_exists = bool(target_name) and any(
            _task_label_name(item).lower() == target_name.lower() for item in labels
        )
        next_labels = []
        changed = False
        for item in labels:
            if _task_label_name(item).lower() != source_name.lower():
                next_labels.append(item)
                continue
            changed = True
            if remove:
                continue
            if target_exists:
                continue
            next_labels.append(_rewrite_task_label_item(item, target_name or source_name, color))
            target_exists = True
        if changed:
            task.labels = next_labels
            db.add(task)


def _rewrite_task_label_item(item: object, name: str, color: str | None) -> dict:
    raw_item = item if isinstance(item, dict) else {"name": str(item)}
    raw = raw_item.get("raw") if isinstance(raw_item.get("raw"), dict) else {}
    next_item = {**raw_item, "name": name, "raw": {**raw, "name": name, "label_name": name}}
    if color:
        next_item["color"] = color
        next_item["raw"] = {**next_item["raw"], "color": color}
    return next_item


def _ensure_catalog_label(db: Session, scope: dict, name: str, color: str | None) -> None:
    label_color = color or "#4f8cff"
    project_external_id = scope.get("project_external_id")
    if project_external_id:
        existing = db.scalar(
            select(CvatLabel).where(
                CvatLabel.project_external_id == project_external_id,
                CvatLabel.task_external_id.is_(None),
                func.lower(CvatLabel.name) == name.lower(),
            )
        )
        if existing is None:
            db.add(
                CvatLabel(
                    external_id=f"manual:project:{project_external_id}:label:{_label_digest(project_external_id, name)}",
                    name=name,
                    color=label_color,
                    project_external_id=project_external_id,
                    task_external_id=None,
                    raw={
                        "origin": "cvat-plus",
                        "manual": True,
                        "scope": "project",
                        "color": label_color,
                        "project_external_id": project_external_id,
                    },
                )
            )
    for task in scope["tasks"]:
        _upsert_task_label_color(task, name, label_color, project_external_id)
        db.add(task)


def _rewrite_raw_label(raw: object, name: str, color: str | None, label_id: int | None) -> dict:
    next_raw = dict(raw) if isinstance(raw, dict) else {}
    next_raw["label_name"] = name
    if "label" in next_raw:
        next_raw["label"] = name
    if "name" in next_raw:
        next_raw["name"] = name
    if "class_name" in next_raw:
        next_raw["class_name"] = name
    if color:
        next_raw["label_color"] = color
        next_raw["color"] = color
    if label_id is not None:
        next_raw["label_id"] = label_id
    return next_raw


def _label_color_for_name(db: Session, scope: dict, name: str) -> str | None:
    for label in _label_rows(db, scope, name):
        if label.color:
            return label.color
        if isinstance(label.raw, dict) and label.raw.get("color"):
            return str(label.raw["color"])
    for task in scope["tasks"]:
        for item in task.labels or []:
            if _task_label_name(item).lower() == name.lower() and isinstance(item, dict) and item.get("color"):
                return str(item["color"])
    return None


def _label_raw_id_for_name(db: Session, scope: dict, name: str) -> int | None:
    for label in _label_rows(db, scope, name):
        raw_id = _int_or_none((label.raw or {}).get("id"))
        if raw_id is not None:
            return raw_id
    return None


def _int_or_none(value: object) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _audit_label_action(
    db: Session,
    user: User,
    action: str,
    name: str,
    scope: dict,
    impact: LabelImpactRead,
    extra: dict,
) -> None:
    target = scope.get("project_external_id") or scope.get("task_external_id") or name
    db.add(
        AuditEvent(
            actor=user.email,
            action=action,
            target=target,
            payload={
                "name": name,
                "project_external_id": scope.get("project_external_id"),
                "task_external_id": scope.get("task_external_id"),
                "impact": impact.model_dump(mode="json"),
                **extra,
            },
        )
    )


def _cvat_warnings(impact: LabelImpactRead) -> list[str]:
    if not impact.used:
        return []
    return ["A mudanca foi aplicada no CVAT++ local. Labels ja existentes no CVAT podem exigir sync manual."]


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
