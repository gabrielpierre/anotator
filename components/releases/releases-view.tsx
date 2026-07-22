"use client"

import * as React from "react"
import { Check, ChevronRight, Database, Download, GitBranch, Package, Search, Trash2, X } from "lucide-react"

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

  const handleCreateRelease = async (payload: { name: string; taskExternalIds: string[] }) => {
    if (!payload.taskExternalIds.length || creating) return
    setCreating(true)
    setError(null)
    try {
      const release = await createDatasetRelease({
        name: payload.name,
        project_id: currentProject?.id ?? null,
        task_external_ids: payload.taskExternalIds,
        include_images: true,
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
        <Card>
          <CardHeader>
            <CardTitle>Historico de releases</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {realReleases.length
              ? realReleases.map((release) => {
                  const counts = snapshotCounts(release.snapshot)
                  const selected = release.id === selectedRelease?.id
                  const deleting = deletingReleaseId === release.id
                  const artifacts = snapshotArtifacts(release.snapshot)
                  return (
                    <div
                      key={release.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedReleaseId(release.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedReleaseId(release.id)
                      }}
                      className={cn(
                        "flex cursor-pointer flex-wrap items-center justify-between gap-4 rounded-xl border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-brand-blue/30",
                        selected ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex size-10 items-center justify-center rounded-lg bg-background text-brand-blue">
                          <GitBranch className="size-5" />
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{release.name}</span>
                            <StatusBadge status={releaseStatus(release.status)} />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            Criado em {formatDateTimePt(release.created_at)} -{" "}
                            {formatPtNumber(counts.images ?? 0)} imagens -{" "}
                            {formatPtNumber(counts.annotations ?? 0)} objetos
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatPtNumber(artifacts.length)} arquivo{artifacts.length === 1 ? "" : "s"}
                        </span>
                        <Button
                          variant="destructive"
                          size="sm"
                          aria-label={`Excluir release ${release.name}`}
                          disabled={Boolean(deletingReleaseId)}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleDeleteRelease(release)
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          {deleting ? "Excluindo..." : "Excluir"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Baixar release"
                          disabled={!release.artifact_uri}
                          onClick={(event) => {
                            event.stopPropagation()
                            void downloadBackendFile(datasetReleaseDownloadPath(release.id), `${release.name}.zip`)
                          }}
                        >
                          <Download className="size-4" />
                        </Button>
                        <ChevronRight className={cn("size-4", selected ? "text-brand-blue" : "text-muted-foreground")} />
                      </div>
                    </div>
                  )
                })
              : <p className="text-sm text-muted-foreground">Nenhum release sincronizado.</p>}
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
  onCreate: (payload: { name: string; taskExternalIds: string[] }) => void
}) {
  const defaultName = React.useMemo(() => `release_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`, [open])
  const [name, setName] = React.useState(defaultName)
  const [query, setQuery] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    if (!open) return
    setName(defaultName)
    setQuery("")
    setSelectedIds(new Set(tasks.map((task) => task.external_id)))
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
                          {formatPtNumber(task.size)} imagens · {formatPtNumber(taskAnnotationCount(task))} objetos · CVAT #{task.external_id}
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
          <p className="text-sm text-muted-foreground">
            {selectedIds.size ? `${formatPtNumber(selectedIds.size)} lotes selecionados` : "Selecione pelo menos um lote"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={creating}>
              Cancelar
            </Button>
            <Button
              onClick={() => onCreate({ name: name.trim(), taskExternalIds: Array.from(selectedIds) })}
              disabled={creating || !selectedIds.size || !name.trim()}
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
