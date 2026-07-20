from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.schemas import HealthRead

router = APIRouter()


@router.get("/health", response_model=HealthRead)
def health(db: Session = Depends(db_session)) -> HealthRead:
    db.execute(text("select 1"))
    return HealthRead(status="ok", database="ok")
