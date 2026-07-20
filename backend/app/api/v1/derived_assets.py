from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import db_session
from app.models import DerivedAsset
from app.schemas import DerivedAssetRead

router = APIRouter()


@router.get("", response_model=list[DerivedAssetRead])
def list_derived_assets(
    pipeline_run_id: str | None = None,
    dataset_release_id: str | None = None,
    split: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(db_session),
) -> list[DerivedAsset]:
    query = select(DerivedAsset)
    if pipeline_run_id:
        query = query.where(DerivedAsset.pipeline_run_id == pipeline_run_id)
    if dataset_release_id:
        query = query.where(DerivedAsset.dataset_release_id == dataset_release_id)
    if split:
        query = query.where(DerivedAsset.split == split)
    query = query.order_by(DerivedAsset.created_at.desc()).limit(limit)
    return list(db.scalars(query).all())
