from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import ModelVersion
from app.schemas import ModelVersionRead

router = APIRouter()


@router.get("", response_model=list[ModelVersionRead])
def list_model_versions(db: Session = Depends(db_session)) -> list[ModelVersion]:
    return list(db.scalars(select(ModelVersion).order_by(ModelVersion.created_at.desc())).all())
