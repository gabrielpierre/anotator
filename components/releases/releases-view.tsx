"use client"

import * as React from "react"
import { Check, ChevronRight, Database, Download, GitBranch, Images, ListChecks, Package, Search, Trash2, X } from "lucide-react"

import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { Button } from "@/components/ui/button"
import {
  createDatasetRelease,
  datasetReleaseDownloadPath,
  deleteDatasetRelease,
  downloadBackendFile,
  fetchDatasetReleases,
  fetchTasks,
} from "@/lib/api/client"
import { formatDateTimePt, formatPtNumber } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendDatasetRelease, BackendTask } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type ReleaseImageScope = "all" | "annotated"

export function ReleasesView() {
  const [backendReleases, setBackendReleases] = React.useState<BackendDatasetRelease[] | null>(null)
  const [tasks, setTasks] = React.useState<BackendTask[]>([])
  const [selectedReleaseId, setSelectedReleaseId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [deletingReleaseId, setDeletingReleaseId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const { activeProject, projects } = useCurrentUser()
  const currentProject = activeProject ?? projects[0] ?? null

  const reload = React.useCallback((signal?: AbortSignal) => {
    fetchDatasetReleases({ projectId: currentProject?.id ?? null }, signal).then(setBackendReleases).catch(() => setBackendReleases(null))
    fetchTasks({ projectExternalId: currentProject?.externalId ?? null }, signal).then(setTasks).catch(() => setTasks([]))
  }, [currentProject?.externalId, currentProject?.id])

  React.useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => controller.abort()
  }, [reload])

  const realReleases = backendReleases ?? []
  const selectedRelease = realReleases.find((release) => release.id === selectedReleaseId) ?? realReleases[0]
  const selectedSnapshot = selectedRelease?.snapshot ?? {}
  const selectedCounts = snapshotCounts(selectedSnapshot)
  const selectedArtifacts = snapshotArtifacts(selectedSnapshot)
  const buildingCount = realReleases.filter((release) => release.status === "building").length

  React.useEffect(() => {
    if (!realReleases.length) {
      setSelectedReleaseId(null)
      return
    }
    setSelectedReleaseId((current) => (realReleases.some((release) => release.id === current) ? current : realReleases[0].id))
  }, [realReleases])

  React.useEffect(() => {
    if (!buildingCount) return
    const interval = window.setInterval(() => reload(), 3000)
    return () => window.clearInterval(interval)
  }, [buildingCount, reload])

  const handleCreateRelease = async (payload: { name: string; taskExternalIds: string[]; imageScope: ReleaseImageScope }) => {
    if (!payload.taskExternalIds.length || creating) return
    setCreating(true)
    setError(null)
    try {
      const release = await createDatasetRelease({
        name: payload.name,
        project_id: currentProject?.id ?? null,
        task_external_ids: payload.taskExternalIds,
        include_images: true,
        image_scope: payload.imageScope,
        export_format: "CVAT for images 1.1",
      })
      setBackendReleases((current) => [release, ...(current ?? [])])
      setSelectedReleaseId(release.id)
      setCreateOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar release")
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteRelease = async (release: BackendDatasetRelease) => {
    if (deletingReleaseId) return
    const confirmed = window.confirm(
      `Excluir a release ${release.name}?\n\nIsso apaga os artefatos e jobs da release, mas mantém os lotes originais.`,
    )
    if (!confirmed) return
    setDeletingReleaseId(release.id)
    setError(null)
    try {
      await deleteDatasetRelease(release.id)
      setBackendReleases((current) => (current ?? []).filter((item) => item.id !== release.id))
      setSelectedReleaseId((current) => (current === release.id ? null : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao excluir release")
      reload()
    } finally {
      setDeletingReleaseId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Releases"
        subtitle="Versoes imutaveis do dataset prontas para treino e exportacao."
        actions={
          <Button onClick={() => setCreateOpen(true)} disabled={!tasks.length || creating}>
            <Package className="size-4" />
            {creating ? "Criando..." : "Novo release"}
          </Button>
        }
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <CreateReleaseModal
        open={createOpen}
        tasks={tasks}
        creating={creating}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateRelease}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Releases"
          value={formatPtNumber(realReleases.length)}
          hint={`${formatPtNumber(buildingCount)} em construcao`}
          tone="blue"
        />
        <MetricCard
          label="Release selecionado"
          value={selectedRelease?.name ?? "--"}
          hint={selectedRelease ? formatDateTimePt(selectedRelease.created_at) : "--"}
          tone="mint"
        />
        <MetricCard
          label="Objetos"
          value={formatPtNumber(selectedCounts.annotations ?? 0)}
          hint={`${formatPtNumber(selectedCounts.images ?? 0)} imagens`}
          tone="purple"
        />
        <MetricCard
          label="Artefatos"
          value={selectedRelease?.artifact_uri ? "MinIO" : "--"}
          hint={`${formatPtNumber(selectedArtifacts.length)} arquivos`}
          tone="subtle"
        />
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card className="overflow-hidden p-0">
          <CardHeader className="mb-0 border-b border-border px-6 py-5">
            <div>
              <CardTitle>Historico de releases</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatPtNumber(realReleases.length)} versoes imutaveis deste projeto
              </p>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {realReleases.length
              ? (
                <div className="overflow-x-auto">
                  <div className="min-w-[920px]">
                    <div className="grid grid-cols-[minmax(260px,1fr)_128px_104px_104px_104px_160px_132px] items-center border-b border-border bg-muted/20 px-6 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span>Release</span>
                      <span>Status</span>
                      <span className="text-right">Imagens</span>
                      <span className="text-right">Objetos</span>
                      <span className="text-right">Arquivos</span>
                      <span>Criado em</span>
                      <span className="text-right">Acoes</span>
                    </div>
                    <div className="divide-y divide-border">
                      {realReleases.map((release) => {
                        const counts = snapshotCounts(release.snapshot)
                        const selected = release.id === selectedRelease?.id
                        const deleting = deletingReleaseId === release.id
                        const artifacts = snapshotArtifacts(release.snapshot)
                        return (
                          <div
                            key={release.id}
                            role="button"
                            tabIndex={0}
                            aria-selected={selected}
                            onClick={() => setSelectedReleaseId(release.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") setSelectedReleaseId(release.id)
                            }}
                            className={cn(
                              "relative grid min-h-16 cursor-pointer grid-cols-[minmax(260px,1fr)_128px_104px_104px_104px_160px_132px] items-center px-6 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-blue/30",
                              selected ? "bg-brand-blue/[0.055]" : "hover:bg-muted/30",
                            )}
                          >
                            <span
                              className={cn(
                                "absolute bottom-3 left-0 top-3 w-1 rounded-r-full",
                                selected ? "bg-brand-blue" : "bg-transparent",
                              )}
                            />
                            <div className="flex min-w-0 items-center gap-3 py-3 pr-4">
                              <GitBranch
                                className={cn(
                                  "size-4 shrink-0",
                                  selected ? "text-brand-blue" : "text-muted-foreground",
                                )}
                              />
                              <div className="min-w-0">
                                <p className="truncate font-medium text-foreground">{release.name}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {releaseImageScopeLabel(release.snapshot)}
                                </p>
                              </div>
                            </div>
                            <div className="py-3 pr-4">
                              <StatusBadge status={releaseStatus(release.status)} />
                            </div>
                            <span className="py-3 pr-4 text-right text-sm tabular-nums text-foreground">
                              {formatPtNumber(counts.images ?? 0)}
                            </span>
                            <span className="py-3 pr-4 text-right text-sm tabular-nums text-foreground">
                              {formatPtNumber(counts.annotations ?? 0)}
                            </span>
                            <span className="py-3 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                              {formatPtNumber(artifacts.length)}
                            </span>
                            <span className="py-3 pr-4 text-sm text-muted-foreground">
                              {formatDateTimePt(release.created_at)}
                            </span>
                            <div className="flex items-center justify-end gap-1 py-3">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Excluir release ${release.name}`}
                                disabled={Boolean(deletingReleaseId)}
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleDeleteRelease(release)
                                }}
                              >
                                <Trash2 className="size-3.5" />
                                {deleting ? "..." : "Excluir"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Baixar release"
                                disabled={!release.artifact_uri}
                                className="text-muted-foreground hover:text-foreground"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void downloadBackendFile(datasetReleaseDownloadPath(release.id), `${release.name}.zip`)
                                }}
                              >
                                <Download className="size-4" />
                              </Button>
                              <ChevronRight
                                className={cn(
                                  "size-4 shrink-0",
                                  selected ? "text-brand-blue" : "text-muted-foreground",
                                )}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
              : <p className="px-6 py-8 text-sm text-muted-foreground">Nenhum release sincronizado.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function CreateReleaseModal({
  open,
  tasks,
  creating,
  onClose,
  onCreate,
}: {
  open: boolean
  tasks: BackendTask[]
  creating: boolean
  onClose: () => void
  onCreate: (payload: { name: string; taskExternalIds: string[]; imageScope: ReleaseImageScope }) => void
}) {
  const defaultName = React.useMemo(() => `release_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`, [open])
  const [name, setName] = React.useState(defaultName)
  const [query, setQuery] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [imageScope, setImageScope] = React.useState<ReleaseImageScope>("annotated")

  React.useEffect(() => {
    if (!open) return
    setName(defaultName)
    setQuery("")
    setSelectedIds(new Set(tasks.map((task) => task.external_id)))
    setImageScope("annotated")
  }, [defaultName, open, tasks])

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const filteredTasks = tasks.filter((task) => {
    const needle = `${task.name} ${task.external_id}`.toLowerCase()
    return needle.includes(query.trim().toLowerCase())
  })
  const selectedTasks = tasks.filter((task) => selectedIds.has(task.external_id))
  const selectedTotalImages = selectedTasks.reduce((sum, task) => sum + Math.max(0, task.size || 0), 0)
  const selectedAnnotatedImages = selectedTasks.reduce((sum, task) => sum + taskAnnotatedImageCount(task), 0)
  const releaseImageTotal = imageScope === "annotated" ? selectedAnnotatedImages : selectedTotalImages
  const annotatedScopeEmpty = imageScope === "annotated" && selectedIds.size > 0 && selectedAnnotatedImages === 0
  function toggleTask(taskId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  function selectVisible() {
    setSelectedIds((current) => new Set([...current, ...filteredTasks.map((task) => task.external_id)]))
  }

  function clearVisible() {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const task of filteredTasks) next.delete(task.external_id)
      return next
    })
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Criar release" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Novo release</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Selecione os lotes que entram na fotografia imutavel do dataset.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <div className="flex min-w-0 flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              Nome da release
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm font-normal outline-none focus:border-brand-blue"
              />
            </label>

            <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Escopo das imagens</h3>
                <p className="text-xs text-muted-foreground">
                  {formatPtNumber(releaseImageTotal)} imagens entram na release
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setImageScope("annotated")}
                  aria-pressed={imageScope === "annotated"}
                  className={cn(
                    "flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    imageScope === "annotated" ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/50",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-brand-blue">
                    <ListChecks className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      Somente anotadas
                      <span className="rounded-full bg-brand-blue/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-blue">
                        Recomendado
                      </span>
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {formatPtNumber(selectedAnnotatedImages)} de {formatPtNumber(selectedTotalImages)} imagens selecionadas
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setImageScope("all")}
                  aria-pressed={imageScope === "all"}
                  className={cn(
                    "flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    imageScope === "all" ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/50",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-brand-blue">
                    <Images className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">Todas as imagens</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {formatPtNumber(selectedTotalImages)} imagens, incluindo frames sem objeto
                    </span>
                  </span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Lotes disponíveis</h3>
                  <p className="text-xs text-muted-foreground">
                    {formatPtNumber(selectedIds.size)} de {formatPtNumber(tasks.length)} selecionados
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectVisible} disabled={!filteredTasks.length}>
                    Selecionar visíveis
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearVisible} disabled={!filteredTasks.length}>
                    Limpar visíveis
                  </Button>
                </div>
              </div>
              <Input
                placeholder="Buscar lote..."
                aria-label="Buscar lote"
                icon={<Search />}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                {filteredTasks.map((task) => {
                  const selected = selectedIds.has(task.external_id)
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => toggleTask(task.external_id)}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                        selected ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/50",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-md border text-[10px]",
                          selected ? "border-brand-blue bg-brand-blue text-white" : "border-border bg-background",
                        )}
                      >
                        {selected ? <Check className="size-3.5" /> : null}
                      </span>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-brand-blue">
                        <Database className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{task.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {formatPtNumber(task.size)} imagens · {formatPtNumber(taskAnnotatedImageCount(task))} anotadas · {formatPtNumber(taskAnnotationCount(task))} objetos · CVAT #{task.external_id}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {filteredTasks.length === 0 && (
                  <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    Nenhum lote encontrado.
                  </p>
                )}
              </div>
            </div>
          </div>

        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-5">
          <div className="min-w-0 text-sm text-muted-foreground">
            <p>
              {selectedIds.size
                ? `${formatPtNumber(selectedIds.size)} lotes · ${formatPtNumber(releaseImageTotal)} imagens na release`
                : "Selecione pelo menos um lote"}
            </p>
            {annotatedScopeEmpty && (
              <p className="mt-0.5 text-xs text-destructive">
                Nenhuma imagem anotada nos lotes selecionados.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={creating}>
              Cancelar
            </Button>
            <Button
              onClick={() => onCreate({ name: name.trim(), taskExternalIds: Array.from(selectedIds), imageScope })}
              disabled={creating || !selectedIds.size || !name.trim() || annotatedScopeEmpty}
            >
              <Package className="size-4" />
              {creating ? "Criando..." : "Criar release"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function snapshotCounts(snapshot: Record<string, unknown>) {
  const counts = snapshot.counts
  return counts && typeof counts === "object" ? (counts as { annotations?: number; images?: number }) : {}
}

function snapshotArtifacts(snapshot: Record<string, unknown>) {
  return Array.isArray(snapshot.artifacts) ? (snapshot.artifacts as Record<string, unknown>[]) : []
}

function releaseImageScopeLabel(snapshot: Record<string, unknown>) {
  return snapshot.image_scope === "annotated"
    ? "Somente imagens anotadas"
    : "Todas as imagens dos lotes"
}

function taskAnnotationCount(task: BackendTask) {
  const raw = task.raw && typeof task.raw === "object" ? task.raw : {}
  const progress = raw.annotation_progress && typeof raw.annotation_progress === "object" ? raw.annotation_progress as Record<string, unknown> : {}
  const counts = raw.counts && typeof raw.counts === "object" ? raw.counts as Record<string, unknown> : {}
  const candidates = [
    progress.annotations,
    counts.annotations,
    counts.objects,
    raw.annotations,
    raw.annotation_count,
    raw.objects,
    raw.object_count,
    raw.labels_count,
  ]
  for (const value of candidates) {
    const number = metricNumber(value)
    if (number !== null) return number
  }
  return 0
}

function taskAnnotatedImageCount(task: BackendTask) {
  const raw = task.raw && typeof task.raw === "object" ? task.raw : {}
  const progress = raw.annotation_progress && typeof raw.annotation_progress === "object" ? raw.annotation_progress as Record<string, unknown> : {}
  const datasetImport = raw.dataset_import && typeof raw.dataset_import === "object" ? raw.dataset_import as Record<string, unknown> : {}
  const candidates = [
    progress.annotated_images,
    datasetImport.annotated_frames,
    raw.annotated_images,
    raw.annotated_frames,
  ]
  for (const value of candidates) {
    const number = metricNumber(value)
    if (number !== null) return Math.min(Math.max(0, number), Math.max(0, task.size || 0))
  }
  return taskAnnotationCount(task) > 0 ? Math.min(1, Math.max(0, task.size || 0)) : 0
}

function metricNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function releaseStatus(status: string): "publicado" | "em-construcao" | "falhou" | "cancelado" | "arquivado" {
  if (status === "ready") return "publicado"
  if (status === "building") return "em-construcao"
  if (status === "failed") return "falhou"
  if (status === "canceled") return "cancelado"
  return "arquivado"
}
