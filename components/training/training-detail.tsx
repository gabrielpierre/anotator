"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Pause, Square, MoreHorizontal, Settings2, ChevronRight } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, ProgressBar, StatRow, Meter } from "@/components/app/primitives"
import { TabNav } from "@/components/app/tab-nav"
import { MetricLineChart } from "@/components/app/charts"
import {
  deleteTrainingRun,
  downloadBackendFile,
  fetchTrainingRun,
  pauseTrainingRun,
  stopTrainingRun,
  trainingArtifactAssetUrl,
  trainingArtifactDownloadPath,
  trainingRunEventsUrl,
} from "@/lib/api/client"
import { formatDateTimePt, toUiJobStatus } from "@/lib/api/status"
import { cn } from "@/lib/utils"
import type { BackendTrainingRun } from "@/lib/api/types"

const TABS = [
  { key: "overview", label: "Visão geral" },
  { key: "metrics", label: "Métricas" },
  { key: "per-class", label: "Métricas por classe" },
  { key: "resources", label: "Recursos" },
  { key: "logs", label: "Logs" },
  { key: "artifacts", label: "Artefatos" },
  { key: "config", label: "Configuração" },
]

const chartSeries = [
  { key: "map50", label: "mAP@0.5", color: "var(--brand-sky)" },
  { key: "map5095", label: "mAP@0.5:0.95", color: "var(--brand-green)" },
  { key: "precision", label: "Precision", color: "var(--brand-lavender)" },
  { key: "recall", label: "Recall", color: "var(--warning)" },
  { key: "loss", label: "Loss", color: "var(--destructive)" },
]

const metricDefinitions = [
  {
    key: "map50",
    label: "mAP@0.5",
    aliases: ["map50", "box_map50", "metrics/mAP50(B)", "metrics_mAP50_B_"],
  },
  {
    key: "map5095",
    label: "mAP@0.5:0.95",
    aliases: ["map5095", "box_map", "metrics/mAP50-95(B)", "metrics_mAP50-95_B_", "fitness"],
  },
  {
    key: "precision",
    label: "Precision",
    aliases: ["precision", "metrics/precision(B)", "metrics_precision_B_"],
  },
  {
    key: "recall",
    label: "Recall",
    aliases: ["recall", "metrics/recall(B)", "metrics_recall_B_"],
  },
  {
    key: "loss",
    label: "Loss",
    aliases: ["loss", "train_loss", "train/box_loss"],
  },
] as const

type MetricRow = {
  key: string
  label: string
  value: string
  color: string
}

type TrainingImageArtifact = {
  runId: string
  name: string
  path: string
  uri: string
  label: string
}

export function TrainingDetail({ id }: { id: string }) {
  const router = useRouter()
  const [tab, setTab] = React.useState("overview")
  const [run, setRun] = React.useState<BackendTrainingRun | null>(null)
  const [actionMenuOpen, setActionMenuOpen] = React.useState(false)
  const [actionBusy, setActionBusy] = React.useState<"pause" | "stop" | "delete" | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchTrainingRun(id, controller.signal)
      .then(setRun)
      .catch(() => setRun(null))

    const events = new EventSource(trainingRunEventsUrl(id))
    events.addEventListener("snapshot", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as Partial<BackendTrainingRun>
      setRun((current) => (current ? { ...current, ...payload } : current))
    })
    events.onerror = () => {
      fetchTrainingRun(id).then(setRun).catch(() => undefined)
    }
    return () => {
      controller.abort()
      events.close()
    }
  }, [id])

  if (!run) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Treinamento #{id}</h1>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nenhum treinamento encontrado no backend local.
          </CardContent>
        </Card>
      </div>
    )
  }

  const currentRun = run
  const progress = Math.round(currentRun.progress)
  const displayKpis = kpisFromRun(currentRun)
  const failureMessage = failureMessageFromRun(currentRun)
  const canPause = currentRun.status === "queued" || currentRun.status === "running"
  const canStop = canPause || currentRun.status === "paused"

  async function handlePause() {
    if (!canPause || actionBusy) return
    setActionBusy("pause")
    setActionError(null)
    try {
      setRun(await pauseTrainingRun(currentRun.id))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível pausar o treinamento.")
    } finally {
      setActionBusy(null)
    }
  }

  async function handleStop() {
    if (!canStop || actionBusy) return
    const confirmed = window.confirm("Parar este treinamento agora? O job ativo será cancelado.")
    if (!confirmed) return
    setActionBusy("stop")
    setActionError(null)
    try {
      setRun(await stopTrainingRun(currentRun.id))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível parar o treinamento.")
    } finally {
      setActionBusy(null)
    }
  }

  async function handleDelete() {
    if (actionBusy) return
    const confirmed = window.confirm(
      "Excluir este treinamento definitivamente? Isso cancela jobs ativos e apaga modelos e artefatos gerados por ele.",
    )
    if (!confirmed) return
    setActionBusy("delete")
    setActionError(null)
    try {
      await deleteTrainingRun(currentRun.id)
      router.push("/treinar")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível excluir o treinamento.")
      setActionBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Treinamento #{run.id.slice(0, 8)}</h1>
          <StatusBadge status={toUiJobStatus(run.status)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPause && (
            <Button variant="outline" disabled={actionBusy !== null} onClick={() => void handlePause()}>
              <Pause className="size-4" />
              {actionBusy === "pause" ? "Pausando..." : "Pausar"}
            </Button>
          )}
          {canStop && (
            <Button
              variant="outline"
              disabled={actionBusy !== null}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-45"
              onClick={() => void handleStop()}
            >
              <Square className="size-4" />
              {actionBusy === "stop" ? "Parando..." : "Parar"}
            </Button>
          )}
          <div className="relative">
            <Button
              variant="ghost"
              aria-label="Mais ações"
              aria-expanded={actionMenuOpen}
              onClick={() => setActionMenuOpen((open) => !open)}
            >
              <MoreHorizontal className="size-4" />
              Mais ações
            </Button>
            {actionMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setActionMenuOpen(false)
                    void handleDelete()
                  }}
                  disabled={actionBusy !== null}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  Excluir treinamento
                  <span className="text-xs text-destructive/70">apagar tudo</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {/* KPI strip */}
      <Card className="p-0">
        <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-3 lg:grid-cols-7 lg:divide-y-0">
          {displayKpis.map((k) => (
            <div key={k.label} className="flex flex-col gap-1 p-4">
              <span className="text-xs text-muted-foreground">{k.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{k.value}</span>
            </div>
          ))}
          <div className="col-span-2 flex flex-col justify-center gap-2 p-4 sm:col-span-3 lg:col-span-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Progresso geral</span>
              <span className="font-semibold tabular-nums text-foreground">{progress}%</span>
            </div>
            <ProgressBar value={progress} color="bg-brand-green" />
          </div>
        </div>
      </Card>

      {failureMessage && (
        <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Motivo da falha</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">{failureMessage}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* Main column */}
        <div className="flex min-w-0 flex-col gap-6">
          <TabNav tabs={TABS} value={tab} onChange={setTab} />

          {tab === "overview" && <OverviewTab run={run} />}
          {tab === "metrics" && <MetricsTab run={run} />}
          {tab === "per-class" && <PerClassTab run={run} />}
          {tab === "resources" && <ResourcesTab run={run} />}
          {tab === "logs" && <LogsTab run={run} />}
          {tab === "artifacts" && <ArtifactsTab run={run} />}
          {tab === "config" && <ConfigTab run={run} />}
        </div>

        {/* Right rail */}
        <aside className="flex flex-col gap-6">
          <TrainingConfigCard run={run} onShowConfig={() => setTab("config")} />
          <MachineResourcesCard run={run} progress={progress} />
        </aside>
      </div>
    </div>
  )
}

function kpisFromRun(run: BackendTrainingRun) {
  const epochs = numberParam(run.config, "epochs", 100)
  const epoch = numberParam(run.metrics, "epoch", Math.round((run.progress / 100) * epochs))
  return [
    { label: "Modelo base", value: run.base_model },
    { label: "Dataset", value: run.dataset_release_id.slice(0, 8) },
    { label: "Iniciado em", value: formatDateTimePt(run.created_at) },
    { label: "MLflow", value: run.mlflow_run_id?.slice(0, 10) ?? "--" },
    { label: "Época", value: `${epoch} / ${epochs}` },
    { label: "mAP50-95", value: metricText(bestMapFromMetrics(run.metrics)) },
  ]
}

function TrainingConfigCard({
  run,
  onShowConfig,
}: {
  run: BackendTrainingRun
  onShowConfig: () => void
}) {
  const modelName = String(run.config.model_name ?? run.base_model)
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 border-b border-border px-5 py-4">
        <CardTitle>Configuração</CardTitle>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-brand-blue hover:bg-brand-blue/10"
        >
          <Settings2 className="size-3.5" />
          Editar
        </button>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="grid grid-cols-2 gap-2">
          <ConfigMetric label="Modelo" value={modelName} />
          <ConfigMetric label="Device" value={String(run.config.device ?? "auto")} />
          <ConfigMetric label="Épocas" value={String(numberParam(run.config, "epochs", 100))} />
          <ConfigMetric label="Imagem" value={`${numberParam(run.config, "image_size", 640)} px`} />
          <ConfigMetric label="Batch" value={String(numberParam(run.config, "batch_size", 16))} />
          <ConfigMetric label="Workers" value={String(numberParam(run.config, "workers", 8))} />
        </div>

        <div className="space-y-2">
          <CompactIdRow label="Dataset" value={run.dataset_release_id} />
          <CompactIdRow label="MLflow" value={run.mlflow_run_id} />
          <CompactIdRow label="Seed" value={String(numberParam(run.config, "seed", 42))} plain />
        </div>

        <button
          type="button"
          onClick={onShowConfig}
          className="w-full rounded-full border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
        >
          Ver configuração completa
        </button>
      </CardContent>
    </Card>
  )
}

function MachineResourcesCard({
  run,
  progress,
}: {
  run: BackendTrainingRun
  progress: number
}) {
  const resourcePolicy = objectRecord(run.config.resource_policy)
  const device = String(run.config.device ?? resourcePolicy?.device ?? "auto")
  const deviceLabel = String(resourcePolicy?.device_label ?? (device === "cpu" ? "CPU" : device))
  const workers = numberParam(run.config, "workers", 0)
  const batch = numberParam(run.config, "batch_size", 0)

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 border-b border-border px-5 py-4">
        <CardTitle>Recursos</CardTitle>
        <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          {run.status === "running" ? "Em uso" : "Snapshot"}
        </span>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="rounded-xl bg-muted/50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Dispositivo</p>
              <p className="mt-1 truncate text-sm font-semibold text-foreground" title={deviceLabel}>
                {deviceLabel}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-background px-2.5 py-1 text-xs font-semibold uppercase text-foreground ring-1 ring-border">
              {device}
            </span>
          </div>
        </div>

        <Meter label="Progresso reportado" value={progress} color="bg-brand-lavender" />

        <div className="grid grid-cols-2 gap-2">
          <ResourceMetric label="Workers" value={workers ? String(workers) : "--"} />
          <ResourceMetric label="Batch" value={batch ? String(batch) : "--"} />
        </div>
      </CardContent>
    </Card>
  )
}

function ConfigMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/45 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums text-foreground" title={value}>
        {value}
      </p>
    </div>
  )
}

function ResourceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

function CompactIdRow({
  label,
  value,
  plain = false,
}: {
  label: string
  value: string | null
  plain?: boolean
}) {
  const display = value ? (plain ? value : compactId(value)) : "--"
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-2.5 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 max-w-[210px] truncate text-right text-sm font-medium text-foreground",
          !plain && "font-mono text-xs tracking-normal",
        )}
        title={value ?? undefined}
      >
        {display}
      </span>
    </div>
  )
}

function compactId(value: string) {
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function numberParam(record: Record<string, unknown>, key: string, fallback: number) {
  const value = record[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function bestMapFromMetrics(metrics: Record<string, unknown>) {
  for (const key of ["metrics/mAP50-95(B)", "map5095", "box_map", "box.map", "mAP50-95"]) {
    const value = metrics[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function metricText(value: number | null) {
  return value === null ? "--" : value.toFixed(3)
}

function failureMessageFromRun(run: BackendTrainingRun) {
  if (run.status !== "failed" && run.status !== "canceled") return null
  for (const key of ["error", "reason", "message", "detail"]) {
    const value = run.metrics[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function metricRows(metrics: Record<string, unknown>) {
  const colors = ["var(--brand-sky)", "var(--brand-green)", "var(--brand-lavender)", "var(--warning)"]
  const canonicalRows: MetricRow[] = []
  for (const definition of metricDefinitions) {
    const value = metricValue(metrics, definition.aliases)
    const series = chartSeries.find((item) => item.key === definition.key)
    if (value !== null) {
      canonicalRows.push({
        key: definition.key,
        label: definition.label,
        value: metricText(value),
        color: series?.color ?? colors[0],
      })
    }
  }
  const reserved = new Set([
    "epoch",
    "epochs",
    "history",
    "learning_rate",
    "mlflow_run_id",
    "stage",
    "status",
    "time",
    ...metricDefinitions.flatMap((definition) => [definition.key, ...definition.aliases]),
  ])
  const extraRows: MetricRow[] = Object.entries(metrics)
    .filter(([key, value]) => !reserved.has(key) && numberValue(value) !== null)
    .map(([key, value], index) => ({
      key,
      label: key,
      value: metricText(numberValue(value)),
      color: colors[(canonicalRows.length + index) % colors.length],
    }))

  return [...canonicalRows, ...extraRows]
}

function chartDataFromMetrics(metrics: Record<string, unknown>) {
  const history = metrics.history
  if (Array.isArray(history)) {
    return history
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(normalizeChartRow)
      .filter(hasChartMetric)
  }
  const row = normalizeChartRow(metrics)
  return hasChartMetric(row) ? [row] : []
}

function normalizeChartRow(record: Record<string, unknown>) {
  const row: Record<string, number | string> = {
    epoch: metricValue(record, ["epoch"]) ?? 0,
  }
  for (const definition of metricDefinitions) {
    const value = metricValue(record, definition.aliases)
    if (value !== null) row[definition.key] = value
  }
  return row
}

function hasChartMetric(row: Record<string, number | string>) {
  return chartSeries.slice(0, 4).some((series) => numberValue(row[series.key]) !== null)
}

function metricValue(record: Record<string, unknown>, aliases: readonly string[]) {
  for (const alias of aliases) {
    const value = numberValue(record[alias])
    if (value !== null) return value
  }
  return null
}

function perClassRows(metrics: Record<string, unknown>) {
  const raw = metrics.per_class
  if (!raw || typeof raw !== "object") return []
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    return {
      name,
      instances: String(row.instances ?? row.count ?? "--"),
      precision: metricText(numberValue(row.precision)),
      recall: metricText(numberValue(row.recall)),
      map: metricText(numberValue(row.map5095 ?? row.map ?? row["mAP50-95"])),
    }
  })
}

function trainingImageArtifacts(run: BackendTrainingRun) {
  return run.artifacts
    .map((artifact): TrainingImageArtifact | null => {
      const row = artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>) : {}
      const uri = typeof row.uri === "string" ? row.uri : null
      if (!uri?.startsWith("s3://")) return null
      const name = String(row.name ?? row.path ?? "artifact")
      const path = String(row.path ?? name)
      if (!/\.(jpe?g|png)$/i.test(name) && !/\.(jpe?g|png)$/i.test(path)) return null
      return {
        runId: run.id,
        name,
        path,
        uri,
        label: visualArtifactLabel(path || name),
      }
    })
    .filter((artifact): artifact is TrainingImageArtifact => artifact !== null)
}

function confusionMatrixArtifacts(run: BackendTrainingRun) {
  const artifacts = trainingImageArtifacts(run).filter((artifact) =>
    artifact.path.toLowerCase().includes("confusion_matrix"),
  )
  return artifacts.sort((left, right) => {
    const leftNormalized = left.path.toLowerCase().includes("normalized") ? 0 : 1
    const rightNormalized = right.path.toLowerCase().includes("normalized") ? 0 : 1
    return leftNormalized - rightNormalized || left.path.localeCompare(right.path)
  })
}

function validationExampleArtifacts(run: BackendTrainingRun) {
  return trainingImageArtifacts(run)
    .filter((artifact) => {
      const path = artifact.path.toLowerCase()
      return path.includes("val_batch") && (path.includes("_pred") || path.includes("_labels"))
    })
    .sort((left, right) => {
      const leftPred = left.path.toLowerCase().includes("_pred") ? 0 : 1
      const rightPred = right.path.toLowerCase().includes("_pred") ? 0 : 1
      return leftPred - rightPred || left.path.localeCompare(right.path)
    })
}

function visualArtifactLabel(path: string) {
  const name = path.split("/").pop() ?? path
  if (name === "confusion_matrix_normalized.png") return "Matriz normalizada"
  if (name === "confusion_matrix.png") return "Matriz absoluta"
  const match = name.match(/^val_batch(\d+)_(pred|labels)\./i)
  if (match) return `Batch ${Number(match[1]) + 1} - ${match[2] === "pred" ? "predições" : "rótulos"}`
  return name
}

function OverviewTab({ run }: { run: BackendTrainingRun }) {
  const metrics = metricRows(run.metrics)
  const chartData = chartDataFromMetrics(run.metrics)
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Métricas reportadas</CardTitle>
          <span className="text-xs text-muted-foreground">{formatDateTimePt(run.updated_at)}</span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <div className="mb-3 flex flex-wrap gap-4">
              {chartSeries.slice(0, 4).map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
            <MetricLineChart data={chartData} series={chartSeries.slice(0, 4)} />
          </div>
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border pb-2 text-xs text-muted-foreground">
              <span>Métrica</span>
              <span className="text-right">Atual</span>
              <span className="text-right">Origem</span>
            </div>
            <div className="divide-y divide-border">
              {metrics.map((m) => (
                <div key={m.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: m.color }} />
                    {m.label}
                  </span>
                  <span className="text-right tabular-nums text-foreground">{m.value}</span>
                  <span className="text-right text-xs text-muted-foreground">backend</span>
                </div>
              ))}
              {metrics.length === 0 && (
                <p className="py-3 text-sm text-muted-foreground">Nenhuma métrica reportada ainda.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Progresso do treinamento</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Meter label="Progresso geral" value={Math.round(run.progress)} color="bg-brand-green" />
            <div className="divide-y divide-border">
              <StatRow label="Época" value={String(numberParam(run.metrics, "epoch", 0))} />
              <StatRow label="Batch size" value={String(numberParam(run.config, "batch_size", 0) || "--")} />
              <StatRow label="Taxa de aprendizado" value={metricText(numberValue(run.metrics.learning_rate))} />
              <StatRow label="MLflow" value={run.mlflow_run_id ?? "--"} />
            </div>
          </CardContent>
        </Card>

        <ValidationArtifactsCard run={run} />
      </div>
    </div>
  )
}

function ValidationArtifactsCard({ run }: { run: BackendTrainingRun }) {
  const [mode, setMode] = React.useState<"matrix" | "examples">("matrix")
  const [exampleIndex, setExampleIndex] = React.useState(0)
  const matrixArtifacts = confusionMatrixArtifacts(run)
  const exampleArtifacts = validationExampleArtifacts(run)
  const selectedExample = exampleArtifacts[Math.min(exampleIndex, Math.max(exampleArtifacts.length - 1, 0))]
  const epoch = numberParam(run.metrics, "epoch", 0)

  React.useEffect(() => {
    if (exampleIndex >= exampleArtifacts.length) setExampleIndex(0)
  }, [exampleArtifacts.length, exampleIndex])

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <CardTitle>Validação</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {epoch > 0 ? `Época ${epoch}` : "Aguardando primeira época"} ·{" "}
            {mode === "matrix" ? pluralCount(matrixArtifacts.length, "matriz", "matrizes") : pluralCount(exampleArtifacts.length, "exemplo", "exemplos")}
          </p>
        </div>
        <div className="flex shrink-0 rounded-full border border-border bg-muted/60 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("matrix")}
            className={cn(
              "rounded-full px-3 py-1.5 font-medium transition",
              mode === "matrix" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Matriz
          </button>
          <button
            type="button"
            onClick={() => setMode("examples")}
            className={cn(
              "rounded-full px-3 py-1.5 font-medium transition",
              mode === "examples" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Exemplos
          </button>
        </div>
      </CardHeader>
      <CardContent className="p-5">
        {mode === "matrix" ? (
          <ValidationMediaViewer
            artifact={matrixArtifacts[0]}
            variant="matrix"
            emptyText="Nenhuma matriz de confusão reportada pelo backend."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ValidationMediaViewer
              artifact={selectedExample}
              variant="example"
              emptyText="Nenhum exemplo de validação reportado pelo backend."
            />
            {exampleArtifacts.length > 1 && (
              <div className="grid grid-cols-2 gap-2">
                {exampleArtifacts.map((artifact, index) => (
                  <button
                    key={artifact.path}
                    type="button"
                    onClick={() => setExampleIndex(index)}
                    className={cn(
                      "group overflow-hidden rounded-lg border bg-background text-left transition",
                      index === exampleIndex ? "border-brand-blue ring-2 ring-brand-blue/20" : "border-border hover:border-foreground/20",
                    )}
                  >
                    <div className="aspect-video overflow-hidden bg-muted/20">
                      <img
                        src={trainingArtifactAssetUrl(artifact.runId, artifact.path)}
                        alt={artifact.label}
                        className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                      />
                    </div>
                    <div className="truncate px-2.5 py-1.5 text-xs font-medium text-foreground">
                      {artifact.label}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ValidationMediaViewer({
  artifact,
  emptyText = "Nenhuma imagem reportada pelo backend.",
  variant,
}: {
  artifact?: TrainingImageArtifact
  emptyText?: string
  variant: "matrix" | "example"
}) {
  if (!artifact) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-background">
      <div
        className={cn(
          "flex w-full items-center justify-center overflow-hidden",
          variant === "matrix" ? "aspect-[4/3] max-h-[380px] bg-white p-3" : "aspect-video bg-muted/20",
        )}
      >
        <img
          src={trainingArtifactAssetUrl(artifact.runId, artifact.path)}
          alt={artifact.label}
          className={cn("h-full w-full", variant === "matrix" ? "object-contain" : "object-cover")}
        />
      </div>
      <figcaption className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs">
        <span className="font-medium text-foreground">{artifact.label}</span>
        <span className="truncate text-muted-foreground">{artifact.name}</span>
      </figcaption>
    </figure>
  )
}

function pluralCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

function MetricsTab({ run }: { run: BackendTrainingRun }) {
  const metrics = metricRows(run.metrics)
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-0">
        <div className="divide-y divide-border">
          {metrics.map((metric) => (
            <div key={metric.key} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="text-muted-foreground">{metric.label}</span>
              <span className="font-medium tabular-nums text-foreground">{metric.value}</span>
            </div>
          ))}
          {metrics.length === 0 && (
            <p className="px-5 py-6 text-sm text-muted-foreground">Nenhuma métrica reportada ainda.</p>
          )}
        </div>
      </Card>
    </div>
  )
}

function PerClassTab({ run }: { run: BackendTrainingRun }) {
  const perClass = perClassRows(run.metrics)
  return (
    <Card className="p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-5 py-3 text-left font-medium">Classe</th>
              <th className="px-5 py-3 text-right font-medium">Instâncias</th>
              <th className="px-5 py-3 text-right font-medium">Precision</th>
              <th className="px-5 py-3 text-right font-medium">Recall</th>
              <th className="px-5 py-3 text-right font-medium">mAP@0.5:0.95</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {perClass.map((c) => (
              <tr key={c.name} className="hover:bg-muted/40">
                <td className="px-5 py-3 font-medium text-foreground">{c.name}</td>
                <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{c.instances}</td>
                <td className="px-5 py-3 text-right tabular-nums text-foreground">{c.precision}</td>
                <td className="px-5 py-3 text-right tabular-nums text-foreground">{c.recall}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="w-24"><ProgressBar value={Number(c.map) * 100} /></span>
                    <span className="tabular-nums font-medium text-foreground">{c.map}</span>
                  </div>
                </td>
              </tr>
            ))}
            {perClass.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-center text-sm text-muted-foreground">
                  Nenhuma métrica por classe reportada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ResourcesTab({ run }: { run: BackendTrainingRun }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Política de execução</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatRow label="Device" value={String(run.config.device ?? "auto")} />
          <StatRow label="Workers" value={String(run.config.workers ?? "--")} />
          <StatRow label="Batch size" value={String(run.config.batch_size ?? "--")} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Progresso reportado</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Meter label="Progresso" value={Math.round(run.progress)} color="bg-brand-indigo" />
        </CardContent>
      </Card>
    </div>
  )
}

function LogsTab({ run }: { run: BackendTrainingRun }) {
  const logs = Array.isArray(run.metrics.logs) ? run.metrics.logs : []
  const live = run.status === "queued" || run.status === "running"
  const endRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [logs.length])

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <CardTitle>Logs em tempo real</CardTitle>
        <span className={cn("flex items-center gap-1.5 text-xs", live ? "text-brand-green" : "text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", live && "animate-pulse", live ? "bg-brand-green" : "bg-muted-foreground")} />
          {live ? "Ao vivo" : "Finalizado"}
        </span>
      </div>
      <div className="max-h-[480px] overflow-auto p-4 font-mono text-xs leading-relaxed">
        {logs.map((entry, i) => {
          const row: Record<string, unknown> =
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : { msg: entry }
          return (
          <div key={i} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-muted-foreground">{String(row.t ?? row.time ?? "--")}</span>
            <span
              className={
                row.lvl === "WARN"
                  ? "shrink-0 font-medium text-warning"
                  : "shrink-0 font-medium text-brand-blue"
              }
            >
              {String(row.lvl ?? row.level ?? "INFO")}
            </span>
            <span className="text-foreground/80">{String(row.msg ?? row.message ?? entry)}</span>
          </div>
          )
        })}
        <div ref={endRef} />
        {logs.length === 0 && <p className="text-muted-foreground">Nenhum log reportado pelo backend.</p>}
      </div>
    </Card>
  )
}

function artifactsFromRun(run: BackendTrainingRun) {
  return run.artifacts.map((artifact, index) => {
    const row = artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>) : {}
    const name = String(row.name ?? row.path ?? `artifact-${index + 1}`)
    const path = String(row.path ?? name)
    return {
      name,
      path,
      desc: path || "Artefato MLflow",
      size: formatBytes(row.size_bytes),
      uri: typeof row.uri === "string" ? row.uri : null,
    }
  })
}

function formatBytes(value: unknown) {
  const bytes = typeof value === "number" && Number.isFinite(value) ? value : 0
  if (!bytes) return "--"
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function ArtifactsTab({ run }: { run: BackendTrainingRun | null }) {
  const rows = run && run.artifacts.length > 0 ? artifactsFromRun(run) : []
  return (
    <Card className="p-0">
      <div className="divide-y divide-border">
        {rows.map((a) => {
          const canDownload = Boolean(a.path)
          return (
          <div key={a.name} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted font-mono text-[10px] text-muted-foreground">
              {a.name.split(".").pop()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{a.desc}</p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{a.size}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDownload}
              onClick={() => {
                if (canDownload && run) void downloadBackendFile(trainingArtifactDownloadPath(run.id, a.path), a.name)
              }}
            >
              Baixar
            </Button>
          </div>
          )
        })}
        {rows.length === 0 && (
          <p className="px-5 py-6 text-sm text-muted-foreground">Nenhum artefato reportado pelo backend.</p>
        )}
      </div>
    </Card>
  )
}

function ConfigTab({ run }: { run: BackendTrainingRun | null }) {
  const sections = run ? configSectionsFromRun(run) : []
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 border-b border-border px-5 py-4">
        <CardTitle>Configuração completa</CardTitle>
        {run ? (
          <span className="text-xs text-muted-foreground">
            {sectionRowCount(sections)} parâmetros
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-5">
        {sections.map((section) => (
          <ParamSection key={section.title} title={section.title} rows={section.rows} />
        ))}
        {run && (
          <div className="rounded-xl border border-border bg-muted/20">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">JSON bruto</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Espelho literal do `config` salvo no backend.
              </p>
            </div>
            <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
              {JSON.stringify(run.config, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ConfigRow = { label: string; value: React.ReactNode; raw?: string }
type ConfigSection = { title: string; rows: ConfigRow[] }

function configSectionsFromRun(run: BackendTrainingRun): ConfigSection[] {
  const config = objectRecord(run.config) ?? {}
  const knownTopLevel = new Set(["split", "resource_policy", "ultralytics"])
  const directConfigRows = Object.entries(config)
    .filter(([, value]) => !isPlainObject(value) && !Array.isArray(value))
    .map(([key, value]) => configRow(key, value))

  const sections: ConfigSection[] = [
    {
      title: "Execução",
      rows: [
        configRow("training_run_id", run.id),
        configRow("status", run.status),
        configRow("progress", `${Math.round(run.progress)}%`),
        configRow("model_family", run.model_family),
        configRow("base_model", run.base_model),
        configRow("dataset_release_id", run.dataset_release_id),
        configRow("mlflow_run_id", run.mlflow_run_id),
        configRow("created_at", formatDateTimePt(run.created_at)),
        configRow("updated_at", formatDateTimePt(run.updated_at)),
      ],
    },
    { title: "Parâmetros principais", rows: directConfigRows },
  ]

  const resourceRows = configRowsFromObject(config.resource_policy)
  if (resourceRows.length) sections.push({ title: "Recursos", rows: resourceRows })

  const ultralyticsRows = configRowsFromObject(config.ultralytics)
  if (ultralyticsRows.length) sections.push({ title: "Ultralytics", rows: ultralyticsRows })

  const splitRows = configRowsFromObject(config.split)
  if (splitRows.length) sections.push({ title: "Dataset e divisão", rows: splitRows })

  const extraRows = Object.entries(config)
    .filter(([key, value]) => !knownTopLevel.has(key) && (isPlainObject(value) || Array.isArray(value)))
    .flatMap(([key, value]) => configRowsFromObject(value, key))
  if (extraRows.length) sections.push({ title: "Outros", rows: extraRows })

  return sections.filter((section) => section.rows.length)
}

function configRowsFromObject(value: unknown, prefix = ""): ConfigRow[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => configRow(`${prefix}[${index}]`, item))
  }
  if (!isPlainObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const label = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(child) || Array.isArray(child)) return configRowsFromObject(child, label)
    return [configRow(label, child)]
  })
}

function configRow(label: string, value: unknown): ConfigRow {
  const formatted = formatConfigValue(value)
  return { label: humanizeConfigKey(label), value: formatted, raw: typeof formatted === "string" ? formatted : undefined }
}

function ParamSection({ title, rows }: { title: string; rows: ConfigRow[] }) {
  return (
    <section className="rounded-xl border border-border">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <ParamRow key={`${title}-${row.label}`} row={row} />
        ))}
      </div>
    </section>
  )
}

function ParamRow({ row }: { row: ConfigRow }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 text-sm sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-4">
      <span className="text-muted-foreground">{row.label}</span>
      <span className="min-w-0 break-words font-medium tabular-nums text-foreground" title={row.raw}>
        {row.value}
      </span>
    </div>
  )
}

function sectionRowCount(sections: ConfigSection[]) {
  return sections.reduce((total, section) => total + section.rows.length, 0)
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "--"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "--"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function humanizeConfigKey(key: string) {
  const labels: Record<string, string> = {
    model_name: "Modelo",
    epochs: "Épocas",
    image_size: "Imagem (imgsz)",
    batch_size: "Batch size",
    workers: "Workers",
    device: "Device",
    seed: "Seed",
    patience: "Patience",
    optimizer: "Optimizer",
    cos_lr: "Cosine LR",
    amp: "AMP",
    resource_policy: "Resource policy",
    device_label: "Device label",
    training_run_id: "Training run",
    model_family: "Família",
    base_model: "Modelo base",
    dataset_release_id: "Dataset release",
    mlflow_run_id: "MLflow run",
    created_at: "Criado em",
    updated_at: "Atualizado em",
    dataType: "Tipo de dados",
    groupBy: "Agrupar por",
    minDistance: "Distância mínima",
    keepTracks: "Manter tracks",
    preserveGroups: "Preservar grupos",
    lockTest: "Bloquear test",
    augPreset: "Augmentation preset",
    augApplyIn: "Augmentation aplicar em",
    augMode: "Augmentation modo",
  }
  return labels[key] ?? labels[key.split(".").pop() ?? key] ?? key
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
