"use client"

import { GitBranch, Download, Package, Check, FileJson, FileArchive, ChevronRight } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, StatusBadge } from "@/components/app/primitives"
import { releases } from "@/lib/mock-data"

const outputs = [
  { icon: FileJson, name: "Anotações (COCO)", file: "annotations_release_014.json", size: "3.2 MB" },
  { icon: FileArchive, name: "Máscaras (YOLO format)", file: "masks_release_014.zip", size: "1.8 GB" },
  { icon: FileArchive, name: "Crops para classificação", file: "crops_release_014.zip", size: "4.6 GB" },
]

export function ReleasesView() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Releases"
        subtitle="Versões imutáveis do dataset prontas para treino e exportação."
        actions={
          <Button>
            <Package className="size-4" />
            Novo release
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Releases" value="14" hint="1 em construção" tone="blue" />
        <MetricCard label="Último release" value="release_014" hint="14/07/2024" tone="mint" />
        <MetricCard label="Objetos (atual)" value="43.718" hint="8.420 imagens" tone="purple" />
        <MetricCard label="Tamanho (atual)" value="128.6 GB" hint="3 artefatos" tone="subtle" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Histórico de releases</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {releases.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4 transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
                    <GitBranch className="size-5" />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{r.id}</span>
                      <StatusBadge status={r.status as "publicado" | "em-construcao" | "arquivado"} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Criado em {r.date} · {r.images.toLocaleString("pt-BR")} imagens · {r.objects.toLocaleString("pt-BR")} objetos
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm tabular-nums text-muted-foreground">{r.size}</span>
                  <Button variant="ghost" size="icon" aria-label="Baixar release">
                    <Download className="size-4" />
                  </Button>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saídas do release_014</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {outputs.map((o) => (
              <div key={o.name} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <o.icon className="size-4" />
                  </span>
                  <div>
                    <div className="text-sm font-medium text-foreground">{o.name}</div>
                    <span className="text-xs text-muted-foreground">{o.file}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">{o.size}</span>
                  <Button variant="ghost" size="icon" aria-label={`Baixar ${o.name}`}>
                    <Download className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-green/12 px-3 py-2 text-xs text-brand-green">
              <Check className="size-4" />
              Pronto para treinar novos modelos.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
