"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Download,
  Filter,
  FolderKanban,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
  Database,
} from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge, ProgressBar } from "@/components/app/primitives"
import { DerivedDatasetDialog } from "@/components/data/derived-dataset-dialog"
import { ImportBatchDialog } from "@/components/data/import-batch-dialog"
import { ImportDatasetDialog } from "@/components/data/import-dataset-dialog"
import {
  apiAssetUrl,
  assignTaskAssignee,
  deleteTask,
  derivedAssetDownloadPath,
  downloadBackendFile,
  fetchDashboard,
  fetchDerivedAssets,
  fetchImportJob,
  fetchPipelineRuns,
  fetchTaskDeleteImpact,
  fetchTasks,
  fetchUsers,
} from "@/lib/api/client"
import { formatDateTimePt, formatPtNumber, labelsFromTasks, toUiJobStatus } from "@/lib/api/status"
import { useCurrentUser, type ProjectRecord } from "@/lib/auth/user-context"
import type {
  BackendDashboard,
  BackendDerivedAsset,
  BackendImportJob,
  BackendPipelineRun,
  BackendTask,
  BackendTaskDeleteImpact,
  BackendUser,
} from "@/lib/api/types"

const batchStatusTone: Record<string, string> = {
  Anotando: "text-brand-blue",
  "Pré-processando": "text-warning",
  Pipeline: "text-brand-indigo",
  Concluído: "text-brand-green",
  Revisão: "text-brand-indigo",
  QA: "text-warning",
}

export function DataView() {
  const router = useRouter()
  const [tasks, setTasks] = React.useState<BackendTask[] | null>(null)
  const [dashboard, setDashboard] = React.useState<BackendDashboard | null>(null)
  const [derivedAssets, setDerivedAssets] = React.useState<BackendDerivedAsset[] | null>(null)
  const [pipelineRuns, setPipelineRuns] = React.useState<BackendPipelineRun[] | null>(null)
  const [pipelineError, setPipelineError] = React.useState<string | null>(null)
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [datasetImportDialogOpen, setDatasetImportDialogOpen] = React.useState(false)
  const [derivedDialogOpen, setDerivedDialogOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<BackendTask | null>(null)
  const [deleteImpact, setDeleteImpact] = React.useState<BackendTaskDeleteImpact | null>(null)
  const [deleteLoading, setDeleteLoading] = React.useState(false)
  const [deleteSubmitting, setDeleteSubmitting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [users, setUsers] = React.useState<BackendUser[] | null>(null)
  const [assigningTaskId, setAssigningTaskId] = React.useState<string | null>(null)
  const [assignmentError, setAssignmentError] = React.useState<string | null>(null)
  const { projects, activeProject, isAdmin } = useCurrentUser()
  const currentProjectRecord = activeProject ?? projects[0] ?? null
  const currentProjectId = currentProjectRecord?.id ?? null
  const currentProjectExternalId = currentProjectRecord?.externalId ?? null
  const importRefreshTimers = React.useRef<Array<ReturnType<typeof setTimeout>>>([])

  const clearImportRefreshTimers = React.useCallback(() => {
    for (const timer of importRefreshTimers.current) clearTimeout(timer)
    importRefreshTimers.current = []
  }, [])

  const loadData = React.useCallback((signal?: AbortSignal) => {
    if (!currentProjectRecord) {
      setTasks([])
      setDashboard(null)
      setDerivedAssets([])
      setPipelineRuns([])
      setUsers(null)
      return
    }
    fetchTasks({ projectExternalId: currentProjectExternalId }, signal).then(setTasks).catch(() => setTasks(null))
    fetchDashboard(currentProjectId, signal).then(setDashboard).catch(() => setDashboard(null))
    fetchDerivedAssets({ projectId: currentProjectId, limit: 8 }, signal).then(setDerivedAssets).catch(() => setDerivedAssets(null))
    fetchPipelineRuns({ projectId: currentProjectId }, signal).then(setPipelineRuns).catch(() => setPipelineRuns(null))
    if (isAdmin) fetchUsers(signal).then(setUsers).catch(() => setUsers(null))
    else setUsers(null)
  }, [currentProjectExternalId, currentProjectId, currentProjectRecord, isAdmin])

  const scheduleImportRefresh = React.useCallback(
    (job?: BackendImportJob) => {
      clearImportRefreshTimers()
      const jobId = job?.job.id
      let attempts = 0
      const tick = () => {
        attempts += 1
        loadData()
        if (!jobId || attempts >= 18) return
        fetchImportJob(jobId)
          .then((latest) => {
            if (["succeeded", "failed", "canceled"].includes(latest.job.status)) {
              loadData()
              return
            }
            importRefreshTimers.current.push(setTimeout(tick, attempts < 8 ? 1000 : 2500))
          })
          .catch(() => {
            if (attempts < 18) importRefreshTimers.current.push(setTimeout(tick, 2500))
          })
      }
      importRefreshTimers.current.push(setTimeout(tick, 500))
    },
    [clearImportRefreshTimers, loadData],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    loadData(controller.signal)
    return () => controller.abort()
  }, [loadData])

  React.useEffect(() => clearImportRefreshTimers, [clearImportRefreshTimers])

  const batches =
    tasks?.map((task) => {
        const progress = taskAnnotationProgress(task)
        return {
          task,
          id: task.id || task.external_id,
          externalId: task.external_id,
          name: task.name || `Task ${task.external_id}`,
          images: task.size,
          annotatedImages: progress.annotatedImages,
          annotations: progress.annotations,
          status: taskStatusLabel(task.status, progress.percent),
          progress: progress.percent,
          assignee: taskAssignee(task),
          source: task.project_external_id ? `CVAT project ${task.project_external_id}` : "CVAT",
          previewUrl: apiAssetUrl(task.preview_url),
          createdAt: formatDateTimePt(task.created_at),
        }
      }) ?? []

  const taskClasses = labelsFromTasks(tasks)
  const annotators = React.useMemo(
    () => (users ?? []).filter((user) => user.role === "anotador" && user.status === "active"),
    [users],
  )
  const classDistribution =
    dashboard?.class_distribution && dashboard.class_distribution.length > 0
      ? dashboard.class_distribution.map((item, index) => ({
          name: item.name,
          count: item.count,
          share: item.share,
          color: classColors[index % classColors.length],
        }))
      : taskClasses.length > 0
        ? taskClasses.map((item) => ({
            name: item.name,
            count: item.count ?? 1,
            share: Math.round((100 / taskClasses.length) * 100) / 100,
            color: item.color,
          }))
      : []

  const imageCount = dashboard?.stats.images ?? batches.reduce((total, batch) => total + batch.images, 0)
  const annotatedCount = batches.reduce((total, batch) => total + batch.annotatedImages, 0)
  const objectCount = batches.reduce((total, batch) => total + batch.annotations, 0)
  const latestPipeline = pipelineRuns?.[0] ?? null
  const storage = storageFromDashboard(dashboard, currentProjectRecord)

  function closeDeleteDialog() {
    if (deleteSubmitting) return
    setDeleteTarget(null)
    setDeleteImpact(null)
    setDeleteLoading(false)
    setDeleteError(null)
  }

  async function openDeleteDialog(task: BackendTask) {
    setDeleteTarget(task)
    setDeleteImpact(null)
    setDeleteError(null)
    setDeleteLoading(true)
    try {
      setDeleteImpact(await fetchTaskDeleteImpact(task.id))
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Nao foi possivel calcular o impacto da exclusao.")
    } finally {
      setDeleteLoading(false)
    }
  }

  async function confirmDeleteTask() {
    if (!deleteTarget) return
    setDeleteSubmitting(true)
    setDeleteError(null)
    try {
      await deleteTask(deleteTarget.id, { deleteCvat: true })
      closeDeleteDialog()
      loadData()
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Nao foi possivel apagar o lote.")
    } finally {
      setDeleteSubmitting(false)
    }
  }

  async function assignAnnotator(task: BackendTask, userId: string | null) {
    setAssigningTaskId(task.id)
    setAssignmentError(null)
    try {
      const updatedTask = await assignTaskAssignee(task.id, userId)
      setTasks((current) => current?.map((item) => (item.id === updatedTask.id ? updatedTask : item)) ?? [updatedTask])
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : "Nao foi possivel atribuir o anotador.")
    } finally {
      setAssigningTaskId(null)
    }
  }

  function openTaskForAnnotation(task: BackendTask) {
    const taskId = task.external_id || task.id
    router.push(`/anotar?task=${encodeURIComponent(taskId)}`)
  }

  if (!currentProjectRecord) {
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <PageHeader
          title="Dados"
          subtitle="Selecione ou crie um projeto para importar lotes e datasets."
          actions={
            <Button onClick={() => router.push("/projetos")}>
              <FolderKanban className="size-4" />
              Ir para projetos
            </Button>
          }
        />
        <Card>
          <CardContent className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
              <FolderKanban className="size-6" />
            </span>
            <div className="flex max-w-md flex-col gap-1">
              <p className="text-base font-medium text-foreground">Nenhum projeto ativo</p>
              <p className="text-sm text-muted-foreground">
                Os lotes, classes e anotações são isolados por projeto. Crie ou selecione um projeto antes de trabalhar nos dados.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Dados"
        subtitle="Lotes de imagens, importação e distribuição do dataset."
        actions={
          <>
            <Button variant="outline">
              <Search className="size-4" />
              Buscar imagens
            </Button>
            <Button variant="outline" onClick={() => setDerivedDialogOpen(true)}>
              <Scissors className="size-4" />
              Dataset derivado
            </Button>
            <Button variant="outline" onClick={() => setDatasetImportDialogOpen(true)}>
              <Database className="size-4" />
              Importar dataset
            </Button>
            <Button onClick={() => setImportDialogOpen(true)}>
              <Upload className="size-4" />
              Importar lote
            </Button>
          </>
        }
      />
      <ImportBatchDialog
        open={importDialogOpen}
        projectId={currentProjectId}
        onClose={() => setImportDialogOpen(false)}
        onImported={(job) => {
          setImportDialogOpen(false)
          scheduleImportRefresh(job)
        }}
      />
      <ImportDatasetDialog
        open={datasetImportDialogOpen}
        initialProjectId={currentProjectId}
        lockProject
        onClose={() => setDatasetImportDialogOpen(false)}
        onImported={(job) => {
          setDatasetImportDialogOpen(false)
          scheduleImportRefresh(job)
        }}
      />
      <DerivedDatasetDialog
        open={derivedDialogOpen}
        tasks={tasks ?? []}
        objectCount={objectCount}
        classCount={classDistribution.length}
        projectId={currentProjectId}
        onClose={() => setDerivedDialogOpen(false)}
        onCreated={(run) => {
          setPipelineError(null)
          setPipelineRuns((current) => [run, ...(current ?? [])])
        }}
      />
      <DeleteBatchDialog
        task={deleteTarget}
        impact={deleteImpact}
        loading={deleteLoading}
        submitting={deleteSubmitting}
        error={deleteError}
        onClose={closeDeleteDialog}
        onConfirm={confirmDeleteTask}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Imagens importadas"
          value={formatPtNumber(imageCount)}
          hint={`${batches.length} lotes/tasks`}
          tone="blue"
        />
        <MetricCard
          label="Imagens anotadas"
          value={formatPtNumber(annotatedCount)}
          hint={imageCount > 0 ? `${Math.round((annotatedCount / imageCount) * 100)}% dos frames importados` : "Sem imagens"}
          tone="mint"
        />
        <MetricCard
          label="Objetos anotados"
          value={formatPtNumber(objectCount)}
          hint="Anotações salvas"
          tone="purple"
        />
        <MetricCard
          label="Crops derivados"
          value={formatPtNumber(derivedAssets?.length ?? 0)}
          hint={latestPipeline ? `Pipeline ${latestPipeline.status}` : "datasets de classificacao"}
          tone="subtle"
        />
      </div>
      {pipelineError && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{pipelineError}</p>}
      {assignmentError && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{assignmentError}</p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Lotes de dados</CardTitle>
            <div className="flex items-center gap-2">
              <Input placeholder="Filtrar lotes..." aria-label="Filtrar lotes" icon={<Search />} className="w-48" />
              <Button variant="ghost" size="icon" aria-label="Filtros">
                <Filter className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className={batches.length > 0 ? "overflow-x-auto p-0" : "p-0"}>
            {batches.length > 0 ? (
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-3 font-medium">Lote</th>
                    <th className="px-5 py-3 font-medium">Imagens</th>
                    <th className="px-5 py-3 font-medium">Origem</th>
                    <th className="px-5 py-3 font-medium">Anotador</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Progresso</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const previewUrl = "previewUrl" in b && typeof b.previewUrl === "string" ? b.previewUrl : null
                    return (
                      <tr
                        key={b.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Abrir lote ${b.name} para anotação`}
                        onClick={() => openTaskForAnnotation(b.task)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            openTaskForAnnotation(b.task)
                          }
                        }}
                        className="group cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 font-medium text-foreground">
                            {previewUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={previewUrl} alt="" className="size-8 rounded-lg object-cover" />
                            ) : (
                              <span className="flex size-8 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
                                <ImageIcon className="size-4" />
                              </span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{b.name}</span>
                            {isAdmin && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                title={`Apagar lote ${b.name}`}
                                aria-label={`Apagar lote ${b.name}`}
                                className="ml-auto shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void openDeleteDialog(b.task)
                                }}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 tabular-nums text-muted-foreground">
                          {b.images.toLocaleString("pt-BR")}
                        </td>
                        <td className="px-5 py-3 text-muted-foreground">{b.source}</td>
                        <td className="px-5 py-3">
                          {isAdmin ? (
                            <select
                              value={b.assignee?.user_id ?? ""}
                              disabled={assigningTaskId === b.task.id || !users}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              onChange={(event) => void assignAnnotator(b.task, event.target.value || null)}
                              className="h-8 w-44 rounded-full border border-border bg-background px-3 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                              aria-label={`Atribuir anotador ao lote ${b.name}`}
                            >
                              <option value="">Sem anotador</option>
                              {b.assignee && !annotators.some((user) => user.id === b.assignee?.user_id) && (
                                <option value={b.assignee.user_id}>{b.assignee.name}</option>
                              )}
                              {annotators.map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs text-muted-foreground">{b.assignee?.name ?? "Sem anotador"}</span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`text-xs font-medium ${batchStatusTone[b.status] ?? "text-muted-foreground"}`}>
                            {b.status}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <ProgressBar value={b.progress} className="w-24" />
                              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                                {b.progress}%
                              </span>
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {b.annotatedImages.toLocaleString("pt-BR")} / {b.images.toLocaleString("pt-BR")} imagens
                            </span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <span className="flex size-12 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                  <Upload className="size-5" />
                </span>
                <div className="flex max-w-sm flex-col gap-1">
                  <p className="text-base font-medium text-foreground">Nenhum lote importado</p>
                  <p className="text-sm text-muted-foreground">
                    Importe imagens para criar o primeiro lote deste projeto.
                  </p>
                </div>
                <Button onClick={() => setImportDialogOpen(true)}>
                  <Upload className="size-4" />
                  Importar lote
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Distribuição por classe</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
          {classDistribution.slice(0, 8).map((c) => (
                <div key={c.name} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-foreground">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                      {c.name}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{c.count.toLocaleString("pt-BR")}</span>
                  </div>
                  <ProgressBar value={c.share * 3} color="bg-brand-blue" />
                </div>
              ))}
              {classDistribution.length === 0 && (
                <p className="text-sm text-muted-foreground">Nenhuma classe sincronizada.</p>
              )}
            </CardContent>
          </Card>

          <Card tone="blue">
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <HardDrive className="size-4 text-brand-blue" />
                Armazenamento
              </div>
              <ProgressBar value={storage.percent} color="bg-brand-blue" height="h-2" />
              <p className="text-xs text-muted-foreground">{storage.label}</p>
              {isAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 w-fit"
                  onClick={() => router.push("/?personalizar=1")}
                >
                  <Database className="size-4" />
                  Gerenciar storage
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dataset derivado</CardTitle>
              {latestPipeline && <StatusBadge status={toUiJobStatus(latestPipeline.status)} />}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {latestPipeline ? (
                <div className="rounded-lg bg-surface-subtle p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">{latestPipeline.name}</p>
                  <p>Release: {String(latestPipeline.lineage.derived_release_id ?? "--").slice(0, 12)}</p>
                  <p>Assets: {String(latestPipeline.lineage.derived_asset_count ?? derivedAssets?.length ?? 0)}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum pipeline derivado executado.</p>
              )}
              <div className="divide-y divide-border">
                {(derivedAssets ?? []).slice(0, 6).map((asset) => (
                  <div key={asset.id} className="flex items-center gap-3 py-2.5">
                    {apiAssetUrl(asset.preview_url) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={apiAssetUrl(asset.preview_url) ?? undefined}
                        alt=""
                        className="size-8 shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
                        <Scissors className="size-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{asset.label_name ?? "classe"}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {asset.split} - frame {asset.frame ?? "--"} - {asset.source_track_id ? "track" : "shape"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Baixar crop"
                      disabled={!asset.crop_uri}
                      onClick={() => void downloadBackendFile(derivedAssetDownloadPath(asset.id), `${asset.id}.png`)}
                    >
                      <Download className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function DeleteBatchDialog({
  task,
  impact,
  loading,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  task: BackendTask | null
  impact: BackendTaskDeleteImpact | null
  loading: boolean
  submitting: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  React.useEffect(() => {
    if (!task) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [task, onClose])

  if (!task) return null

  const blocked = Boolean(impact?.blocking)
  const canDelete = Boolean(impact) && !loading && !submitting && !blocked
  const deletedItems = [
    { label: "Imagens no lote", value: impact?.image_count ?? task.size },
    { label: "Anotações locais", value: impact?.annotations ?? 0 },
    { label: "Sugestões", value: impact?.inference_suggestions ?? 0 },
    { label: "Labels da task", value: impact?.labels ?? 0 },
    { label: "Jobs CVAT locais", value: impact?.cvat_jobs ?? 0 },
  ]
  const preservedItems = [
    { label: "Releases", value: impact?.dataset_releases ?? 0 },
    { label: "Crops derivados", value: impact?.derived_assets ?? 0 },
    { label: "Pipelines", value: impact?.pipeline_runs ?? 0 },
  ]

  return (
    <div role="dialog" aria-modal="true" aria-label="Apagar lote" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex min-w-0 gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground">Apagar lote</h2>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{task.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            aria-label="Fechar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <p className="text-sm text-muted-foreground">
            Esta ação apaga a task no CVAT e remove os registros operacionais locais do lote. Releases,
            treinos, modelos, assets derivados e auditoria permanecem preservados como histórico.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-border p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Calculando impacto...
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-medium text-foreground">Será removido</h3>
                <dl className="mt-3 flex flex-col gap-2 text-sm">
                  {deletedItems.map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="font-medium tabular-nums text-foreground">{formatPtNumber(item.value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section className="rounded-xl border border-border p-4">
                <h3 className="text-sm font-medium text-foreground">Será preservado</h3>
                <dl className="mt-3 flex flex-col gap-2 text-sm">
                  {preservedItems.map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="font-medium tabular-nums text-foreground">{formatPtNumber(item.value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          )}

          {impact?.warnings.map((warning) => (
            <p key={warning} className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
              {warning}
            </p>
          ))}

          {impact?.active_jobs.length ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <h3 className="text-sm font-medium text-destructive">Jobs ativos bloqueando a exclusão</h3>
              <div className="mt-3 divide-y divide-border/70">
                {impact.active_jobs.map((job) => (
                  <div key={job.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{job.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{job.kind} - {job.detail ?? job.status}</p>
                    </div>
                    <span className="rounded-lg bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                      {job.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-5">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={!canDelete}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Apagar lote
          </Button>
        </div>
      </div>
    </div>
  )
}

type TaskAnnotationProgress = {
  totalImages: number
  annotatedImages: number
  annotations: number
  percent: number
}

type TaskAssignee = {
  user_id: string
  name: string
  email: string
  role?: string
}

function taskAnnotationProgress(task: BackendTask): TaskAnnotationProgress {
  const progress = recordFromUnknown(task.raw?.annotation_progress)
  const totalImages = numberFromUnknown(progress?.total_images) ?? task.size ?? 0
  const annotations = numberFromUnknown(progress?.annotations) ?? 0
  const annotatedImages =
    numberFromUnknown(progress?.annotated_images) ?? (task.status.toLowerCase() === "completed" ? task.size : 0)
  const fallbackPercent = totalImages > 0 ? Math.round((annotatedImages / totalImages) * 100) : 0
  const percent = numberFromUnknown(progress?.percent) ?? fallbackPercent

  return {
    totalImages: Math.max(0, totalImages),
    annotatedImages: Math.max(0, Math.min(totalImages, annotatedImages)),
    annotations: Math.max(0, annotations),
    percent: Math.max(0, Math.min(100, Math.round(percent))),
  }
}

function taskAssignee(task: BackendTask): TaskAssignee | null {
  const assignee = recordFromUnknown(task.raw?.local_assignee) ?? recordFromUnknown(task.raw?.assignee)
  if (!assignee) return null
  const userId = stringFromUnknown(assignee.user_id) ?? stringFromUnknown(assignee.id)
  const name = stringFromUnknown(assignee.name) ?? stringFromUnknown(assignee.username)
  const email = stringFromUnknown(assignee.email)
  if (!userId || !name) return null
  return {
    user_id: userId,
    name,
    email: email ?? "",
    role: stringFromUnknown(assignee.role) ?? undefined,
  }
}

function taskStatusLabel(status: string, progressPercent?: number) {
  if (typeof progressPercent === "number") {
    if (progressPercent >= 100) return "Concluído"
    if (progressPercent > 0) return "Anotando"
  }
  const normalized = status.toLowerCase()
  if (normalized === "completed") return "Concluído"
  if (normalized === "annotation" || normalized === "in progress") return "Anotando"
  if (normalized === "validation") return "Revisão"
  if (normalized === "acceptance") return "QA"
  return status || "CVAT"
}

const classColors = [
  "var(--brand-blue)",
  "var(--brand-green)",
  "var(--brand-lavender)",
  "var(--warning)",
  "var(--brand-indigo)",
  "var(--brand-sky)",
]

function storageFromDashboard(dashboard: BackendDashboard | null, fallbackProject: ProjectRecord | null) {
  const storage = dashboard?.project?.raw?.storage
  if (storage && typeof storage === "object") {
    const data = storage as Record<string, unknown>
    const quotaGb = numberFromUnknown(data.quota_gb)
    const usedBytes = numberFromUnknown(data.used_bytes) ?? 0
    if (quotaGb) {
      const usedGb = usedBytes / 1024 ** 3
      return {
        percent: Math.min(100, Math.round((usedGb / quotaGb) * 100)),
        label: `${formatStorageUsed(usedBytes)} de ${quotaGb} GB utilizados`,
      }
    }
  }
  if (fallbackProject && fallbackProject.quotaGb > 0) {
    return {
      percent: fallbackProject.percent,
      label: `${formatStorageUsed(fallbackProject.usedGb * 1024 ** 3)} de ${fallbackProject.quotaGb} GB utilizados`,
    }
  }
  return { percent: 0, label: "Nenhum storage de projeto configurado." }
}

function formatStorageUsed(bytes: number) {
  if (bytes <= 0) return "0.0 GB"
  const gb = bytes / 1024 ** 3
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("pt-BR")} KB`
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
