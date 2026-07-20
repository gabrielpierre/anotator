"use client"

import * as React from "react"
import { Pause, Square, MoreHorizontal, Settings2, ChevronRight } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, ProgressBar, StatRow, Meter } from "@/components/app/primitives"
import { TabNav } from "@/components/app/tab-nav"
import { MetricLineChart } from "@/components/app/charts"
import {
  artifactDownloadPathFromUri,
  downloadBackendFile,
  fetchTrainingRun,
  trainingRunEventsUrl,
} from "@/lib/api/client"
import { formatDateTimePt, toUiJobStatus } from "@/lib/api/status"
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

export function TrainingDetail({ id }: { id: string }) {
  const [tab, setTab] = React.useState("overview")
  const [run, setRun] = React.useState<BackendTrainingRun | null>(null)

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
    events.onerror = () => events.close()
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

  const progress = Math.round(run.progress)
  const displayKpis = kpisFromRun(run)
  const displayConfig = configFromRun(run)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Treinamento #{run.id.slice(0, 8)}</h1>
          <StatusBadge status={toUiJobStatus(run.status)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline">
            <Pause className="size-4" />
            Pausar
          </Button>
          <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10">
            <Square className="size-4" />
            Parar
          </Button>
          <Button variant="ghost" aria-label="Mais ações">
            <MoreHorizontal className="size-4" />
            Mais ações
          </Button>
        </div>
      </div>

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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
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
          <Card>
            <CardHeader>
              <CardTitle>Configuração do treinamento</CardTitle>
              <button className="flex items-center gap-1 text-xs text-brand-blue hover:underline">
                <Settings2 className="size-3.5" />
                Editar
              </button>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {displayConfig.slice(0, 9).map((c) => (
                <StatRow key={c.label} label={c.label} value={c.value} />
              ))}
              <button className="pt-3 text-xs font-medium text-brand-blue hover:underline">
                Ver todas as configurações
              </button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recursos da máquina</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <Meter label="Progresso reportado" value={progress} color="bg-brand-lavender" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Device</span>
                  <span className="tabular-nums text-foreground">{String(run.config.device ?? "auto")}</span>
                </div>
              </div>
            </CardContent>
          </Card>
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

function configFromRun(run: BackendTrainingRun) {
  return [
    { label: "Modelo base", value: run.base_model },
    { label: "Dataset", value: run.dataset_release_id },
    { label: "Épocas", value: String(numberParam(run.config, "epochs", 100)) },
    { label: "Imagem (imgsz)", value: String(numberParam(run.config, "image_size", 640)) },
    { label: "Batch size", value: String(numberParam(run.config, "batch_size", 16)) },
    { label: "Workers", value: String(numberParam(run.config, "workers", 8)) },
    { label: "Device", value: String(run.config.device ?? "auto") },
    { label: "Seed", value: String(numberParam(run.config, "seed", 42)) },
    { label: "MLflow run", value: run.mlflow_run_id ?? "--" },
  ]
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
  return Object.entries(metrics)
    .filter(([, value]) => numberValue(value) !== null)
    .map(([key, value], index) => ({
      key,
      label: key,
      value: metricText(numberValue(value)),
      color: colors[index % colors.length],
    }))
}

function chartDataFromMetrics(metrics: Record<string, unknown>) {
  const history = metrics.history
  if (Array.isArray(history)) {
    return history.filter((item): item is Record<string, number | string> => Boolean(item) && typeof item === "object")
  }
  const row: Record<string, number | string> = { epoch: numberValue(metrics.epoch) ?? 0 }
  for (const metric of metricRows(metrics)) {
    const value = numberValue(metrics[metric.key])
    if (value !== null) row[metric.key] = value
  }
  return Object.keys(row).length > 1 ? [row] : []
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

        <Card>
          <CardHeader>
            <CardTitle>Matriz de confusão (validação)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Nenhuma matriz de confusão reportada pelo backend.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
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
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <CardTitle>Logs em tempo real</CardTitle>
        <span className="flex items-center gap-1.5 text-xs text-brand-green">
          <span className="size-1.5 animate-pulse rounded-full bg-brand-green" />
          Ao vivo
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
        {logs.length === 0 && <p className="text-muted-foreground">Nenhum log reportado pelo backend.</p>}
      </div>
    </Card>
  )
}

function artifactsFromRun(run: BackendTrainingRun) {
  return run.artifacts.map((artifact, index) => {
    const row = artifact && typeof artifact === "object" ? (artifact as Record<string, unknown>) : {}
    const name = String(row.name ?? row.path ?? `artifact-${index + 1}`)
    return {
      name,
      desc: String(row.uri ?? row.path ?? "Artefato MLflow"),
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
          const uri = "uri" in a ? a.uri : null
          const canDownload = typeof uri === "string" && uri.startsWith("s3://")
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
                if (canDownload) void downloadBackendFile(artifactDownloadPathFromUri(uri), a.name)
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
  const rows = run ? configFromRun(run) : []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração completa</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <div className="divide-y divide-border">
          {rows.map((c) => (
            <StatRow key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
