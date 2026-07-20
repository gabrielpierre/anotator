import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def uuid_str() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(64), default="active")
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    project_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(64), default="unknown")
    size: Mapped[int] = mapped_column(Integer, default=0)
    labels: Mapped[list] = mapped_column(JSON, default=list)
    preview_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class CvatLabel(Base, TimestampMixin):
    __tablename__ = "cvat_labels"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    color: Mapped[str | None] = mapped_column(String(64), nullable=True)
    project_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    task_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    attributes: Mapped[list] = mapped_column(JSON, default=list)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class TaskDataMeta(Base, TimestampMixin):
    __tablename__ = "task_data_meta"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_external_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    frame_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_frame: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stop_frame: Mapped[int | None] = mapped_column(Integer, nullable=True)
    frame_filter: Mapped[str | None] = mapped_column(String(255), nullable=True)
    frames: Mapped[list] = mapped_column(JSON, default=list)
    deleted_frames: Mapped[list] = mapped_column(JSON, default=list)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class TaskPreview(Base, TimestampMixin):
    __tablename__ = "task_previews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_external_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    url: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class AnnotationRecord(Base, TimestampMixin):
    __tablename__ = "annotation_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    cvat_job_id: Mapped[str] = mapped_column(String(64), index=True)
    task_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    annotation_type: Mapped[str] = mapped_column(String(32), index=True)
    cvat_annotation_id: Mapped[str] = mapped_column(String(64), index=True)
    frame: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    label_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    label_name: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    shape_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    points: Mapped[list] = mapped_column(JSON, default=list)
    review_state: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class InferenceSuggestion(Base, TimestampMixin):
    __tablename__ = "inference_suggestions"
    __table_args__ = (UniqueConstraint("external_id", name="uq_inference_suggestions_external_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    task_external_id: Mapped[str] = mapped_column(String(64), index=True)
    cvat_job_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    frame: Mapped[int] = mapped_column(Integer, index=True)
    model_id: Mapped[str] = mapped_column(String(128), index=True)
    model_version: Mapped[str] = mapped_column(String(128), index=True)
    model_family: Mapped[str] = mapped_column(String(64), index=True)
    label_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    label_name: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    nms_iou: Mapped[float | None] = mapped_column(Float, nullable=True)
    shape_type: Mapped[str] = mapped_column(String(64), default="rectangle")
    points: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="proposed", index=True)
    origin: Mapped[dict] = mapped_column(JSON, default=dict)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)


class AnnotationRevision(Base, TimestampMixin):
    __tablename__ = "annotation_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    annotation_external_id: Mapped[str] = mapped_column(String(160), index=True)
    cvat_job_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    decision: Mapped[str] = mapped_column(String(32), index=True)
    action: Mapped[str] = mapped_column(String(32), index=True)
    before: Mapped[dict] = mapped_column(JSON, default=dict)
    after: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String(255), default="local-user")
    cvat_synced: Mapped[bool] = mapped_column(default=False)
    cvat_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TrackRevision(Base, TimestampMixin):
    __tablename__ = "track_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    track_external_id: Mapped[str] = mapped_column(String(160), index=True)
    cvat_job_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    decision: Mapped[str] = mapped_column(String(32), index=True)
    action: Mapped[str] = mapped_column(String(32), index=True)
    before: Mapped[dict] = mapped_column(JSON, default=dict)
    after: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String(255), default="local-user")
    cvat_synced: Mapped[bool] = mapped_column(default=False)
    cvat_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class JobRecord(Base, TimestampMixin):
    __tablename__ = "job_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str | None] = mapped_column(String(128), unique=True, index=True, nullable=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[float] = mapped_column(Float, default=0)
    name: Mapped[str] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    task_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    resource_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReviewDecision(Base, TimestampMixin):
    __tablename__ = "review_decisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    cvat_job_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    external_annotation_id: Mapped[str] = mapped_column(String(128), index=True)
    decision: Mapped[str] = mapped_column(String(32), index=True)
    corrected_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor: Mapped[str] = mapped_column(String(255), default="local-user")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    cvat_synced: Mapped[bool] = mapped_column(default=False)
    cvat_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class DatasetRelease(Base, TimestampMixin):
    __tablename__ = "dataset_releases"
    __table_args__ = (UniqueConstraint("name", name="uq_dataset_releases_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(32), default="building", index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    task_external_ids: Mapped[list] = mapped_column(JSON, default=list)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    artifact_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    immutable: Mapped[bool] = mapped_column(default=True)


class TrainingRun(Base, TimestampMixin):
    __tablename__ = "training_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    dataset_release_id: Mapped[str] = mapped_column(String(36), index=True)
    model_family: Mapped[str] = mapped_column(String(64), default="detection")
    base_model: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[float] = mapped_column(Float, default=0)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    artifacts: Mapped[list] = mapped_column(JSON, default=list)


class ModelVersion(Base, TimestampMixin):
    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("name", "version", name="uq_model_versions_name_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), index=True)
    version: Mapped[str] = mapped_column(String(128), index=True)
    family: Mapped[str] = mapped_column(String(64), index=True)
    base_model: Mapped[str] = mapped_column(String(255))
    training_run_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    dataset_release_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    mlflow_run_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    artifact_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="registered", index=True)


class PipelineDefinition(Base, TimestampMixin):
    __tablename__ = "pipeline_definitions"
    __table_args__ = (UniqueConstraint("name", "version", name="uq_pipeline_definitions_name_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255), index=True)
    version: Mapped[str] = mapped_column(String(128), default="draft", index=True)
    graph: Mapped[dict] = mapped_column(JSON, default=dict)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)


class PipelineRun(Base, TimestampMixin):
    __tablename__ = "pipeline_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[float] = mapped_column(Float, default=0)
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    lineage: Mapped[dict] = mapped_column(JSON, default=dict)


class DerivedAsset(Base, TimestampMixin):
    __tablename__ = "derived_assets"
    __table_args__ = (UniqueConstraint("external_id", name="uq_derived_assets_external_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    external_id: Mapped[str] = mapped_column(String(220), unique=True, index=True)
    pipeline_run_id: Mapped[str] = mapped_column(String(36), index=True)
    dataset_release_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    source_task_external_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    source_annotation_id: Mapped[str | None] = mapped_column(String(160), index=True, nullable=True)
    source_track_id: Mapped[str | None] = mapped_column(String(160), index=True, nullable=True)
    frame: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    label_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    label_name: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    split: Mapped[str] = mapped_column(String(16), default="train", index=True)
    crop_uri: Mapped[str | None] = mapped_column(Text, nullable=True)
    preview_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    bbox: Mapped[dict] = mapped_column(JSON, default=dict)
    padding: Mapped[dict] = mapped_column(JSON, default=dict)
    model_id: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    human_corrections: Mapped[dict] = mapped_column(JSON, default=dict)
    lineage: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(32), default="ready", index=True)


class AuditEvent(Base, TimestampMixin):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    actor: Mapped[str] = mapped_column(String(255), default="system")
    action: Mapped[str] = mapped_column(String(128), index=True)
    target: Mapped[str] = mapped_column(String(255))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
