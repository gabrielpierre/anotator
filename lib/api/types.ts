export type BackendJobStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "canceled"

export type BackendUserRole = "admin" | "anotador"

export type BackendUser = {
  id: string
  name: string
  email: string
  role: BackendUserRole
  status: string
  avatar_url: string | null
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendUserCreate = {
  name: string
  email: string
  password: string
  role: BackendUserRole
  avatar_url?: string | null
}

export type BackendUserUpdate = {
  name?: string
  email?: string
  password?: string
  current_password?: string
  role?: BackendUserRole
  status?: "active" | "inactive"
  avatar_url?: string | null
}

export type BackendAuthSession = {
  token: string
  expires_at: string
  user: BackendUser
}

export type BackendProjectMember = {
  id: string
  project_id: string
  user_id: string
  role: string
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendProject = {
  id: string
  external_id: string
  name: string
  status: string
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendProjectCreate = {
  name: string
  external_id?: string | null
  storage_path: string
  storage_quota_gb: number
  warn_at_percent?: number
}

export type BackendProjectUpdate = {
  name?: string
  storage_path?: string
  storage_quota_gb?: number
  warn_at_percent?: number
}

export type BackendDirectoryEntry = {
  name: string
  path: string
}

export type BackendDirectoryListing = {
  path: string
  parent: string | null
  entries: BackendDirectoryEntry[]
}

export type BackendTask = {
  id: string
  external_id: string
  project_external_id: string | null
  name: string
  status: string
  size: number
  labels: unknown[]
  preview_url: string | null
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendCvatLabel = {
  id: string
  external_id: string
  name: string
  color: string | null
  project_external_id: string | null
  task_external_id: string | null
  attributes: unknown[]
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendTaskDataMeta = {
  id: string
  task_external_id: string
  frame_count: number
  chunk_size: number | null
  start_frame: number | null
  stop_frame: number | null
  frame_filter: string | null
  frames: unknown[]
  deleted_frames: unknown[]
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendReviewQueueItem = {
  external_annotation_id: string | null
  cvat_job_id: string | null
  task_external_id: string | null
  task_name: string | null
  preview_url: string | null
  status: string | null
  annotation_type: "shape" | "track" | "tag" | null
  cvat_annotation_id: string | null
  frame: number | null
  shape_type: string | null
  points: unknown[]
  review_state: string | null
  label: string | null
  label_id: number | null
  confidence: number | null
  origin: string | null
  payload: Record<string, unknown>
}

export type BackendReviewQueueCount = {
  pending: number
}

export type BackendAnnotationRecord = {
  id: string
  external_id: string
  cvat_job_id: string
  task_external_id: string | null
  annotation_type: string
  cvat_annotation_id: string
  frame: number | null
  label_id: number | null
  label_name: string | null
  shape_type: string | null
  source: string | null
  confidence: number | null
  points: unknown[]
  review_state: string
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendManualAnnotationShape = {
  client_id: string
  shape_type: "rectangle" | "polygon" | "points"
  label_name: string
  points: number[]
  bbox_norm?: Record<string, number> | null
}

export type BackendManualAnnotationSave = {
  task_external_id: string
  frame: number
  shapes: BackendManualAnnotationShape[]
  actor?: string
  sync_cvat?: boolean
  replace_existing?: boolean
}

export type BackendReviewDecisionValue =
  | "accepted"
  | "needs_annotation"
  | "corrected"
  | "deleted_by_reviewer"
  | "rejected"
  | "uncertain"
  | "escalated"

export type BackendReviewDecisionCreate = {
  external_annotation_id: string
  decision: BackendReviewDecisionValue
  annotation_type?: "shape" | "track" | "tag" | null
  cvat_job_id?: string | null
  corrected_label?: string | null
  corrected_label_id?: number | null
  reason?: string | null
  actor?: string
  patch_cvat?: boolean
  payload?: Record<string, unknown>
}

export type BackendReviewDecision = {
  id: string
  cvat_job_id: string | null
  external_annotation_id: string
  decision: string
  corrected_label: string | null
  reason: string | null
  actor: string
  payload: Record<string, unknown>
  cvat_synced: boolean
  cvat_error: string | null
  created_at: string
  updated_at: string
}

export type BackendJob = {
  id: string
  external_id: string | null
  kind: string
  status: BackendJobStatus
  progress: number
  name: string
  detail: string | null
  task_external_id: string | null
  resource_metrics: Record<string, unknown>
  raw: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type BackendJobCapacity = {
  queued: number
  running: number
  active: number
  cpu_count: number
  memory_total_bytes: number | null
  memory_available_bytes: number | null
  gpu: Record<string, unknown>
}

export type BackendJobMetrics = {
  job_id: string
  metrics: Record<string, unknown>
  snapshots: Record<string, unknown>[]
}

export type BackendInferenceRunCreate = {
  task_external_id: string
  cvat_job_id?: string | null
  model_id?: string
  model_version?: string
  model_family?: "detection" | "segmentation" | "classification" | "tracking"
  base_model?: string
  frame_start?: number
  frame_end?: number | null
  threshold?: number
  nms_iou?: number
  classes?: string[]
  apply_mode?: "append" | "replace"
  confirm_replace?: boolean
  user_id?: string
  write_to_cvat?: boolean
}

export type BackendInferenceSuggestion = {
  id: string
  external_id: string
  task_external_id: string
  cvat_job_id: string | null
  frame: number
  model_id: string
  model_version: string
  model_family: string
  label_id: number | null
  label_name: string | null
  score: number | null
  threshold: number | null
  nms_iou: number | null
  shape_type: string
  points: unknown[]
  status: string
  origin: Record<string, unknown>
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendClassDistribution = {
  name: string
  count: number
  share: number
}

export type BackendDashboard = {
  project: BackendProject | null
  stats: {
    projects: number
    tasks: number
    images: number
    jobs_running: number
    pending_review: number
    dataset_releases: number
    training_runs: number
  }
  class_distribution: BackendClassDistribution[]
  recent_jobs: BackendJob[]
}

export type BackendCvatStatus = {
  configured: boolean
  reachable: boolean
  base_url: string
  authenticated: boolean
  version: string | null
  error: string | null
}

export type BackendDatasetRelease = {
  id: string
  name: string
  status: string
  project_id: string | null
  task_external_ids: string[]
  snapshot: Record<string, unknown>
  artifact_uri: string | null
  immutable: boolean
  created_at: string
  updated_at: string
}

export type BackendArtifact = {
  id: string
  name: string
  kind: string
  content_type: string | null
  size_bytes: number | null
  download_url: string
  owner_type: string | null
  owner_id: string | null
}

export type BackendPreparedDataset = {
  release_id: string
  status: string
  artifact_uri: string | null
  download_url: string | null
  data_yaml: Record<string, unknown> | null
  manifest: Record<string, unknown> | null
}

export type BackendDatasetReleaseCreate = {
  name: string
  project_id?: string | null
  task_external_ids?: string[]
  job_external_ids?: string[]
  export_format?: string | null
  include_images?: boolean
  splits?: Record<string, unknown>
  snapshot?: Record<string, unknown>
}

export type BackendTrainingRun = {
  id: string
  dataset_release_id: string
  model_family: string
  base_model: string
  status: BackendJobStatus
  progress: number
  mlflow_run_id: string | null
  config: Record<string, unknown>
  metrics: Record<string, unknown>
  artifacts: unknown[]
  created_at: string
  updated_at: string
}

export type BackendTrainingRunCreate = {
  dataset_release_id: string
  base_model: string
  model_family?: string
  epochs?: number
  image_size?: number
  batch_size?: number
  device?: string | null
  workers?: number
  patience?: number | null
  seed?: number
  config?: Record<string, unknown>
}

export type BackendModelVersion = {
  id: string
  name: string
  version: string
  family: string
  base_model: string
  training_run_id: string | null
  dataset_release_id: string | null
  mlflow_run_id: string | null
  artifact_uri: string | null
  metrics: Record<string, unknown>
  params: Record<string, unknown>
  status: string
  created_at: string
  updated_at: string
}

export type BackendModelVersionCreate = {
  name: string
  version: string
  family?: string
  base_model?: string
  dataset_release_id?: string | null
  artifact_uri?: string | null
  metrics?: Record<string, unknown>
  params?: Record<string, unknown>
  status?: string
}

export type BackendModelVersionUpdate = Partial<BackendModelVersionCreate>

export type BackendPipelineDefinition = {
  id: string
  name: string
  version: string
  graph: Record<string, unknown>
  config: Record<string, unknown>
  status: string
  created_at: string
  updated_at: string
}

export type BackendPipelineDefinitionCreate = {
  name: string
  version?: string
  graph?: Record<string, unknown>
  config?: Record<string, unknown>
}

export type BackendPipelineRun = {
  id: string
  name: string
  status: BackendJobStatus
  progress: number
  definition: Record<string, unknown>
  lineage: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendPipelineRunCreate = {
  name: string
  definition_id?: string | null
  source_release_id?: string | null
  target_release_name?: string | null
  task_external_ids?: string[]
  sample_policy?: Record<string, unknown>
  definition?: Record<string, unknown>
  lineage?: Record<string, unknown>
}

export type BackendDerivedAsset = {
  id: string
  external_id: string
  pipeline_run_id: string
  dataset_release_id: string | null
  source_task_external_id: string | null
  source_annotation_id: string | null
  source_track_id: string | null
  frame: number | null
  label_id: number | null
  label_name: string | null
  split: string
  crop_uri: string | null
  preview_url: string | null
  bbox: Record<string, unknown>
  padding: Record<string, unknown>
  model_id: string | null
  model_version: string | null
  score: number | null
  human_corrections: Record<string, unknown>
  lineage: Record<string, unknown>
  status: string
  created_at: string
  updated_at: string
}

export type BackendAuditEvent = {
  id: string
  actor: string
  action: string
  target: string
  reason: string | null
  confidence: number | null
  payload: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BackendAuditEventPage = {
  items: BackendAuditEvent[]
  total: number
  limit: number
  offset: number
}

export type BackendImportTaskCreate = {
  project_id?: string | null
  name: string
  labels?: Record<string, unknown>[]
  source_path?: string | null
  estimated_bytes?: number | null
  sync_after_import?: boolean
}

export type BackendImportJob = {
  job: BackendJob
}
