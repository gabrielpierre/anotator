import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import current_admin, db_session
from app.models import AuditEvent, User
from app.schemas import AuditEventPage, AuditEventRead

router = APIRouter()


@router.get("/events", response_model=AuditEventPage)
def list_audit_events(
    actor: str | None = None,
    action: str | None = None,
    target: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> AuditEventPage:
    query = _filtered_query(actor, action, target, created_from, created_to)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = list(db.scalars(query.order_by(AuditEvent.created_at.desc()).offset(offset).limit(limit)).all())
    return AuditEventPage(
        items=[AuditEventRead.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/events/export")
def export_audit_events(
    actor: str | None = None,
    action: str | None = None,
    target: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    db: Session = Depends(db_session),
    _: User = Depends(current_admin),
) -> Response:
    rows = list(
        db.scalars(_filtered_query(actor, action, target, created_from, created_to).order_by(AuditEvent.created_at.desc()))
    )
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=["id", "created_at", "actor", "action", "target", "reason", "confidence", "payload"],
    )
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                "id": row.id,
                "created_at": row.created_at.isoformat(),
                "actor": row.actor,
                "action": row.action,
                "target": row.target,
                "reason": row.reason or "",
                "confidence": row.confidence if row.confidence is not None else "",
                "payload": row.payload or {},
            }
        )
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-events.csv"'},
    )


def _filtered_query(
    actor: str | None,
    action: str | None,
    target: str | None,
    created_from: datetime | None,
    created_to: datetime | None,
):
    query = select(AuditEvent)
    if actor:
        query = query.where(AuditEvent.actor.ilike(f"%{actor}%"))
    if action:
        query = query.where(AuditEvent.action == action)
    if target:
        query = query.where(AuditEvent.target.ilike(f"%{target}%"))
    if created_from:
        query = query.where(AuditEvent.created_at >= created_from)
    if created_to:
        query = query.where(AuditEvent.created_at <= created_to)
    return query
