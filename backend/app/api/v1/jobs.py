import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.models import JobRecord
from app.schemas import JobRead
from app.services.jobs import cancel_job

router = APIRouter()


@router.get("", response_model=list[JobRead])
def list_jobs(db: Session = Depends(db_session)) -> list[JobRecord]:
    return list(db.scalars(select(JobRecord).order_by(JobRecord.updated_at.desc())).all())


@router.get("/events")
async def job_events() -> StreamingResponse:
    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as db:
                jobs = list(db.scalars(select(JobRecord).order_by(JobRecord.updated_at.desc())).all())
                payload = {"jobs": [_serialize_job(job) for job in jobs]}
            yield f"event: jobs\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: str, db: Session = Depends(db_session)) -> JobRecord:
    job = db.get(JobRecord, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/{job_id}/cancel", response_model=JobRead)
def cancel_job_endpoint(job_id: str, db: Session = Depends(db_session)) -> JobRecord:
    try:
        return cancel_job(db, job_id, celery_app=celery_app)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{job_id}/events")
async def job_detail_events(job_id: str) -> StreamingResponse:
    async def event_stream() -> AsyncIterator[str]:
        while True:
            with SessionLocal() as db:
                job = db.get(JobRecord, job_id)
                if job is None:
                    yield f"event: error\ndata: {json.dumps({'detail': 'Job not found'})}\n\n"
                    return
                payload = _serialize_job(job)
            yield f"event: job\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _serialize_job(job: JobRecord) -> dict:
    return JobRead.model_validate(job).model_dump(mode="json")
