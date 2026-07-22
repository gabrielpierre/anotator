"use client"

import * as React from "react"
import { Boxes, Search, Upload, Download, Star, MoreHorizontal, Trash2 } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { Badge } from "@/components/snowui/badge"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { MetricLineChart } from "@/components/app/charts"
import { deleteModelVersion, downloadBackendFile, fetchModelVersions, modelDownloadPath } from "@/lib/api/client"
import { formatDateTimePt } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendModelVersion } from "@/lib/api/types"

const familyTone: Record<string, "info" | "accent" | "neutral"> = {
  Detecção: "info",
  Classificação: "accent",
  Segmentação: "neutral",
  Tracking: "neutral",
}

type ModelRow = {
  id: string
  modelId?: string
  family: string
  map: string
  mapValue: number
  dataset: string
  status: "aprovado" | "publicado" | "arquivado" | "em-construcao"
  size: string
  createdAt: string
  best: boolean
  downloadable: boolean
}

function toModelRow(model: BackendModelVersion): ModelRow {
  const mapValue = bestMapFromMetrics(model.metrics)
  return {
    id: `${model.name} ${model.version}`,
    modelId: model.id,
    family: familyLabel(model.family),
    map: mapValue === null ? "--" : mapValue.toFixed(3),
    mapValue: mapValue ?? 0,
    dataset: model.dataset_release_id?.slice(0, 8) ?? "--",
    status: model.status === "registered" ? "publicado" : model.status === "archived" ? "arquivado" : "em-construcao",
    size: model.artifact_uri ? "MLflow" : "--",
    createdAt: formatDateTimePt(model.created_at),
    best: false,
    downloadable: Boolean(model.artifact_uri),
  }
}

const modelMetricOptions = [
  {
    key: "map5095",
    label: "mAP50-95",
    aliases: ["metrics/mAP50-95(B)", "map5095", "box_map", "box.map", "mAP50-95"],
    color: "var(--brand-blue)",
    domain: [0, 1] as [number, number],
  },
  {
    key: "map50",
    label: "mAP50",
    aliases: ["metrics/mAP50(B)", "map50", "box_map50", "box.map50", "mAP50"],
    color: "var(--brand-green)",
    domain: [0, 1] as [number, number],
  },
  {
    key: "precision",
    label: "Precision",
    aliases: ["metrics/precision(B)", "precision", "box_precision"],
    color: "var(--brand-lavender)",
    domain: [0, 1] as [number, number],
  },
  {
    key: "recall",
    label: "Recall",
    aliases: ["metrics/recall(B)", "recall", "box_recall"],
    color: "var(--warning)",
    domain: [0, 1] as [number, number],
  },
] as const

function familyLabel(family: string) {
  switch (family) {
    case "classification":
      return "Classificação"
    case "segmentation":
      return "Segmentação"
    case "tracking":
      return "Tracking"
    default:
      return "Detecção"
  }
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

export function ModelsView() {
  const [backendModels, setBackendModels] = React.useState<BackendModelVersion[] | null>(null)
  const [selectedMetricKey, setSelectedMetricKey] = React.useState<(typeof modelMetricOptions)[number]["key"]>("map5095")
  const [actionMenuId, setActionMenuId] = React.useState<string | null>(null)
  const [deletingModelId, setDeletingModelId] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const { activeProject, projects } = useCurrentUser()
  const currentProjectId = activeProject?.id ?? projects[0]?.id ?? null

  const loadModels = React.useCallback((signal?: AbortSignal) => {
    fetchModelVersions({ projectId: currentProjectId }, signal)
      .then(setBackendModels)
      .catch(() => setBackendModels(null))
  }, [currentProjectId])

  React.useEffect(() => {
    const controller = new AbortController()
    loadModels(controller.signal)
    return () => controller.abort()
  }, [loadModels])

  const rows = React.useMemo(
    () => (backendModels?.length ? backendModels.map(toModelRow) : []),
    [backendModels],
  )
  const best = rows.reduce<ModelRow | null>(
    (current, row) => (!current || row.mapValue > current.mapValue ? row : current),
    null,
  )
  const availableMetricOptions = modelMetricOptions.filter((option) =>
    (backendModels ?? []).some((model) => metricValue(model.metrics, option.aliases) !== null),
  )
  const selectedMetric =
    availableMetricOptions.find((option) => option.key === selectedMetricKey) ?? availableMetricOptions[0] ?? modelMetricOptions[0]
  const metricEvolution = (backendModels ?? [])
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((model) => ({
      version: compactModelLabel(model),
      value: metricValue(model.metrics, selectedMetric.aliases),
    }))
    .filter((item): item is { version: string; value: number } => item.value !== null)

  async function handleDeleteModel(row: ModelRow) {
    if (!row.modelId || deletingModelId) return
    const confirmed = window.confirm(
      `Excluir definitivamente ${row.id}? Isso remove o registro, peso/artefatos do modelo e sugestões geradas por ele.`,
    )
    if (!confirmed) return
    setDeletingModelId(row.modelId)
    setActionError(null)
    setActionMenuId(null)
    try {
      await deleteModelVersion(row.modelId)
      setBackendModels((current) => current?.filter((model) => model.id !== row.modelId) ?? [])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível excluir o modelo.")
    } finally {
      setDeletingModelId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Modelos"
        subtitle="Registro de modelos treinados, versões e artefatos exportáveis."
        actions={
          <>
            <Button variant="outline">
              <Upload className="size-4" />
              Importar peso
            </Button>
            <Button>
              <Boxes className="size-4" />
              Registrar modelo
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Modelos registrados" value={String(rows.length)} hint="registro local" tone="blue" />
        <MetricCard
          label="Modelo campeão"
          value={best ? best.map : "--"}
          hint={best ? `${best.id} · mAP50-95` : "sem métricas"}
          tone="mint"
        />
        <MetricCard
          label="Registrados"
          value={String(rows.filter((row) => row.status === "publicado" || row.status === "aprovado").length)}
          hint="MLflow + banco"
          tone="purple"
        />
        <MetricCard label="Artefatos disponíveis" value={String(rows.filter((row) => row.downloadable).length)} hint="downloads reais" tone="subtle" />
      </div>
      {actionError && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Registro de modelos</CardTitle>
            <Input placeholder="Buscar modelo..." aria-label="Buscar modelo" icon={<Search />} className="w-48" />
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">Modelo</th>
                  <th className="px-5 py-3 font-medium">Família</th>
                  <th className="px-5 py-3 font-medium">mAP</th>
                  <th className="px-5 py-3 font-medium">Dataset</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium sr-only">Ações</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        {m.best && <Star className="size-4 fill-warning text-warning" />}
                        {m.id}
                      </div>
                      <span className="text-xs text-muted-foreground">{m.size} · {m.createdAt}</span>
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={familyTone[m.family] ?? "neutral"}>{m.family}</Badge>
                    </td>
                    <td className="px-5 py-3 font-medium tabular-nums text-foreground">{m.map}</td>
                    <td className="px-5 py-3 text-muted-foreground">{m.dataset}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Baixar peso"
                          disabled={!m.modelId || !m.downloadable}
                          onClick={() => {
                            if (m.modelId) void downloadBackendFile(modelDownloadPath(m.modelId), `${m.id}.pt`)
                          }}
                        >
                          <Download className="size-4" />
                        </Button>
	                        <div className="relative">
	                          <Button
	                            variant="ghost"
	                            size="icon"
	                            aria-label={`Mais ações de ${m.id}`}
	                            aria-expanded={actionMenuId === m.modelId}
	                            onClick={() => setActionMenuId((current) => (current === m.modelId ? null : (m.modelId ?? null)))}
	                          >
	                            <MoreHorizontal className="size-4" />
	                          </Button>
	                          {m.modelId && actionMenuId === m.modelId && (
	                            <div className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-border bg-card p-1 text-left shadow-lg">
	                              <button
	                                type="button"
	                                disabled={deletingModelId !== null}
	                                onClick={() => void handleDeleteModel(m)}
	                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
	                              >
	                                <Trash2 className="size-4" />
	                                {deletingModelId === m.modelId ? "Excluindo..." : "Excluir modelo"}
	                              </button>
	                            </div>
	                          )}
	                        </div>
	                      </div>
	                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-center text-sm text-muted-foreground">
                      Nenhum modelo registrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

	        <Card>
	          <CardHeader>
	            <CardTitle>Evolução</CardTitle>
	            <select
	              value={selectedMetric.key}
	              onChange={(event) => setSelectedMetricKey(event.target.value as typeof selectedMetricKey)}
	              className="h-9 rounded-full border border-border bg-background px-3 text-sm font-medium text-foreground outline-none hover:bg-muted focus:border-brand-blue"
	              aria-label="Selecionar métrica do gráfico"
	            >
	              {(availableMetricOptions.length ? availableMetricOptions : modelMetricOptions).map((option) => (
	                <option key={option.key} value={option.key}>
	                  {option.label}
	                </option>
	              ))}
	            </select>
	          </CardHeader>
	          <CardContent className="flex flex-col gap-4">
	            {metricEvolution.length > 0 ? (
	              <>
	                <MetricLineChart
	                  data={metricEvolution}
	                  xKey="version"
	                  series={[{ key: "value", label: selectedMetric.label, color: selectedMetric.color }]}
	                  domain={selectedMetric.domain}
	                  height={220}
	                />
	                <div className="grid grid-cols-2 gap-2 text-xs">
	                  <MetricSummary label="Atual" value={metricEvolution.at(-1)?.value ?? null} />
	                  <MetricSummary label="Melhor" value={Math.max(...metricEvolution.map((item) => item.value))} />
	                </div>
	              </>
	            ) : (
	              <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
	                Nenhuma métrica disponível para montar o gráfico.
	              </div>
	            )}
	            <p className="text-xs text-muted-foreground">
	              Cada ponto representa uma versão registrada, em ordem de criação.
	            </p>
	          </CardContent>
	        </Card>
      </div>
    </div>
	)
}

function MetricSummary({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl bg-surface-subtle px-3 py-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">
        {value === null ? "--" : value.toFixed(3)}
      </p>
    </div>
  )
}

function metricValue(metrics: Record<string, unknown>, aliases: readonly string[]) {
  for (const key of aliases) {
    const value = metrics[key]
    const parsed = numberFromUnknown(value)
    if (parsed !== null) return parsed
  }
  return null
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function compactModelLabel(model: BackendModelVersion) {
  const version = model.version.length > 12 ? `${model.version.slice(0, 8)}...` : model.version
  return `${model.name} ${version}`
}
