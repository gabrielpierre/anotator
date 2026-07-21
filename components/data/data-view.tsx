"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Upload, Search, Filter, Image as ImageIcon, Database, HardDrive, Scissors, Download } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge, ProgressBar } from "@/components/app/primitives"
import { DerivedDatasetDialog } from "@/components/data/derived-dataset-dialog"
import { ImportBatchDialog } from "@/components/data/import-batch-dialog"
import {
  apiAssetUrl,
  derivedAssetDownloadPath,
  downloadBackendFile,
  fetchDashboard,
  fetchDerivedAssets,
  fetchPipelineRuns,
  fetchTasks,
} from "@/lib/api/client"
import { formatDateTimePt, formatPtNumber, labelsFromTasks, toUiJobStatus } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendDashboard, BackendDerivedAsset, BackendPipelineRun, BackendTask } from "@/lib/api/types"

const batchStatusTone: Record<string, string> = {
  Anotando: "text-brand-blue",
  "Pré-processando": "text-warning",
  Pipeline: "text-brand-indigo",
  Concluído: "text-brand-green",
}

export function DataView() {
  const router = useRouter()
  const [tasks, setTasks] = React.useState<BackendTask[] | null>(null)
  const [dashboard, setDashboard] = React.useState<BackendDashboard | null>(null)
  const [derivedAssets, setDerivedAssets] = React.useState<BackendDerivedAsset[] | null>(null)
  const [pipelineRuns, setPipelineRuns] = React.useState<BackendPipelineRun[] | null>(null)
  const [pipelineError, setPipelineError] = React.useState<string | null>(null)
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [derivedDialogOpen, setDerivedDialogOpen] = React.useState(false)
  const { projects } = useCurrentUser()

  React.useEffect(() => {
    const controller = new AbortController()
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    fetchDashboard("default", controller.signal).then(setDashboard).catch(() => setDashboard(null))
    fetchDerivedAssets({ limit: 8 }, controller.signal).then(setDerivedAssets).catch(() => setDerivedAssets(null))
    fetchPipelineRuns(controller.signal).then(setPipelineRuns).catch(() => setPipelineRuns(null))
    return () => controller.abort()
  }, [])

  const batches =
    tasks?.map((task) => ({
          id: task.id || task.external_id,
          externalId: task.external_id,
          name: task.name || `Task ${task.external_id}`,
          images: task.size,
          status: taskStatusLabel(task.status),
          progress: task.status.toLowerCase() === "completed" ? 100 : 0,
          source: task.project_external_id ? `CVAT project ${task.project_external_id}` : "CVAT",
          previewUrl: apiAssetUrl(task.preview_url),
          createdAt: formatDateTimePt(task.created_at),
        })) ?? []

  const taskClasses = labelsFromTasks(tasks)
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
  const annotatedCount = (tasks ?? [])
    .filter((task) => task.status.toLowerCase() === "completed")
    .reduce((total, task) => total + task.size, 0)
  const objectCount = dashboard?.class_distribution.reduce((total, item) => total + item.count, 0) ?? 0
  const latestPipeline = pipelineRuns?.[0] ?? null
  const storage = storageFromDashboard(dashboard)
  const currentProjectId = dashboard?.project?.id ?? projects[0]?.id ?? null

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
        onImported={() => {
          setImportDialogOpen(false)
          router.push(currentProjectId ? `/jobs?project=${encodeURIComponent(currentProjectId)}` : "/jobs")
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
          hint="Sincronizado do CVAT"
          tone="mint"
        />
        <MetricCard
          label="Objetos anotados"
          value={formatPtNumber(objectCount)}
          hint="Labels/classes conhecidas"
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
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Lote</th>
                  <th className="px-5 py-3 font-medium">Imagens</th>
                  <th className="px-5 py-3 font-medium">Origem</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Progresso</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const previewUrl = "previewUrl" in b && typeof b.previewUrl === "string" ? b.previewUrl : null
                  return (
                  <tr key={b.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
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
                        {b.name}
                      </div>
                    </td>
                    <td className="px-5 py-3 tabular-nums text-muted-foreground">{b.images.toLocaleString("pt-BR")}</td>
                    <td className="px-5 py-3 text-muted-foreground">{b.source}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-medium ${batchStatusTone[b.status] ?? "text-muted-foreground"}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <ProgressBar value={b.progress} className="w-24" />
                        <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{b.progress}%</span>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
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
              <Button variant="outline" size="sm" className="mt-1 w-fit">
                <Database className="size-4" />
                Gerenciar storage
              </Button>
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

function taskStatusLabel(status: string) {
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

function storageFromDashboard(dashboard: BackendDashboard | null) {
  const storage = dashboard?.project?.raw?.storage
  if (!storage || typeof storage !== "object") {
    return { percent: 0, label: "Nenhum storage de projeto configurado." }
  }
  const data = storage as Record<string, unknown>
  const quotaGb = numberFromUnknown(data.quota_gb)
  const usedBytes = numberFromUnknown(data.used_bytes) ?? 0
  if (!quotaGb) return { percent: 0, label: "Limite de storage não configurado." }
  const usedGb = usedBytes / 1024 ** 3
  return {
    percent: Math.min(100, Math.round((usedGb / quotaGb) * 100)),
    label: `${usedGb.toFixed(1)} GB de ${quotaGb} GB utilizados`,
  }
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
