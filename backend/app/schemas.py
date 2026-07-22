from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

JobStatus = Literal["queued", "running", "paused", "succeeded", "failed", "canceled"]
ReviewDecisionValue = Literal[
    "accepted",
    "needs_annotation",
    "corrected",
    "deleted_by_reviewer",
    "rejected",
    "uncertain",
    "escalated",
]
AnnotationType = Literal["shape", "track", "tag"]
InferenceModelFamily = Literal["detection", "segmentation", "classification", "tracking"]
InferenceApplyMode = Literal["append", "replace"]
UserRole = Literal["admin", "anotador"]


class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class HealthRead(BaseModel):
    status: str
    database: str
    service: str = "anotator-backend"


class DirectoryEntryRead(BaseModel):
    name: str
    path: str


class DirectoryListingRead(BaseModel):
    path: str
    parent: str | None = None
    entries: list[DirectoryEntryRead] = Field(default_factory=list)


class CvatStatusRead(BaseModel):
    configured: bool
    reachable: bool
    base_url: str
    authenticated: bool
    version: str | None = None
    error: str | None = None


class UserRead(OrmModel):
    id: str
    name: str
    email: str
    role: str
    status: str
    avatar_url: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=255)
    role: UserRole = "anotador"
    avatar_url: str | None = None


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    email: str | None = Field(default=None, min_length=3, max_length=255)
    password: str | None = Field(default=None, min_length=6, max_length=255)
    current_password: str | None = Field(default=None, min_length=1, max_length=255)
    role: UserRole | None = None
    status: Literal["active", "inactive"] | None = None
    avatar_url: str | None = None


class AuthLogin(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=255)


class AuthSessionRead(BaseModel):
    token: str
    expires_at: datetime
    user: UserRead


class ProjectMemberRead(OrmModel):
    id: str
    project_id: str
    user_id: str
    role: str
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ProjectMembersPut(BaseModel):
    user_ids: list[str] = Field(default_factory=list)


class ProjectRead(OrmModel):
    id: str
    external_id: str
    name: str
    status: str
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    external_id: str | None = Field(default=None, max_length=64)
    storage_path: str = Field(min_length=1, max_length=1024)
    storage_quota_gb: int = Field(default=40, ge=1, le=100_000)
    warn_at_percent: int = Field(default=85, ge=1, le=100)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    storage_path: str | None = Field(default=None, min_length=1, max_length=1024)
    storage_quota_gb: int | None = Field(default=None, ge=1, le=100_000)
    warn_at_percent: int | None = Field(default=None, ge=1, le=100)


class TaskRead(OrmModel):
    id: str
    external_id: str
    project_external_id: str | None = None
    name: str
    status: str
    size: int
    labels: list[Any] = Field(default_factory=list)
    preview_url: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class TaskAssigneeUpdate(BaseModel):
    user_id: str | None = None


class TaskDeleteBlockingJob(BaseModel):
    id: str
    kind: str
    status: str
    name: str
    detail: str | None = None


class TaskDeleteImpactRead(BaseModel):
    task_id: str
    task_external_id: str
    task_name: str
    image_count: int
    annotations: int
    inference_suggestions: int
    labels: int
    cvat_jobs: int
    dataset_releases: int
    derived_assets: int
    pipeline_runs: int
    active_jobs: list[TaskDeleteBlockingJob] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    blocking: bool = False


class TaskDeleteResultRead(BaseModel):
    task_id: str
    task_external_id: str
    task_name: str
    cvat_deleted: bool
    deleted: dict[str, int] = Field(default_factory=dict)
    preserved: dict[str, int] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class CvatLabelRead(OrmModel):
    id: str
    external_id: str
    name: str
    color: str | None = None
    project_external_id: str | None = None
    task_external_id: str | None = None
    attributes: list[Any] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class LabelColorUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(min_length=1, max_length=64)
    project_external_id: str | None = Field(default=None, max_length=64)
    task_external_id: str | None = Field(default=None, max_length=64)


class LabelRename(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    new_name: str = Field(min_length=1, max_length=255)
    project_external_id: str | None = Field(default=None, max_length=64)
    task_external_id: str | None = Field(default=None, max_length=64)


class LabelMap(BaseModel):
    source_name: str = Field(min_length=1, max_length=255)
    target_name: str = Field(min_length=1, max_length=255)
    project_external_id: str | None = Field(default=None, max_length=64)
    task_external_id: str | None = Field(default=None, max_length=64)


class LabelImpactRead(BaseModel):
    name: str
    labels: int = 0
    task_labels: int = 0
    annotations: int = 0
    suggestions: int = 0
    derived_assets: int = 0
    used: bool = False


class LabelActionResult(BaseModel):
    labels: list[CvatLabelRead] = Field(default_factory=list)
    impact: LabelImpactRead
    warnings: list[str] = Field(default_factory=list)


class TaskDataMetaRead(OrmModel):
    id: str
    task_external_id: str
    frame_count: int
    chunk_size: int | None = None
    start_frame: int | None = None
    stop_frame: int | None = None
    frame_filter: str | None = None
    frames: list[Any] = Field(default_factory=list)
    deleted_frames: list[Any] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class TaskPreviewRead(OrmModel):
    id: str
    task_external_id: str
    url: str
    content_type: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class JobRead(OrmModel):
    id: str
    external_id: str | None = None
    kind: str
    status: JobStatus
    progress: float
    name: str
    detail: str | None = None
    task_external_id: str | None = None
    resource_metrics: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class JobCapacityRead(BaseModel):
    queued: int
    running: int
    active: int
    cpu_count: int
    memory_total_bytes: int | None = None
    memory_available_bytes: int | None = None
    gpu: dict[str, Any] = Field(default_factory=dict)


class JobPriorityUpdate(BaseModel):
    priority: int = Field(ge=0, le=1000)


class JobMetricsRead(BaseModel):
    job_id: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    snapshots: list[dict[str, Any]] = Field(default_factory=list)


class AnnotationRecordRead(OrmModel):
    id: str
    external_id: str
    cvat_job_id: str
    task_external_id: str | None = None
    annotation_type: str
    cvat_annotation_id: str
    frame: int | None = None
    label_id: int | None = None
    label_name: str | None = None
    shape_type: str | None = None
    source: str | None = None
    confidence: float | None = None
    points: list[Any] = Field(default_factory=list)
    review_state: str
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ManualAnnotationShape(BaseModel):
    client_id: str
    shape_type: Literal["rectangle", "polygon", "points"]
    label_name: str
    label_color: str | None = Field(default=None, max_length=64)
    points: list[float] = Field(default_factory=list)
    bbox_norm: dict[str, float] | None = None


class ManualAnnotationSave(BaseModel):
    task_external_id: str
    frame: int = Field(ge=0)
    shapes: list[ManualAnnotationShape] = Field(default_factory=list)
    actor: str = "local-user"
    sync_cvat: bool = True
    replace_existing: bool = False


class InferenceRunCreate(BaseModel):
    task_external_id: str
    cvat_job_id: str | None = None
    model_id: str = "yolo11n"
    model_version: str = "local"
    model_family: InferenceModelFamily = "detection"
    base_model: str = "yolo11n.pt"
    frame_start: int = Field(default=0, ge=0)
    frame_end: int | None = Field(default=None, ge=0)
    threshold: float = Field(default=0.35, ge=0, le=1)
    nms_iou: float = Field(default=0.45, ge=0, le=1)
    classes: list[str] = Field(default_factory=list)
    apply_mode: InferenceApplyMode = "append"
    confirm_replace: bool = False
    user_id: str = "local-user"
    write_to_cvat: bool = False
    dedupe_key: str | None = Field(default=None, max_length=512)


class InferenceSuggestionRead(OrmModel):
    id: str
    external_id: str
    task_external_id: str
    cvat_job_id: str | None = None
    frame: int
    model_id: str
    model_version: str
    model_family: str
    label_id: int | None = None
    label_name: str | None = None
    score: float | None = None
    threshold: float | None = None
    nms_iou: float | None = None
    shape_type: str
    points: list[Any] = Field(default_factory=list)
    status: str
    origin: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class InferenceSuggestionStatusUpdate(BaseModel):
    status: Literal["proposed", "accepted", "rejected"]


class ClassDistribution(BaseModel):
    name: str
    count: int
    share: float


class DashboardStats(BaseModel):
    projects: int = 0
    tasks: int = 0
    images: int = 0
    jobs_running: int = 0
    pending_review: int = 0
    dataset_releases: int = 0
    training_runs: int = 0


class ProjectDashboardRead(BaseModel):
    project: ProjectRead | None
    stats: DashboardStats
    class_distribution: list[ClassDistribution] = Field(default_factory=list)
    recent_jobs: list[JobRead] = Field(default_factory=list)


class SyncError(BaseModel):
    scope: str
    external_id: str | None = None
    message: str


class SyncResult(BaseModel):
    job: JobRead
    projects_synced: int
    tasks_synced: int
    jobs_synced: int
    annotations_synced: int = 0
    labels_synced: int = 0
    data_meta_synced: int = 0
    previews_synced: int = 0
    errors: list[SyncError] = Field(default_factory=list)


class ReviewDecisionCreate(BaseModel):
    external_annotation_id: str
    decision: ReviewDecisionValue
    annotation_type: AnnotationType | None = None
    cvat_job_id: str | None = None
    corrected_label: str | None = None
    corrected_label_id: int | None = None
    reason: str | None = None
    actor: str = "local-user"
    patch_cvat: bool = True
    payload: dict[str, Any] = Field(default_factory=dict)


class ReviewDecisionRead(OrmModel):
    id: str
    cvat_job_id: str | None = None
    external_annotation_id: str
    decision: str
    corrected_label: str | None = None
    reason: str | None = None
    actor: str
    payload: dict[str, Any] = Field(default_factory=dict)
    cvat_synced: bool
    cvat_error: str | None = None
    created_at: datetime
    updated_at: datetime


class AnnotationRevisionRead(OrmModel):
    id: str
    annotation_external_id: str
    cvat_job_id: str | None = None
    decision: str
    action: str
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    actor: str
    cvat_synced: bool
    cvat_error: str | None = None
    created_at: datetime
    updated_at: datetime


class TrackRevisionRead(OrmModel):
    id: str
    track_external_id: str
    cvat_job_id: str | None = None
    decision: str
    action: str
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    actor: str
    cvat_synced: bool
    cvat_error: str | None = None
    created_at: datetime
    updated_at: datetime


class ReviewQueueItem(BaseModel):
    external_annotation_id: str | None = None
    cvat_job_id: str | None = None
    task_external_id: str | None = None
    task_name: str | None = None
    preview_url: str | None = None
    status: str | None = None
    annotation_type: AnnotationType | None = None
    cvat_annotation_id: str | None = None
    frame: int | None = None
    shape_type: str | None = None
    points: list[Any] = Field(default_factory=list)
    review_state: str | None = None
    label: str | None = None
    label_id: int | None = None
    confidence: float | None = None
    origin: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class DatasetReleaseCreate(BaseModel):
    name: str
    project_id: str | None = None
    task_external_ids: list[str] = Field(default_factory=list)
    job_external_ids: list[str] = Field(default_factory=list)
    export_format: str | None = None
    include_images: bool = True
    splits: dict[str, Any] = Field(
        default_factory=lambda: {"train": 0.8, "val": 0.1, "test": 0.1}
    )
    snapshot: dict[str, Any] = Field(default_factory=dict)


class DatasetReleaseRead(OrmModel):
    id: str
    name: str
    status: str
    project_id: str | None = None
    task_external_ids: list[str] = Field(default_factory=list)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    artifact_uri: str | None = None
    immutable: bool
    created_at: datetime
    updated_at: datetime


class ArtifactRead(BaseModel):
    id: str
    name: str
    kind: str = "artifact"
    content_type: str | None = None
    size_bytes: int | None = None
    download_url: str
    owner_type: str | None = None
    owner_id: str | None = None


class ArtifactPresignRead(BaseModel):
    url: str
    expires_in_seconds: int
    method: str = "GET"


class PreparedDatasetRead(BaseModel):
    release_id: str
    status: str
    artifact_uri: str | None = None
    download_url: str | None = None
    data_yaml: dict[str, Any] | None = None
    manifest: dict[str, Any] | None = None


class TrainingRunCreate(BaseModel):
    dataset_release_id: str
    base_model: str
    model_family: str = "detection"
    epochs: int = Field(default=100, ge=1)
    image_size: int = Field(default=640, ge=32)
    batch_size: int = Field(default=16, ge=1)
    device: str | None = None
    workers: int = Field(default=8, ge=0)
    patience: int | None = Field(default=30, ge=0)
    seed: int = 42
    config: dict[str, Any] = Field(default_factory=dict)


class TrainingRunRead(OrmModel):
    id: str
    dataset_release_id: str
    model_family: str
    base_model: str
    status: JobStatus
    progress: float
    mlflow_run_id: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[Any] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ModelVersionRead(OrmModel):
    id: str
    name: str
    version: str
    family: str
    base_model: str
    training_run_id: str | None = None
    dataset_release_id: str | None = None
    mlflow_run_id: str | None = None
    artifact_uri: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime
    updated_at: datetime


class ModelVersionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    version: str = Field(min_length=1, max_length=128)
    family: str = Field(default="detection", max_length=64)
    base_model: str = Field(default="manual", max_length=255)
    project_id: str | None = None
    dataset_release_id: str | None = None
    artifact_uri: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    status: str = "registered"


class ModelVersionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    version: str | None = Field(default=None, min_length=1, max_length=128)
    family: str | None = Field(default=None, max_length=64)
    base_model: str | None = Field(default=None, max_length=255)
    project_id: str | None = None
    dataset_release_id: str | None = None
    artifact_uri: str | None = None
    metrics: dict[str, Any] | None = None
    params: dict[str, Any] | None = None
    status: str | None = None


class ModelImportRead(BaseModel):
    model: ModelVersionRead
    artifact: ArtifactRead


class PipelineDefinitionCreate(BaseModel):
    name: str
    version: str = "draft"
    graph: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)


class PipelineDefinitionRead(OrmModel):
    id: str
    name: str
    version: str
    graph: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime
    updated_at: datetime


class PipelineRunCreate(BaseModel):
    name: str
    definition_id: str | None = None
    project_id: str | None = None
    source_release_id: str | None = None
    target_release_name: str | None = None
    task_external_ids: list[str] = Field(default_factory=list)
    sample_policy: dict[str, Any] = Field(default_factory=dict)
    definition: dict[str, Any] = Field(default_factory=dict)
    lineage: dict[str, Any] = Field(default_factory=dict)


class PipelineRunRead(OrmModel):
    id: str
    name: str
    status: JobStatus
    progress: float
    definition: dict[str, Any] = Field(default_factory=dict)
    lineage: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class DerivedAssetRead(OrmModel):
    id: str
    external_id: str
    pipeline_run_id: str
    dataset_release_id: str | None = None
    source_task_external_id: str | None = None
    source_annotation_id: str | None = None
    source_track_id: str | None = None
    frame: int | None = None
    label_id: int | None = None
    label_name: str | None = None
    split: str
    crop_uri: str | None = None
    preview_url: str | None = None
    bbox: dict[str, Any] = Field(default_factory=dict)
    padding: dict[str, Any] = Field(default_factory=dict)
    model_id: str | None = None
    model_version: str | None = None
    score: float | None = None
    human_corrections: dict[str, Any] = Field(default_factory=dict)
    lineage: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime
    updated_at: datetime


class DerivedAssetUpdate(BaseModel):
    label_name: str | None = None
    split: Literal["train", "val", "test"] | None = None
    status: str | None = None
    human_corrections: dict[str, Any] | None = None


class DerivedAssetReviewDecision(BaseModel):
    decision: ReviewDecisionValue
    actor: str = "local-user"
    reason: str | None = None
    corrected_label: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AuditEventRead(OrmModel):
    id: str
    actor: str
    action: str
    target: str
    reason: str | None = None
    confidence: float | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class AuditEventPage(BaseModel):
    items: list[AuditEventRead]
    total: int
    limit: int
    offset: int


class ImportTaskCreate(BaseModel):
    project_id: str | None = None
    name: str = Field(min_length=1, max_length=255)
    assignee_user_id: str | None = None
    labels: list[dict[str, Any]] = Field(default_factory=list)
    class_mappings: list[dict[str, Any]] = Field(default_factory=list)
    source_path: str | None = Field(default=None, max_length=2048)
    estimated_bytes: int | None = Field(default=None, ge=0)
    sync_after_import: bool = True


class ImportJobRead(BaseModel):
    job: JobRead


class TrackActionPayload(BaseModel):
    actor: str = "local-user"
    reason: str | None = None
    frame: int | None = Field(default=None, ge=0)
    label_id: int | None = None
    label_name: str | None = None
    points: list[Any] = Field(default_factory=list)
    payload: dict[str, Any] = Field(default_factory=dict)
