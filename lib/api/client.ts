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
  BackendReviewQueueItem,
  BackendTask,
  BackendTaskDataMeta,
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

export function taskFrameAssetUrl(taskId: string | null | undefined, frame: number) {
  if (!taskId) return null
  return apiAssetUrl(`/api/v1/tasks/${encodeURIComponent(taskId)}/frame/${frame}`)
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

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "GET",
    headers: apiHeaders({ Accept: "application/json" }),
    cache: "no-store",
    signal,
  })
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`)
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
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`)
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
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`)
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
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`)
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
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
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

export function fetchTasks(signal?: AbortSignal) {
  return getJson<BackendTask[]>("/tasks", signal)
}

export function fetchTaskDataMeta(taskId: string, signal?: AbortSignal) {
  return getJson<BackendTaskDataMeta>(`/tasks/${encodeURIComponent(taskId)}/data-meta`, signal)
}

export function fetchLabels(signal?: AbortSignal) {
  return getJson<BackendCvatLabel[]>("/labels", signal)
}

export function fetchJobs(signal?: AbortSignal) {
  return getJson<BackendJob[]>("/jobs", signal)
}

export function fetchJobCapacity(signal?: AbortSignal) {
  return getJson<BackendJobCapacity>("/jobs/capacity", signal)
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

export function jobsEventsUrl() {
  return withApiKeyQuery(`${apiBaseUrl()}/jobs/events`)
}

export function queueCvatSync(signal?: AbortSignal) {
  return postJson<BackendJob>("/cvat/sync/jobs", {}, signal)
}

export function createInferenceRun(payload: BackendInferenceRunCreate, signal?: AbortSignal) {
  return postJson<BackendJob>("/inference-runs", payload, signal)
}

export function fetchInferenceSuggestions(
  params: { taskExternalId?: string; frame?: number; modelId?: string; status?: string } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
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

export function fetchReviewQueue(signal?: AbortSignal) {
  return getJson<BackendReviewQueueItem[]>("/review/queue", signal)
}

export function fetchReviewAnnotations(
  params: { taskExternalId?: string; frame?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
  if (params.taskExternalId) query.set("task_external_id", params.taskExternalId)
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

export function fetchDatasetReleases(signal?: AbortSignal) {
  return getJson<BackendDatasetRelease[]>("/dataset-releases", signal)
}

export function createDatasetRelease(payload: BackendDatasetReleaseCreate, signal?: AbortSignal) {
  return postJson<BackendDatasetRelease>("/dataset-releases", payload, signal)
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

export function fetchTrainingRuns(signal?: AbortSignal) {
  return getJson<BackendTrainingRun[]>("/training-runs", signal)
}

export function fetchTrainingRun(runId: string, signal?: AbortSignal) {
  return getJson<BackendTrainingRun>(`/training-runs/${encodeURIComponent(runId)}`, signal)
}

export function createTrainingRun(payload: BackendTrainingRunCreate, signal?: AbortSignal) {
  return postJson<BackendTrainingRun>("/training-runs", payload, signal)
}

export function trainingRunEventsUrl(runId: string) {
  return withApiKeyQuery(`${apiBaseUrl()}/training-runs/${encodeURIComponent(runId)}/events`)
}

export function fetchModelVersions(signal?: AbortSignal) {
  return getJson<BackendModelVersion[]>("/models", signal)
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

export function modelDownloadPath(modelId: string) {
  return `/models/${encodeURIComponent(modelId)}/download`
}

export function fetchPipelineRuns(signal?: AbortSignal) {
  return getJson<BackendPipelineRun[]>("/pipeline-runs", signal)
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
  params: { pipelineRunId?: string; datasetReleaseId?: string; split?: string; limit?: number } = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()
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
