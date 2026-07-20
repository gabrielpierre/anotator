"use client"

import * as React from "react"
import { Check, ChevronRight, Download, FileArchive, GitBranch, Package } from "lucide-react"

import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { MetricCard } from "@/components/snowui/metric-card"
import { Button } from "@/components/ui/button"
import {
  artifactDownloadPathFromUri,
  createDatasetRelease,
  datasetReleaseDownloadPath,
  downloadBackendFile,
  fetchDatasetReleases,
  fetchTasks,
} from "@/lib/api/client"
import { formatDateTimePt, formatPtNumber } from "@/lib/api/status"
import type { BackendDatasetRelease, BackendTask } from "@/lib/api/types"

export function ReleasesView() {
  const [backendReleases, setBackendReleases] = React.useState<BackendDatasetRelease[] | null>(null)
  const [tasks, setTasks] = React.useState<BackendTask[]>([])
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback((signal?: AbortSignal) => {
    fetchDatasetReleases(signal).then(setBackendReleases).catch(() => setBackendReleases(null))
    fetchTasks(signal).then(setTasks).catch(() => setTasks([]))
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal)
    return () => controller.abort()
  }, [reload])

  const realReleases = backendReleases ?? []
  const latestRelease = realReleases[0]
  const latestSnapshot = latestRelease?.snapshot ?? {}
  const latestCounts = snapshotCounts(latestSnapshot)
  const latestArtifacts = snapshotArtifacts(latestSnapshot)
  const buildingCount = realReleases.filter((release) => release.status === "building").length

  const handleCreateRelease = async () => {
    if (!tasks.length || creating) return
    setCreating(true)
    setError(null)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
      const release = await createDatasetRelease({
        name: `release_${stamp}`,
        task_external_ids: tasks.map((task) => task.external_id),
        include_images: true,
        export_format: "CVAT for images 1.1",
      })
      setBackendReleases((current) => [release, ...(current ?? [])])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar release")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Releases"
        subtitle="Versoes imutaveis do dataset prontas para treino e exportacao."
        actions={
          <Button onClick={handleCreateRelease} disabled={!tasks.length || creating}>
            <Package className="size-4" />
            {creating ? "Criando..." : "Novo release"}
          </Button>
        }
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Releases"
          value={formatPtNumber(realReleases.length)}
          hint={`${formatPtNumber(buildingCount)} em construcao`}
          tone="blue"
        />
        <MetricCard
          label="Ultimo release"
          value={latestRelease?.name ?? "--"}
          hint={latestRelease ? formatDateTimePt(latestRelease.created_at) : "--"}
          tone="mint"
        />
        <MetricCard
          label="Objetos"
          value={formatPtNumber(latestCounts.annotations ?? 0)}
          hint={`${formatPtNumber(latestCounts.images ?? 0)} imagens`}
          tone="purple"
        />
        <MetricCard
          label="Artefatos"
          value={latestRelease?.artifact_uri ? "MinIO" : "--"}
          hint={`${formatPtNumber(latestArtifacts.length)} arquivos`}
          tone="subtle"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Historico de releases</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {realReleases.length
              ? realReleases.map((release) => {
                  const counts = snapshotCounts(release.snapshot)
                  return (
                    <div
                      key={release.id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4 transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex size-10 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
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
                          {release.immutable ? "imutavel" : "mutavel"}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Baixar release"
                          disabled={!release.artifact_uri}
                          onClick={() =>
                            void downloadBackendFile(datasetReleaseDownloadPath(release.id), `${release.name}.zip`)
                          }
                        >
                          <Download className="size-4" />
                        </Button>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </div>
                    </div>
                  )
                })
              : <p className="text-sm text-muted-foreground">Nenhum release sincronizado.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saidas do {latestRelease?.name ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {latestArtifacts.length
              ? latestArtifacts.map((artifact) => (
                  <ArtifactRow
                    key={String(artifact.uri ?? artifact.filename)}
                    name={String(artifact.format ?? "Export CVAT")}
                    file={String(artifact.filename ?? artifact.uri ?? "dataset.zip")}
                    size={formatBytes(Number(artifact.size_bytes ?? 0))}
                    disabled={!artifact.uri}
                    onDownload={() => {
                      if (artifact.uri) {
                        void downloadBackendFile(
                          artifactDownloadPathFromUri(String(artifact.uri)),
                          String(artifact.filename ?? "artifact.zip"),
                        )
                      }
                    }}
                  />
                ))
              : <p className="text-sm text-muted-foreground">Nenhum artefato disponivel.</p>}
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-green/12 px-3 py-2 text-xs text-brand-green">
              <Check className="size-4" />
              {latestRelease?.status === "ready"
                ? "Pronto para treinar novos modelos."
                : "Aguardando exportacao dos artefatos."}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ArtifactRow({
  name,
  file,
  size,
  disabled,
  onDownload,
}: {
  name: string
  file: string
  size: string
  disabled: boolean
  onDownload?: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <FileArchive className="size-4" />
        </span>
        <div>
          <div className="text-sm font-medium text-foreground">{name}</div>
          <span className="text-xs text-muted-foreground">{file}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">{size}</span>
        <Button variant="ghost" size="icon" aria-label={`Baixar ${name}`} disabled={disabled} onClick={onDownload}>
          <Download className="size-4" />
        </Button>
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

function releaseStatus(status: string): "publicado" | "em-construcao" | "arquivado" {
  if (status === "ready") return "publicado"
  if (status === "building") return "em-construcao"
  return "arquivado"
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "--"
  if (value < 1024 * 1024) return `${formatPtNumber(Math.round(value / 1024))} KB`
  if (value < 1024 * 1024 * 1024) return `${formatPtNumber(Math.round(value / 1024 / 1024))} MB`
  return `${(value / 1024 / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`
}
