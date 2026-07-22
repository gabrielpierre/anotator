from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_user, db_session, require_project_access
from app.api.project_scope import filter_visible_assets, project_for_asset, project_values, require_asset_access
from app.core.config import get_settings
from app.models import AuditEvent, DerivedAsset, User
from app.schemas import DerivedAssetRead, DerivedAssetReviewDecision, DerivedAssetUpdate
from app.services.artifacts import S3ArtifactStore

router = APIRouter()


@router.get("", response_model=list[DerivedAssetRead])
def list_derived_assets(
    project_id: str | None = Query(default=None, max_length=64),
    pipeline_run_id: str | None = None,
    dataset_release_id: str | None = None,
    split: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> list[DerivedAsset]:
    query = select(DerivedAsset)
    if pipeline_run_id:
        query = query.where(DerivedAsset.pipeline_run_id == pipeline_run_id)
    if dataset_release_id:
        query = query.where(DerivedAsset.dataset_release_id == dataset_release_id)
    if split:
        query = query.where(DerivedAsset.split == split)
    query = query.order_by(DerivedAsset.created_at.desc()).limit(limit)
    assets = list(db.scalars(query).all())
    if project_id:
        project = require_project_access(db, user, project_id)
        assets = [asset for asset in assets if project_values(project_for_asset(db, asset)) & project_values(project)]
    return filter_visible_assets(db, user, assets)


@router.patch("/{asset_id}", response_model=DerivedAssetRead)
def update_derived_asset(
    asset_id: str,
    payload: DerivedAssetUpdate,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> DerivedAsset:
    asset = require_asset_access(db, actor, asset_id)
    before = _asset_state(asset)
    if payload.label_name is not None:
        asset.label_name = payload.label_name
    if payload.split is not None:
        asset.split = payload.split
    if payload.status is not None:
        asset.status = payload.status
    if payload.human_corrections is not None:
        asset.human_corrections = {**(asset.human_corrections or {}), **payload.human_corrections}
    db.add(asset)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="derived_asset_updated",
            target=asset.id,
            payload={"before": before, "after": _asset_state(asset)},
        )
    )
    db.commit()
    db.refresh(asset)
    return asset


@router.post("/{asset_id}/review-decision", response_model=DerivedAssetRead)
def review_derived_asset(
    asset_id: str,
    payload: DerivedAssetReviewDecision,
    db: Session = Depends(db_session),
    actor: User = Depends(current_user),
) -> DerivedAsset:
    asset = require_asset_access(db, actor, asset_id)
    before = _asset_state(asset)
    if payload.corrected_label:
        asset.label_name = payload.corrected_label
    asset.status = payload.decision
    asset.human_corrections = {
        **(asset.human_corrections or {}),
        "decision": payload.decision,
        "actor": payload.actor or actor.email,
        "reason": payload.reason,
        "payload": payload.payload,
    }
    db.add(asset)
    db.add(
        AuditEvent(
            actor=actor.email,
            action="derived_asset_reviewed",
            target=asset.id,
            reason=payload.reason,
            payload={"before": before, "after": _asset_state(asset)},
        )
    )
    db.commit()
    db.refresh(asset)
    return asset


@router.get("/{asset_id}/download")
def download_derived_asset(
    asset_id: str,
    db: Session = Depends(db_session),
    user: User = Depends(current_user),
) -> Response:
    asset = require_asset_access(db, user, asset_id)
    if not asset.crop_uri:
        raise HTTPException(status_code=404, detail="Derived asset crop not found")
    try:
        blob = S3ArtifactStore(get_settings()).get(asset.crop_uri)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Derived asset crop not found") from exc
    return Response(
        content=blob.content,
        media_type=blob.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{asset.external_id.replace(":", "_")}"'},
    )


def _require_asset(db: Session, asset_id: str) -> DerivedAsset:
    asset = db.get(DerivedAsset, asset_id)
    if asset is None:
        asset = db.scalar(select(DerivedAsset).where(DerivedAsset.external_id == asset_id))
    if asset is None:
        raise HTTPException(status_code=404, detail="Derived asset not found")
    return asset


def _asset_state(asset: DerivedAsset) -> dict:
    return {
        "id": asset.id,
        "external_id": asset.external_id,
        "label_name": asset.label_name,
        "split": asset.split,
        "status": asset.status,
        "human_corrections": asset.human_corrections,
    }
