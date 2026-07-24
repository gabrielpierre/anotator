import type {
  BackendArtifact,
  BackendAnnotationRecord,
  BackendAuditEventPage,
  BackendAuthSession,
  BackendCvatStatus,
  BackendCvatLabel,
  BackendDashboard,
  BackendDatasetRelease,
  BackendDatasetReleaseCreate,
  BackendImportJob,
  BackendImportTaskCreate,
  BackendDirectoryListing,
  BackendInferenceRunCreate,
  BackendInferenceSuggestion,
  BackendJob,
  BackendJobCapacity,
  BackendJobMetrics,
  BackendLabelColorUpdate,
  BackendLabelActionResult,
  BackendLabelImpact,
  BackendLabelMap,
  BackendLabelRename,
  BackendModelVersion,
  BackendModelVersionCreate,
  BackendModelVersionUpdate,
  BackendManualAnnotationSave,
  BackendDerivedAsset,
  BackendPipelineDefinition,
  BackendPipelineDefinitionCreate,
  BackendPipelineRun,
  BackendPipelineRunCreate,
  BackendPreparedDataset,
  BackendProject,
  BackendProjectCreate,
  BackendProjectMember,
  BackendProjectUpdate,
  BackendReviewDecision,
  BackendReviewDecisionCreate,
  BackendReviewQueueCount,
  BackendReviewQueueItem,
  BackendTask,
  BackendTaskDataMeta,
  BackendTaskDeleteImpact,
  BackendTaskDeleteResult,
  BackendTrainingRun,
  BackendTrainingRunCreate,
  BackendUser,
  BackendUserCreate,
  BackendUserUpdate,
} from "@/lib/api/types"

const DEFAULT_API_BASE = "http://localhost:8020/api/v1"
export const AUTH_TOKEN_KEY = "cvat.auth.token"

export function apiBaseUrl() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "")
}

export function apiKey() {
  return process.env.NEXT_PUBLIC_INTERNAL_API_KEY || ""
}

export function authToken() {
  if (typeof window === "undefined") return ""
  return window.sessionStorage.getItem(AUTH_TOKEN_KEY) || ""
}

export function setAuthToken(token: string | null) {
  if (typeof window === "undefined") return
  if (token) window.sessionStorage.setItem(AUTH_TOKEN_KEY, token)
  else window.sessionStorage.removeItem(AUTH_TOKEN_KEY)
}

export function apiAssetUrl(path: string | null | undefined) {
  if (!path) return null
  if (path.startsWith("s3://")) return null
  if (/^https?:\/\//.test(path)) return path
  const base = apiBaseUrl().replace(/\/api\/v1$/, "")
  return withApiKeyQuery(`${base}${path.startsWith("/") ? path : `/${path}`}`)
}

export function taskFrameAssetUrl(
  taskId: string | null | undefined,
  frame: number,
  options: { variant?: "annotation" | "original"; maxSide?: number } = {},
) {
  if (!taskId) return null
  const query = new URLSearchParams({ variant: options.variant ?? "annotation" })
  if (options.maxSide) query.set("max_side", String(options.maxSide))
  return apiAssetUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/frame/${frame}?${query.toString()}`)
}

function apiHeaders(headers: HeadersInit = {}) {
  const key = apiKey()
  const token = authToken()
  return {
    ...headers,
    ...(key ? { "X-API-Key": key } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function withApiKeyQuery(url: string) {
  const key = apiKey()
  const parsed = new URL(url)
  const token = authToken()
  if (key) parsed.searchParams.set("api_key", key)
  if (token) parsed.searchParams.set("session_token", token)
  return parsed.toString()
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "GET",
    headers: apiHeaders({ Accept: "application/json" }),
    cache: "no-store",
    signal,
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "POST",
    headers: apiHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
    cache: "no-store",
    signal,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.json() as Promise<T>
}

async function putJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "PUT",
    headers: apiHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
    cache: "no-store",
    signal,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.json() as Promise<T>
}

async function patchJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "PATCH",
    headers: apiHeaders({ Accept: "application/json", "Content-Type": "application/json" }),
    cache: "no-store",
    signal,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.json() as Promise<T>
}

async function deleteJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "DELETE",
    headers: apiHeaders({ Accept: "application/json" }),
    cache: "no-store",
    signal,
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.json() as Promise<T>
}

async function getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "GET",
    headers: apiHeaders(),
    cache: "no-store",
    signal,
  })
  if (!response.ok) {
    throw await backendError(response)
  }
  return response.blob()
}

async function backendError(response: Response) {
  const fallback = `Backend request failed: ${response.status} ${response.statusText}`
  try {
    const payload = await response.json()
    const detail = payload?.detail
    if (typeof detail === "string" && detail.trim()) {
      return new Error(detail)
    }
    if (detail && typeof detail === "object") {
      const message = detail.message
      if (typeof message === "string" && message.trim()) {
        return new Error(message)
      }
      return new Error(JSON.stringify(detail))
    }
  } catch {
    return new Error(fallback)
  }
  return new Error(fallback)
}

export function fetchCvatStatus(signal?: AbortSignal) {
  return getJson<BackendCvatStatus>("/cvat/status", signal)
}

export async function loginBackend(email: string, password: string, signal?: AbortSignal) {
  const session = await postJson<BackendAuthSession>("/auth/login", { email, password }, signal)
  setAuthToken(session.token)
  return session
}

export function fetchCurrentUser(signal?: AbortSignal) {
  return getJson<BackendUser>("/auth/me", signal)
}

export async function logoutBackend(signal?: AbortSignal) {
  try {
    await postJson<{ ok: boolean }>("/auth/logout", {}, signal)
  } finally {
    setAuthToken(null)
  }
}

export function fetchUsers(signal?: AbortSignal) {
  return getJson<BackendUser[]>("/users", signal)
}

export function createUser(payload: BackendUserCreate, signal?: AbortSignal) {
  return postJson<BackendUser>("/users", payload, signal)
}

export function updateUser(userId: string, payload: BackendUserUpdate, signal?: AbortSignal) {
  return patchJson<BackendUser>(`/users/${encodeURIComponent(userId)}`, payload, signal)
}

export function deactivateUser(userId: string, signal?: AbortSignal) {
  return deleteJson<BackendUser>(`/users/${encodeURIComponent(userId)}`, signal)
}

export function fetchProjects(signal?: AbortSignal) {
  return getJson<BackendProject[]>("/projects", signal)
}

export function createProject(payload: BackendProjectCreate, signal?: AbortSignal) {
  return postJson<BackendProject>("/projects", payload, signal)
}

export function updateProject(projectId: string, payload: BackendProjectUpdate, signal?: AbortSignal) {
  return patchJson<BackendProject>(`/projects/${encodeURIComponent(projectId)}`, payload, signal)
}

export function deleteProject(projectId: string, signal?: AbortSignal) {
  return deleteJson<BackendProject>(`/projects/${encodeURIComponent(projectId)}`, signal)
}

export function fetchProjectMembers(projectId: string, signal?: AbortSignal) {
  return getJson<BackendProjectMember[]>(`/projects/${encodeURIComponent(projectId)}/members`, signal)
}

export function putProjectMembers(projectId: string, userIds: string[], signal?: AbortSignal) {
  return putJson<BackendProjectMember[]>(`/projects/${encodeURIComponent(projectId)}/members`, { user_ids: userIds }, signal)
}

export function fetchDirectories(path?: string, signal?: AbortSignal) {
  const query = path ? `?${new URLSearchParams({ path }).toString()}` : ""
  return getJson<BackendDirectoryListing>(`/system/directories${query}`, signal)
}

export function fetchDashboard(projectId = "default", signal?: AbortSignal) {
  return getJson<BackendDashboard>(`/projects/${encodeURIComponent(projectId)}/dashboard`, signal)
}

export function fetchTasks(
  paramsOrSignal?: { projectExternalId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendTask[]>(`/tasks${suffix}`, signal)
}

export function fetchTaskDataMeta(taskId: string, signal?: AbortSignal) {
  return getJson<BackendTaskDataMeta>(`/tasks/${encodeURIComponent(taskId)}/data-meta`, signal)
}

export function fetchTaskDeleteImpact(taskId: string, signal?: AbortSignal) {
  return getJson<BackendTaskDeleteImpact>(`/tasks/${encodeURIComponent(taskId)}/delete-impact`, signal)
}

export function assignTaskAssignee(taskId: string, userId: string | null, signal?: AbortSignal) {
  return patchJson<BackendTask>(`/tasks/${encodeURIComponent(taskId)}/assignee`, { user_id: userId }, signal)
}

export function deleteTask(taskId: string, options: { deleteCvat?: boolean } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ delete_cvat: String(options.deleteCvat ?? true) })
  return deleteJson<BackendTaskDeleteResult>(`/tasks/${encodeURIComponent(taskId)}?${query.toString()}`, signal)
}

export function fetchLabels(
  paramsOrSignal?: { projectExternalId?: string | null; taskExternalId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendCvatLabel[]>(`/labels${suffix}`, signal)
}

export function updateLabelColor(payload: BackendLabelColorUpdate, signal?: AbortSignal) {
  return patchJson<BackendCvatLabel[]>("/labels/color", payload, signal)
}

export function fetchLabelImpact(
  params: { name: string; projectExternalId?: string | null; taskExternalId?: string | null },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ name: params.name })
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
  return getJson<BackendLabelImpact>(`/labels/impact?${query.toString()}`, signal)
}

export function renameLabel(payload: BackendLabelRename, signal?: AbortSignal) {
  return patchJson<BackendLabelActionResult>("/labels/rename", payload, signal)
}

export function mapLabel(payload: BackendLabelMap, signal?: AbortSignal) {
  return postJson<BackendLabelActionResult>("/labels/map", payload, signal)
}

export function deleteLabel(
  params: { name: string; projectExternalId?: string | null; taskExternalId?: string | null },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return deleteJson<BackendLabelActionResult>(`/labels/${encodeURIComponent(params.name)}${suffix}`, signal)
}

export function fetchJobs(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendJob[]>(`/jobs${suffix}`, signal)
}

export function fetchJobCapacity(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendJobCapacity>(`/jobs/capacity${suffix}`, signal)
}

export function updateJobPriority(jobId: string, priority: number, signal?: AbortSignal) {
  return patchJson<BackendJob>(`/jobs/${encodeURIComponent(jobId)}/priority`, { priority }, signal)
}

export function retryJob(jobId: string, signal?: AbortSignal) {
  return postJson<BackendJob>(`/jobs/${encodeURIComponent(jobId)}/retry`, {}, signal)
}

export function fetchJobMetrics(jobId: string, signal?: AbortSignal) {
  return getJson<BackendJobMetrics>(`/jobs/${encodeURIComponent(jobId)}/metrics`, signal)
}

export function cancelJob(jobId: string, signal?: AbortSignal) {
  return postJson<BackendJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {}, signal)
}

export function jobsEventsUrl(params: { projectId?: string | null } = {}) {
  const url = new URL(`${apiBaseUrl()}/jobs/events`)
  if (params.projectId) url.searchParams.set("project_id", params.projectId)
  return withApiKeyQuery(url.toString())
}

export function queueCvatSync(signal?: AbortSignal) {
  return postJson<BackendJob>("/cvat/sync/jobs", {}, signal)
}

export function createInferenceRun(payload: BackendInferenceRunCreate, signal?: AbortSignal) {
  return postJson<BackendJob>("/inference-runs", payload, signal)
}

export function fetchInferenceSuggestions(
  params: { taskExternalId?: string; projectExternalId?: string | null; frame?: number; modelId?: string; status?: string } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.frame !== undefined) query.set("frame", String(params.frame))
  if (params.modelId) query.set("model_id", params.modelId)
  if (params.status) query.set("status", params.status)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendInferenceSuggestion[]>(`/inference-runs/suggestions${suffix}`, signal)
}

export function deleteInferenceSuggestions(
  params: { taskExternalId: string; frame?: number; modelId?: string },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ task_external_id: params.taskExternalId })
  if (params.frame !== undefined) query.set("frame", String(params.frame))
  if (params.modelId) query.set("model_id", params.modelId)
  return deleteJson<{ deleted: number }>(`/inference-runs/suggestions?${query.toString()}`, signal)
}

export function updateInferenceSuggestionStatus(
  suggestionId: string,
  status: "accepted" | "rejected" | "proposed",
  signal?: AbortSignal,
) {
  return patchJson<BackendInferenceSuggestion>(
    `/inference-runs/suggestions/${encodeURIComponent(suggestionId)}/status`,
    { status },
    signal,
  )
}

export function fetchReviewQueue(
  paramsOrSignal?: { projectExternalId?: string | null; state?: "pending" | "approved" } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.state) query.set("state", params.state)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendReviewQueueItem[]>(`/review/queue${suffix}`, signal)
}

export function fetchReviewQueueCount(
  paramsOrSignal?: { projectExternalId?: string | null; state?: "pending" | "approved" } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.state) query.set("state", params.state)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendReviewQueueCount>(`/review/queue/count${suffix}`, signal)
}

export function fetchReviewAnnotations(
  params: { taskExternalId?: string; projectExternalId?: string | null; frame?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
  if (params.projectExternalId) query.set("project_external_id", params.projectExternalId)
  if (params.frame !== undefined) query.set("frame", String(params.frame))
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendAnnotationRecord[]>(`/review/annotations${suffix}`, signal)
}

export function saveManualAnnotations(payload: BackendManualAnnotationSave, signal?: AbortSignal) {
  return putJson<BackendAnnotationRecord[]>("/review/annotations/manual", payload, signal)
}

export function createReviewDecision(payload: BackendReviewDecisionCreate, signal?: AbortSignal) {
  return postJson<BackendReviewDecision>("/review/decisions", payload, signal)
}

export function fetchDatasetReleases(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendDatasetRelease[]>(`/dataset-releases${suffix}`, signal)
}

export function fetchDatasetRelease(releaseId: string, signal?: AbortSignal) {
  return getJson<BackendDatasetRelease>(`/dataset-releases/${encodeURIComponent(releaseId)}`, signal)
}

export function createDatasetRelease(payload: BackendDatasetReleaseCreate, signal?: AbortSignal) {
  return postJson<BackendDatasetRelease>("/dataset-releases", payload, signal)
}

export function deleteDatasetRelease(releaseId: string, signal?: AbortSignal) {
  return deleteJson<{
    id: string
    deleted: boolean
    canceled_jobs: string[]
    deleted_objects: number
    deleted_artifact_records: number
    artifact_errors: string[]
  }>(
    `/dataset-releases/${encodeURIComponent(releaseId)}`,
    signal,
  )
}

export function fetchDatasetReleaseArtifacts(releaseId: string, signal?: AbortSignal) {
  return getJson<BackendArtifact[]>(`/dataset-releases/${encodeURIComponent(releaseId)}/artifacts`, signal)
}

export function prepareDatasetReleaseYolo(releaseId: string, signal?: AbortSignal) {
  return postJson<BackendPreparedDataset>(`/dataset-releases/${encodeURIComponent(releaseId)}/prepare-yolo`, {}, signal)
}

export function fetchPreparedDataset(releaseId: string, signal?: AbortSignal) {
  return getJson<BackendPreparedDataset>(`/dataset-releases/${encodeURIComponent(releaseId)}/prepared-dataset`, signal)
}

export function datasetReleaseDownloadPath(releaseId: string) {
  return `/dataset-releases/${encodeURIComponent(releaseId)}/download`
}

export function fetchTrainingRuns(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendTrainingRun[]>(`/training-runs${suffix}`, signal)
}

export function fetchTrainingRun(runId: string, signal?: AbortSignal) {
  return getJson<BackendTrainingRun>(`/training-runs/${encodeURIComponent(runId)}`, signal)
}

export function createTrainingRun(payload: BackendTrainingRunCreate, signal?: AbortSignal) {
  return postJson<BackendTrainingRun>("/training-runs", payload, signal)
}

export function pauseTrainingRun(runId: string, signal?: AbortSignal) {
  return postJson<BackendTrainingRun>(`/training-runs/${encodeURIComponent(runId)}/pause`, {}, signal)
}

export function stopTrainingRun(runId: string, signal?: AbortSignal) {
  return postJson<BackendTrainingRun>(`/training-runs/${encodeURIComponent(runId)}/stop`, {}, signal)
}

export function retryTrainingRun(runId: string, signal?: AbortSignal) {
  return postJson<BackendTrainingRun>(`/training-runs/${encodeURIComponent(runId)}/retry`, {}, signal)
}

export function deleteTrainingRun(runId: string, signal?: AbortSignal) {
  return deleteJson<{
    id: string
    deleted: boolean
    canceled_jobs: string[]
    deleted_models: number
    deleted_artifact_records: number
    deleted_objects: number
    artifact_errors: string[]
  }>(
    `/training-runs/${encodeURIComponent(runId)}`,
    signal,
  )
}

export function trainingRunEventsUrl(runId: string) {
  return withApiKeyQuery(`${apiBaseUrl()}/training-runs/${encodeURIComponent(runId)}/events`)
}

export function fetchModelVersions(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendModelVersion[]>(`/models${suffix}`, signal)
}

export function createModelVersion(payload: BackendModelVersionCreate, signal?: AbortSignal) {
  return postJson<BackendModelVersion>("/models", payload, signal)
}

export function updateModelVersion(modelId: string, payload: BackendModelVersionUpdate, signal?: AbortSignal) {
  return patchJson<BackendModelVersion>(`/models/${encodeURIComponent(modelId)}`, payload, signal)
}

export function promoteModelVersion(modelId: string, signal?: AbortSignal) {
  return postJson<BackendModelVersion>(`/models/${encodeURIComponent(modelId)}/promote`, {}, signal)
}

export function archiveModelVersion(modelId: string, signal?: AbortSignal) {
  return postJson<BackendModelVersion>(`/models/${encodeURIComponent(modelId)}/archive`, {}, signal)
}

export function deleteModelVersion(modelId: string, signal?: AbortSignal) {
  return deleteJson<{
    model_id: string
    name: string
    version: string
    artifact_objects: number
    artifact_records: number
    inference_suggestions: number
    warnings: string[]
  }>(`/models/${encodeURIComponent(modelId)}`, signal)
}

export function modelDownloadPath(modelId: string) {
  return `/models/${encodeURIComponent(modelId)}/download`
}

export function fetchPipelineRuns(
  paramsOrSignal?: { projectId?: string | null } | AbortSignal,
  maybeSignal?: AbortSignal,
) {
  const params = isAbortSignal(paramsOrSignal) ? {} : (paramsOrSignal ?? {})
  const signal = isAbortSignal(paramsOrSignal) ? paramsOrSignal : maybeSignal
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendPipelineRun[]>(`/pipeline-runs${suffix}`, signal)
}

export function createPipelineRun(payload: BackendPipelineRunCreate, signal?: AbortSignal) {
  return postJson<BackendPipelineRun>("/pipeline-runs", payload, signal)
}

export function fetchPipelineDefinitions(signal?: AbortSignal) {
  return getJson<BackendPipelineDefinition[]>("/pipeline-definitions", signal)
}

export function createPipelineDefinition(payload: BackendPipelineDefinitionCreate, signal?: AbortSignal) {
  return postJson<BackendPipelineDefinition>("/pipeline-definitions", payload, signal)
}

export function fetchDerivedAssets(
  params: { projectId?: string | null; pipelineRunId?: string; datasetReleaseId?: string; split?: string; limit?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.projectId) query.set("project_id", params.projectId)
  if (params.pipelineRunId) query.set("pipeline_run_id", params.pipelineRunId)
  if (params.datasetReleaseId) query.set("dataset_release_id", params.datasetReleaseId)
  if (params.split) query.set("split", params.split)
  if (params.limit) query.set("limit", String(params.limit))
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendDerivedAsset[]>(`/derived-assets${suffix}`, signal)
}

export function derivedAssetDownloadPath(assetId: string) {
  return `/derived-assets/${encodeURIComponent(assetId)}/download`
}

export function artifactDownloadPathFromUri(uri: string) {
  const encoded = btoa(unescape(encodeURIComponent(uri)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `/artifacts/${encodeURIComponent(encoded)}/download`
}

export function artifactAssetUrlFromUri(uri: string) {
  const url = new URL(`${apiBaseUrl()}${artifactDownloadPathFromUri(uri)}`)
  url.searchParams.set("inline", "true")
  return withApiKeyQuery(url.toString())
}

export function trainingArtifactDownloadPath(runId: string, artifactPath: string) {
  const encodedPath = artifactPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `/training-runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}/download`
}

export function trainingArtifactAssetUrl(runId: string, artifactPath: string) {
  const url = new URL(`${apiBaseUrl()}${trainingArtifactDownloadPath(runId, artifactPath)}`)
  url.searchParams.set("inline", "true")
  return withApiKeyQuery(url.toString())
}

export function fetchTrainingArtifactBlob(runId: string, artifactPath: string, signal?: AbortSignal) {
  const path = `${trainingArtifactDownloadPath(runId, artifactPath)}?inline=true`
  return getBlob(path, signal)
}

export function createImportTask(payload: BackendImportTaskCreate, signal?: AbortSignal) {
  return postJson<BackendImportJob>("/imports/tasks", payload, signal)
}

export async function uploadImportTaskFiles(jobId: string, files: File[], signal?: AbortSignal) {
  const form = new FormData()
  files.forEach((file) => form.append("files", file))
  const response = await fetch(`${apiBaseUrl()}/imports/tasks/${encodeURIComponent(jobId)}/files`, {
    method: "POST",
    headers: apiHeaders({ Accept: "application/json" }),
    cache: "no-store",
    signal,
    body: form,
  })
  if (!response.ok) {
    throw new Error(`Backend upload failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<BackendImportJob>
}

export function uploadImportTaskFilesWithProgress(
  jobId: string,
  files: File[],
  onProgress: (progress: { loaded: number; total: number; percent: number }) => void,
) {
  return new Promise<BackendImportJob>((resolve, reject) => {
    const filesTotal = files.reduce((total, file) => total + file.size, 0)
    const form = new FormData()
    files.forEach((file) => form.append("files", file, uploadFilename(file)))

    const request = new XMLHttpRequest()
    request.open("POST", `${apiBaseUrl()}/imports/tasks/${encodeURIComponent(jobId)}/files`)
    request.timeout = 20 * 60 * 1000
    const key = apiKey()
    const token = authToken()
    request.setRequestHeader("Accept", "application/json")
    if (key) request.setRequestHeader("X-API-Key", key)
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`)

    onProgress({ loaded: 0, total: filesTotal, percent: 0 })
    request.upload.onloadstart = () => {
      onProgress({ loaded: 0, total: filesTotal, percent: filesTotal > 0 ? 1 : 0 })
    }
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        const percent = filesTotal > 0 ? Math.min(95, Math.round((event.loaded / filesTotal) * 100)) : 0
        onProgress({
          loaded: event.loaded,
          total: filesTotal,
          percent,
        })
        return
      }
      onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
      })
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress({ loaded: filesTotal, total: filesTotal, percent: 100 })
        resolve(JSON.parse(request.responseText) as BackendImportJob)
      } else {
        reject(new Error(uploadErrorMessage(request)))
      }
    }
    request.onerror = () =>
      reject(
        new Error(
          "Conexao com o backend caiu durante o upload. Verifique se o backend continua rodando e se o storage local esta ativo.",
        ),
      )
    request.onabort = () => reject(new Error("Upload cancelado."))
    request.ontimeout = () => reject(new Error("Upload enviado, mas o backend demorou demais para finalizar o processamento."))
    request.send(form)
  })
}

function uploadFilename(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return relativePath && relativePath.trim() ? relativePath : file.name
}

function uploadErrorMessage(request: XMLHttpRequest) {
  const fallback = `Backend upload failed: ${request.status} ${request.statusText}`
  if (!request.responseText) return fallback
  try {
    const parsed = JSON.parse(request.responseText) as { detail?: unknown }
    return typeof parsed.detail === "string" ? parsed.detail : fallback
  } catch {
    return request.responseText || fallback
  }
}

export function fetchImportJob(jobId: string, signal?: AbortSignal) {
  return getJson<BackendImportJob>(`/imports/${encodeURIComponent(jobId)}`, signal)
}

export function fetchAuditEvents(
  params: { actor?: string; action?: string; target?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.actor) query.set("actor", params.actor)
  if (params.action) query.set("action", params.action)
  if (params.target) query.set("target", params.target)
  if (params.limit) query.set("limit", String(params.limit))
  if (params.offset) query.set("offset", String(params.offset))
  const suffix = query.toString() ? `?${query.toString()}` : ""
  return getJson<BackendAuditEventPage>(`/audit/events${suffix}`, signal)
}

export async function downloadBackendFile(path: string, fallbackName = "download") {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "GET",
    headers: apiHeaders(),
    cache: "no-store",
  })
  if (!response.ok) {
    throw new Error(`Backend download failed: ${response.status} ${response.statusText}`)
  }
  const blob = await response.blob()
  const disposition = response.headers.get("content-disposition") || ""
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match?.[1] || fallbackName
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
