"use client"

import * as React from "react"
import { Boxes, Search, Upload, Download, Star, MoreHorizontal } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { Badge } from "@/components/snowui/badge"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { SparkLineChart } from "@/components/app/charts"
import { downloadBackendFile, fetchModelVersions, modelDownloadPath } from "@/lib/api/client"
import { formatDateTimePt } from "@/lib/api/status"
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

  React.useEffect(() => {
    const controller = new AbortController()
    fetchModelVersions(controller.signal)
      .then(setBackendModels)
      .catch(() => setBackendModels(null))
    return () => controller.abort()
  }, [])

  const rows = React.useMemo(
    () => (backendModels?.length ? backendModels.map(toModelRow) : []),
    [backendModels],
  )
  const best = rows.reduce<ModelRow | null>(
    (current, row) => (!current || row.mapValue > current.mapValue ? row : current),
    null,
  )
  const mapEvolution = rows
    .filter((row) => row.mapValue > 0)
    .map((row) => ({ version: row.id, map: row.mapValue }))

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
                        <Button variant="ghost" size="icon" aria-label="Mais ações">
                          <MoreHorizontal className="size-4" />
                        </Button>
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
            <CardTitle>Evolução do mAP50-95</CardTitle>
          </CardHeader>
          <CardContent>
            <SparkLineChart
              data={mapEvolution}
              dataKey="map"
              color="var(--brand-blue)"
              height={200}
              highlightLast
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Evolução calculada a partir das métricas registradas no backend.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
