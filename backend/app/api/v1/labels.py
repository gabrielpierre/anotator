from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import CvatLabel
from app.schemas import CvatLabelRead

router = APIRouter()


@router.get("", response_model=list[CvatLabelRead])
def list_labels(db: Session = Depends(db_session)) -> list[CvatLabel]:
    return list(db.scalars(select(CvatLabel).order_by(CvatLabel.name)).all())
