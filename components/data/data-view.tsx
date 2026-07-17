"use client"

import { Upload, Search, Filter, Image as ImageIcon, Database, HardDrive } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge, ProgressBar } from "@/components/app/primitives"
import { dataBatches, classes } from "@/lib/mock-data"

const batchStatusTone: Record<string, string> = {
  Anotando: "text-brand-blue",
  "Pré-processando": "text-warning",
  Pipeline: "text-brand-indigo",
  Concluído: "text-brand-green",
}

export function DataView() {
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
            <Button>
              <Upload className="size-4" />
              Importar lote
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Imagens importadas" value="10.250" hint="+320 esta semana" tone="blue" />
        <MetricCard label="Imagens anotadas" value="8.420" hint="82% do total" tone="mint" />
        <MetricCard label="Objetos anotados" value="43.718" hint="+1.254 esta semana" tone="purple" />
        <MetricCard label="Tamanho em disco" value="128.6 GB" hint="9 lotes ativos" tone="subtle" />
      </div>

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
                {dataBatches.map((b) => (
                  <tr key={b.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        <span className="flex size-8 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
                          <ImageIcon className="size-4" />
                        </span>
                        {b.id}
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
                ))}
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
              {classes.slice(0, 8).map((c) => (
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
            </CardContent>
          </Card>

          <Card tone="blue">
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <HardDrive className="size-4 text-brand-blue" />
                Armazenamento
              </div>
              <ProgressBar value={67} color="bg-brand-blue" height="h-2" />
              <p className="text-xs text-muted-foreground">642 GB de 954 GB utilizados (67%)</p>
              <Button variant="outline" size="sm" className="mt-1 w-fit">
                <Database className="size-4" />
                Gerenciar storage
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
