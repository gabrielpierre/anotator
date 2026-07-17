"use client"

import { Boxes, Search, Upload, Download, Star, MoreHorizontal } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { Badge } from "@/components/snowui/badge"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { SparkLineChart } from "@/components/app/charts"
import { models, modelEvolution } from "@/lib/mock-data"

const familyTone: Record<string, "info" | "accent" | "neutral"> = {
  Detecção: "info",
  Classificação: "accent",
  Segmentação: "neutral",
}

export function ModelsView() {
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
        <MetricCard label="Modelos registrados" value="18" hint="3 famílias" tone="blue" />
        <MetricCard label="Modelo campeão" value="0.813" hint="YOLO11m v18 · mAP50-95" tone="mint" />
        <MetricCard label="Em produção" value="3" hint="det · cls · seg" tone="purple" />
        <MetricCard label="Tamanho total" value="1.2 GB" hint="artefatos" tone="subtle" />
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
                {models.map((m) => (
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
                        <Button variant="ghost" size="icon" aria-label="Baixar peso">
                          <Download className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label="Mais ações">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
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
              data={modelEvolution}
              dataKey="map"
              color="var(--brand-blue)"
              height={200}
              highlightLast
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Ganho de +0.38 mAP entre v10 e v18 com o crescimento do dataset.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
