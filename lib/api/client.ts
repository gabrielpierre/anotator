import type {
  BackendCvatStatus,
  BackendCvatLabel,
  BackendDashboard,
  BackendDatasetRelease,
  BackendDatasetReleaseCreate,
  BackendInferenceRunCreate,
  BackendInferenceSuggestion,
  BackendJob,
  BackendModelVersion,
  BackendDerivedAsset,
  BackendPipelineDefinition,
  BackendPipelineDefinitionCreate,
  BackendPipelineRun,
  BackendPipelineRunCreate,
  BackendProject,
  BackendProjectCreate,
  BackendReviewDecision,
  BackendReviewDecisionCreate,
  BackendReviewQueueItem,
  BackendTask,
  BackendTaskDataMeta,
  BackendTrainingRun,
  BackendTrainingRunCreate,
} from "@/lib/api/types"

const DEFAULT_API_BASE = "http://localhost:8000/api/v1"

export function apiBaseUrl() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "")
}

export function apiKey() {
  return process.env.NEXT_PUBLIC_INTERNAL_API_KEY || ""
}

export function mockFallbackEnabled() {
  return process.env.NEXT_PUBLIC_ENABLE_MOCK_FALLBACK === "true"
}

export function apiAssetUrl(path: string | null | undefined) {
  if (!path) return null
  if (/^https?:\/\//.test(path)) return path
  const base = apiBaseUrl().replace(/\/api\/v1$/, "")
  return withApiKeyQuery(`${base}${path.startsWith("/") ? path : `/${path}`}`)
}

function apiHeaders(headers: HeadersInit = {}) {
  const key = apiKey()
  return key ? { ...headers, "X-API-Key": key } : headers
}

function withApiKeyQuery(url: string) {
  const key = apiKey()
  if (!key) return url
  const parsed = new URL(url)
  parsed.searchParams.set("api_key", key)
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

export function fetchProjects(signal?: AbortSignal) {
  return getJson<BackendProject[]>("/projects", signal)
}

export function createProject(payload: BackendProjectCreate, signal?: AbortSignal) {
  return postJson<BackendProject>("/projects", payload, signal)
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

export function createReviewDecision(payload: BackendReviewDecisionCreate, signal?: AbortSignal) {
  return postJson<BackendReviewDecision>("/review/decisions", payload, signal)
}

export function fetchDatasetReleases(signal?: AbortSignal) {
  return getJson<BackendDatasetRelease[]>("/dataset-releases", signal)
}

export function createDatasetRelease(payload: BackendDatasetReleaseCreate, signal?: AbortSignal) {
  return postJson<BackendDatasetRelease>("/dataset-releases", payload, signal)
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
