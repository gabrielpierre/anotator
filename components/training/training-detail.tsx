"use client"

import * as React from "react"
import Image from "next/image"
import { Pause, Square, MoreHorizontal, Settings2, ChevronRight } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, ProgressBar, StatRow, Meter } from "@/components/app/primitives"
import { TabNav } from "@/components/app/tab-nav"
import { MetricLineChart, SparkLineChart } from "@/components/app/charts"
import { DonutChart } from "@/components/snowui/charts"
import { ConfusionMatrix } from "@/components/training/confusion-matrix"
import {
  trainingCurves,
  trainingMetrics,
  machineResources,
  classes,
} from "@/lib/mock-data"

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

const kpis = [
  { label: "Modelo base", value: "YOLO11m" },
  { label: "Dataset", value: "release_014" },
  { label: "Iniciado em", value: "14/07/2024 10:32" },
  { label: "Tempo decorrido", value: "00:18:42" },
  { label: "Época", value: "37 / 100" },
  { label: "ETA", value: "00:32:18" },
]

const sizeDist = [
  { label: "Pequeno (0 - 32²)", value: 18.7, color: "var(--brand-blue)" },
  { label: "Médio (32² - 96²)", value: 41.2, color: "var(--brand-green)" },
  { label: "Grande (> 96²)", value: 40.1, color: "var(--warning)" },
]

const examples = [
  { src: "/crop-car.png", label: "car", conf: "0.94" },
  { src: "/crop-truck.png", label: "truck", conf: "0.88" },
  { src: "/crop-motorcycle.png", label: "motorcycle", conf: "0.77" },
]

const config = [
  { label: "Modelo base", value: "YOLO11m" },
  { label: "Dataset", value: "release_014" },
  { label: "Épocas", value: "100" },
  { label: "Imagem (imgsz)", value: "640" },
  { label: "Batch size", value: "16" },
  { label: "Optimizer", value: "AdamW" },
  { label: "LR inicial", value: "0.001" },
  { label: "Augmentação", value: "Ativada (padrão YOLO)" },
  { label: "Peso de decaimento", value: "0.0005" },
  { label: "Warmup", value: "3 épocas" },
  { label: "Early stopping", value: "Desativado" },
]

const additionalInfo = [
  { label: "Versão do código", value: "v1.6.2 (7b2d99a)" },
  { label: "Versão do framework", value: "Ultralytics 8.2.28" },
  { label: "Dispositivo", value: "2x GPU" },
  { label: "Cache", value: "Habilitado" },
  { label: "AMP (FP16)", value: "Habilitado" },
  { label: "Workers", value: "8" },
]

export function TrainingDetail({ id }: { id: string }) {
  const [tab, setTab] = React.useState("overview")

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Treinamento #{id}</h1>
          <StatusBadge status="executando" />
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
          {kpis.map((k) => (
            <div key={k.label} className="flex flex-col gap-1 p-4">
              <span className="text-xs text-muted-foreground">{k.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{k.value}</span>
            </div>
          ))}
          <div className="col-span-2 flex flex-col justify-center gap-2 p-4 sm:col-span-3 lg:col-span-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Progresso geral</span>
              <span className="font-semibold tabular-nums text-foreground">37%</span>
            </div>
            <ProgressBar value={37} color="bg-brand-green" />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main column */}
        <div className="flex min-w-0 flex-col gap-6">
          <TabNav tabs={TABS} value={tab} onChange={setTab} />

          {tab === "overview" && <OverviewTab />}
          {tab === "metrics" && <MetricsTab />}
          {tab === "per-class" && <PerClassTab />}
          {tab === "resources" && <ResourcesTab />}
          {tab === "logs" && <LogsTab />}
          {tab === "artifacts" && <ArtifactsTab />}
          {tab === "config" && <ConfigTab />}
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
              {config.slice(0, 9).map((c) => (
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
              {machineResources.gpus.map((gpu) => (
                <div key={gpu.name} className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">{gpu.name}</span>
                  <Meter label="Utilização" value={gpu.util} color="bg-brand-blue" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Memória</span>
                    <span className="tabular-nums text-foreground">{gpu.mem}</span>
                  </div>
                </div>
              ))}
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <Meter label="CPU" value={machineResources.cpu.util} color="bg-brand-lavender" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Memória RAM</span>
                  <span className="tabular-nums text-foreground">{machineResources.cpu.mem}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Informações adicionais</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {additionalInfo.map((c) => (
                <StatRow key={c.label} label={c.label} value={c.value} />
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function OverviewTab() {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Métricas em tempo real</CardTitle>
          <span className="text-xs text-muted-foreground">Época 37 / 100</span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div>
            <div className="mb-3 flex flex-wrap gap-4">
              {chartSeries.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
            <MetricLineChart data={trainingCurves} series={chartSeries} referenceX={37} />
          </div>
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border pb-2 text-xs text-muted-foreground">
              <span>Métrica</span>
              <span className="text-right">Atual</span>
              <span className="text-right">Melhor</span>
            </div>
            <div className="divide-y divide-border">
              {trainingMetrics.map((m) => (
                <div key={m.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ backgroundColor: m.color }} />
                    {m.label}
                  </span>
                  <span className="text-right tabular-nums text-foreground">{m.atual.toFixed(3)}</span>
                  <span className="text-right tabular-nums">
                    <span className="font-medium text-brand-green">{m.melhor.toFixed(3)}</span>
                    <span className="ml-1 text-xs text-muted-foreground">ép. {m.epoca}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
              <span>Melhor época: <span className="font-medium text-foreground">33</span></span>
              <span>Early stopping: desativado</span>
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
            <Meter label="Época atual (37 / 100)" value={37} color="bg-brand-green" />
            <div className="divide-y divide-border">
              <StatRow label="Iteração" value="11.840 / 31.900" />
              <StatRow label="Tamanho do dataset" value="43.718 objetos (8.420 imgs)" />
              <StatRow label="Tamanho do batch" value="16" />
              <StatRow label="Taxa de aprendizado atual" value="0.000432" />
              <StatRow label="Próximo ajuste de LR" value="Época 40" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Matriz de confusão (validação)</CardTitle>
          </CardHeader>
          <CardContent>
            <ConfusionMatrix />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>mAP@0.5:0.95 (validação)</CardTitle>
          </CardHeader>
          <CardContent>
            <SparkLineChart data={trainingCurves} dataKey="map5095" color="var(--brand-blue)" height={140} highlightLast />
            <p className="mt-2 text-center text-sm font-medium tabular-nums text-foreground">0.742</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Distribuição de tamanhos</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <div className="w-28 shrink-0">
              <DonutChart data={sizeDist} height={120} />
            </div>
            <ul className="flex flex-col gap-2 text-xs">
              {sizeDist.map((s) => (
                <li key={s.label} className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="ml-auto tabular-nums font-medium text-foreground">{s.value}%</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Exemplos (época atual)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2">
              {examples.map((ex) => (
                <div key={ex.label} className="relative overflow-hidden rounded-lg border border-border">
                  <Image
                    src={ex.src || "/placeholder.svg"}
                    alt={`Predição: ${ex.label}`}
                    width={120}
                    height={120}
                    className="aspect-square w-full object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded bg-brand-blue px-1 text-[10px] font-medium text-white">
                    {ex.label} {ex.conf}
                  </span>
                </div>
              ))}
            </div>
            <button className="flex items-center justify-center gap-1 text-xs font-medium text-brand-blue hover:underline">
              Ver mais exemplos
              <ChevronRight className="size-3.5" />
            </button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function MetricsTab() {
  return (
    <div className="flex flex-col gap-6">
      {chartSeries.map((s) => (
        <Card key={s.key}>
          <CardHeader>
            <CardTitle>{s.label}</CardTitle>
            <span className="text-xs text-muted-foreground">por época</span>
          </CardHeader>
          <CardContent>
            <MetricLineChart
              data={trainingCurves}
              series={[s]}
              height={200}
              domain={s.key === "loss" ? [0, 1] : [0, 1]}
              referenceX={37}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function PerClassTab() {
  const perClass = classes.slice(0, 8).map((c, i) => ({
    name: c.name,
    map: (0.9 - i * 0.06).toFixed(3),
    precision: (0.92 - i * 0.05).toFixed(3),
    recall: (0.88 - i * 0.055).toFixed(3),
    instances: c.count,
  }))
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
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ResourcesTab() {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {machineResources.gpus.map((gpu) => (
        <Card key={gpu.name}>
          <CardHeader>
            <CardTitle>{gpu.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Meter label="Utilização" value={gpu.util} color="bg-brand-blue" />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Memória</span>
              <span className="tabular-nums text-foreground">{gpu.mem}</span>
            </div>
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>CPU</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Meter label="Utilização" value={machineResources.cpu.util} color="bg-brand-lavender" />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Memória RAM</span>
            <span className="tabular-nums text-foreground">{machineResources.cpu.mem}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Disco (SSD)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Meter label="Utilização" value={machineResources.disk.util} color="bg-brand-indigo" />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Espaço</span>
            <span className="tabular-nums text-foreground">{machineResources.disk.label}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const logLines = [
  { t: "10:32:01", lvl: "INFO", msg: "Iniciando treinamento — YOLO11m, dataset release_014" },
  { t: "10:32:03", lvl: "INFO", msg: "Dispositivos: 2x NVIDIA RTX 4090 (AMP FP16 habilitado)" },
  { t: "10:32:08", lvl: "INFO", msg: "Dataset carregado: 8.420 imagens / 43.718 objetos" },
  { t: "10:34:12", lvl: "INFO", msg: "Época 1/100 — loss 0.892 | mAP@0.5 0.421" },
  { t: "10:41:55", lvl: "WARN", msg: "Classe 'traffic light' com baixa cobertura (45 instâncias)" },
  { t: "10:50:33", lvl: "INFO", msg: "Época 33/100 — melhor mAP@0.5 0.925 (checkpoint salvo)" },
  { t: "10:50:42", lvl: "INFO", msg: "Época 37/100 — loss 0.148 | mAP@0.5 0.912" },
]

function LogsTab() {
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
        {logLines.map((l, i) => (
          <div key={i} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-muted-foreground">{l.t}</span>
            <span
              className={
                l.lvl === "WARN"
                  ? "shrink-0 font-medium text-warning"
                  : "shrink-0 font-medium text-brand-blue"
              }
            >
              {l.lvl}
            </span>
            <span className="text-foreground/80">{l.msg}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

const artifacts = [
  { name: "best.pt", desc: "Melhor checkpoint (época 33)", size: "42.6 MB" },
  { name: "last.pt", desc: "Último checkpoint (época 37)", size: "42.6 MB" },
  { name: "results.csv", desc: "Métricas por época", size: "128 KB" },
  { name: "confusion_matrix.png", desc: "Matriz de confusão", size: "312 KB" },
  { name: "args.yaml", desc: "Configuração do treino", size: "4 KB" },
]

function ArtifactsTab() {
  return (
    <Card className="p-0">
      <div className="divide-y divide-border">
        {artifacts.map((a) => (
          <div key={a.name} className="flex items-center gap-3 px-5 py-3.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted font-mono text-[10px] text-muted-foreground">
              {a.name.split(".").pop()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{a.name}</p>
              <p className="truncate text-xs text-muted-foreground">{a.desc}</p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{a.size}</span>
            <Button variant="ghost" size="sm">Baixar</Button>
          </div>
        ))}
      </div>
    </Card>
  )
}

function ConfigTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração completa</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        <div className="divide-y divide-border">
          {config.map((c) => (
            <StatRow key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
        <div className="divide-y divide-border">
          {additionalInfo.map((c) => (
            <StatRow key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
