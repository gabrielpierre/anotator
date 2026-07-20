"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, Search, Clock, Cpu, TrendingUp, Database, Check, X, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { StatusBadge, ProgressBar } from "@/components/app/primitives"
import { fetchDatasetReleases, fetchTrainingRuns, mockFallbackEnabled } from "@/lib/api/client"
import { formatDateTimePt, toUiJobStatus } from "@/lib/api/status"
import type { BackendDatasetRelease, BackendTrainingRun } from "@/lib/api/types"
import { trainings, releases as mockReleases, type JobStatus } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function TrainingList() {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [backendRuns, setBackendRuns] = React.useState<BackendTrainingRun[] | null>(null)
  const [backendReleases, setBackendReleases] = React.useState<BackendDatasetRelease[] | null>(null)
  const useMocks = mockFallbackEnabled()

  React.useEffect(() => {
    const controller = new AbortController()
    Promise.all([fetchTrainingRuns(controller.signal), fetchDatasetReleases(controller.signal)])
      .then(([runs, datasetReleases]) => {
        setBackendRuns(runs)
        setBackendReleases(datasetReleases)
      })
      .catch(() => {
        setBackendRuns(null)
        setBackendReleases(null)
      })
    return () => controller.abort()
  }, [])

  const items = React.useMemo(
    () => (backendRuns?.length ? backendRuns.map(toTrainingListItem) : useMocks ? trainings.map(toMockTrainingListItem) : []),
    [backendRuns, useMocks],
  )
  const running = items.filter((item) => item.status === "executando" || item.status === "na-fila").length
  const completed = items.filter((item) => item.status === "concluido").length
  const bestMap = items.reduce((best, item) => Math.max(best, item.bestMapValue ?? 0), 0)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Treinamentos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe execuções de treino, compare métricas e inicie novos jobs.
          </p>
        </div>
        <Button size="lg" onClick={() => setPickerOpen(true)}>
          <Plus className="size-4" />
          Novo treinamento
        </Button>
      </div>

      <ReleasePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        backendReleases={backendReleases}
        useMocks={useMocks}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Em execução" value={String(running)} hint="fila local" />
        <MetricCard label="Concluídos" value={String(completed)} hint="histórico local" />
        <MetricCard label="Melhor mAP50-95" value={bestMap ? bestMap.toFixed(3) : "--"} hint="MLflow + banco" />
        <MetricCard label="Tempo médio" value="1h 12m" hint="por treinamento" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Histórico de treinamentos</CardTitle>
          <div className="w-full max-w-xs">
            <Input
              placeholder="Buscar por ID ou modelo..."
              aria-label="Buscar treinamentos"
              icon={<Search />}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {items.map((t) => (
              <Link
                key={t.id}
                href={t.href}
                className="flex flex-col gap-4 px-5 py-4 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                    <TrendingUp className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">{t.name}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.model} · {t.dataset} · {t.startedAt}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 sm:flex sm:items-center sm:gap-8">
                  <div className="min-w-[84px]">
                    <p className="text-xs text-muted-foreground">Época</p>
                    <p className="text-sm font-medium text-foreground tabular-nums">
                      {t.epoch} / {t.epochs}
                    </p>
                  </div>
                  <div className="min-w-[84px]">
                    <p className="text-xs text-muted-foreground">mAP50-95</p>
                    <p className="text-sm font-medium text-foreground tabular-nums">{t.bestMap}</p>
                  </div>
                  <div className="hidden min-w-[120px] items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <Clock className="size-3.5" />
                    {t.elapsed}
                  </div>
                  <div className="hidden min-w-[120px] items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <Cpu className="size-3.5" />
                    {t.device}
                  </div>
                </div>

                <div className="w-full sm:w-40">
                  <ProgressBar value={t.progress} />
                </div>
              </Link>
            ))}
            {items.length === 0 && (
              <p className="px-5 py-6 text-center text-sm text-muted-foreground">Nenhum treinamento registrado.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

type TrainingListItem = {
  id: string
  href: string
  name: string
  status: JobStatus
  model: string
  dataset: string
  startedAt: string
  epoch: string
  epochs: string
  bestMap: string
  bestMapValue: number | null
  elapsed: string
  device: string
  progress: number
}

function toMockTrainingListItem(training: (typeof trainings)[number]): TrainingListItem {
  return {
    id: training.id,
    href: `/treinar/${training.slug}`,
    name: training.name,
    status: training.status,
    model: training.model,
    dataset: training.dataset,
    startedAt: training.startedAt,
    epoch: String(training.epoch),
    epochs: String(training.epochs),
    bestMap: String(training.bestMap),
    bestMapValue: metricNumber(training.bestMap),
    elapsed: training.elapsed,
    device: training.device,
    progress: training.progress,
  }
}

function toTrainingListItem(run: BackendTrainingRun): TrainingListItem {
  const epochs = numberFromRecord(run.config, "epochs", 100)
  const epoch = numberFromRecord(run.metrics, "epoch", Math.round((run.progress / 100) * epochs))
  const bestMapValue = bestMapFromMetrics(run.metrics)
  const model = run.base_model.replace(/\.pt$/i, "")
  return {
    id: run.id,
    href: `/treinar/${run.id}`,
    name: String(run.config.model_name ?? `Training ${model}`),
    status: toUiJobStatus(run.status),
    model,
    dataset: run.dataset_release_id.slice(0, 8),
    startedAt: formatDateTimePt(run.created_at),
    epoch: String(epoch),
    epochs: String(epochs),
    bestMap: bestMapValue === null ? "--" : bestMapValue.toFixed(3),
    bestMapValue,
    elapsed: run.mlflow_run_id ? `MLflow ${run.mlflow_run_id.slice(0, 8)}` : "--",
    device: String(run.config.device ?? "auto"),
    progress: Math.round(run.progress),
  }
}

function numberFromRecord(record: Record<string, unknown>, key: string, fallback: number) {
  return metricNumber(record[key]) ?? fallback
}

function bestMapFromMetrics(metrics: Record<string, unknown>) {
  const keys = ["metrics/mAP50-95(B)", "map5095", "box_map", "box.map", "mAP50-95"]
  for (const key of keys) {
    const value = metricNumber(metrics[key])
    if (value !== null) return value
  }
  return null
}

function metricNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toReleaseOption(release: BackendDatasetRelease) {
  const counts = release.snapshot.counts
  const countMap = counts && typeof counts === "object" ? (counts as Record<string, unknown>) : {}
  const artifactSize = artifactSizeFromSnapshot(release.snapshot)
  return {
    id: release.id,
    name: release.name,
    status: release.status,
    images: metricNumber(countMap.images) ?? 0,
    objects: metricNumber(countMap.annotations) ?? metricNumber(countMap.objects) ?? 0,
    size: artifactSize,
    date: formatDateTimePt(release.created_at),
  }
}

function artifactSizeFromSnapshot(snapshot: Record<string, unknown>) {
  const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : []
  const bytes = artifacts.reduce((total, artifact) => {
    if (!artifact || typeof artifact !== "object") return total
    return total + (metricNumber((artifact as Record<string, unknown>).size_bytes) ?? 0)
  }, 0)
  if (!bytes) return "--"
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const statusLabels: Record<string, { label: string; className: string }> = {
  "em-construcao": { label: "Em construção", className: "bg-warning/15 text-warning" },
  publicado: { label: "Publicado", className: "bg-brand-green/15 text-brand-green" },
  arquivado: { label: "Arquivado", className: "bg-muted text-muted-foreground" },
  building: { label: "Em construção", className: "bg-warning/15 text-warning" },
  ready: { label: "Pronto", className: "bg-brand-green/15 text-brand-green" },
  failed: { label: "Falhou", className: "bg-destructive/15 text-destructive" },
  canceled: { label: "Cancelado", className: "bg-muted text-muted-foreground" },
}

function ReleasePicker({
  open,
  onClose,
  backendReleases,
  useMocks,
}: {
  open: boolean
  onClose: () => void
  backendReleases: BackendDatasetRelease[] | null
  useMocks: boolean
}) {
  const router = useRouter()
  const releaseOptions = React.useMemo(() => {
    if (backendReleases) {
      return backendReleases
        .filter((release) => release.status === "ready" && release.immutable && release.artifact_uri)
        .map(toReleaseOption)
    }
    return useMocks
      ? mockReleases.map((release) => ({
      id: release.id,
      name: release.id,
      status: release.status,
      images: release.images,
      objects: release.objects,
      size: release.size,
      date: release.date,
        }))
      : []
  }, [backendReleases, useMocks])
  const [selected, setSelected] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    setSelected((current) => (releaseOptions.some((release) => release.id === current) ? current : releaseOptions[0]?.id ?? ""))
  }, [open, releaseOptions])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  function confirm() {
    router.push(`/treinar/novo?release=${encodeURIComponent(selected)}`)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Selecionar dataset release"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Selecionar dataset release</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Escolha o release que será usado como base para o novo treinamento.
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

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-4">
          {releaseOptions.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              Nenhum DatasetRelease pronto e imutável foi encontrado.
            </div>
          )}
          {releaseOptions.map((r, i) => {
            const active = selected === r.id
            const s = statusLabels[r.status] ?? statusLabels.arquivado
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-colors",
                  active ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/40",
                )}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-brand-blue">
                  <Database className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {r.name}
                    {i === 0 && (
                      <span className="rounded-full bg-brand-green/15 px-1.5 py-0.5 text-xs font-medium text-brand-green">
                        Mais recente
                      </span>
                    )}
                    <span className={cn("rounded-full px-1.5 py-0.5 text-xs font-medium", s.className)}>{s.label}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.images.toLocaleString("pt-BR")} imagens · {r.objects.toLocaleString("pt-BR")} objetos · {r.size}
                  </p>
                  <p className="text-xs text-muted-foreground">Criado em {r.date}</p>
                </div>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-brand-blue bg-brand-blue text-white" : "border-border",
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={!selected}>
            Continuar
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
