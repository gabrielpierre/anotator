"use client"

import Link from "next/link"
import {
  Sliders,
  Plus,
  ImageIcon,
  PenLine,
  Box,
  Clock,
  ArrowRight,
  AlertCircle,
  TriangleAlert,
  Info,
  Boxes,
  ChevronRight,
  FileClock,
  GitCommitVertical,
  Camera,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/snowui/badge"
import { DonutChart } from "@/components/snowui/charts"
import { MetricLineChart, SparkLineChart } from "@/components/app/charts"
import { StatusBadge, ProgressBar } from "@/components/app/primitives"
import { classes, modelEvolution } from "@/lib/mock-data"

const kpis = [
  { label: "Imagens importadas", value: "10.250", sub: "+320 esta semana", subTone: "text-brand-green", icon: ImageIcon, tone: "bg-surface-blue text-brand-blue" },
  { label: "Imagens anotadas", value: "8.420", sub: "82% do total", subTone: "text-muted-foreground", icon: PenLine, tone: "bg-surface-mint text-brand-mint", bar: 82 },
  { label: "Objetos anotados", value: "43.718", sub: "+1.254 esta semana", subTone: "text-brand-green", icon: Box, tone: "bg-surface-purple text-brand-lavender" },
  { label: "Anotações pendentes", value: "93", sub: "0,9% do total", subTone: "text-muted-foreground", icon: Clock, tone: "bg-warning/15 text-warning", valueTone: "text-warning" },
]

const activities = [
  { icon: Boxes, title: "Treinamento #18 iniciado", time: "há 18 min" },
  { icon: GitCommitVertical, title: "Dataset release_014 criado", time: "há 45 min" },
  { icon: FileClock, title: "93 anotações movidas para revisão", time: "há 1 h" },
  { icon: GitCommitVertical, title: "Pipeline det→cls→seg concluído", time: "há 2 h" },
  { icon: Camera, title: "Exportação COCO iniciada", time: "há 2 h" },
]

const attentions = [
  { icon: AlertCircle, tone: "bg-warning/15 text-warning", title: "93 anotações", desc: "Precisam ser revisadas", href: "/revisar" },
  { icon: TriangleAlert, tone: "bg-destructive/12 text-destructive", title: "2 jobs falharam", desc: "Ver detalhes", href: "/jobs" },
  { icon: Info, tone: "bg-surface-blue text-brand-blue", title: "Classe rara", desc: "\"traffic light\" com baixa cobertura", href: "/dados" },
  { icon: Info, tone: "bg-surface-mint text-brand-mint", title: "Backup recomendado", desc: "Último backup há 3 dias", href: "/dados" },
]

export function ProjectOverview() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Visão geral do projeto</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            Resumo do estado atual e próximos passos recomendados.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="lg">
            <Sliders className="size-4" />
            Personalizar
          </Button>
          <Button size="lg">
            <Plus className="size-4" />
            Novo projeto
          </Button>
        </div>
      </div>

      {/* Recommended action + KPIs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-6">
        <Card tone="subtle" className="flex flex-col justify-between gap-6 lg:col-span-2 xl:col-span-2">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-warning">
              <AlertCircle className="size-4" />
              <span className="text-sm font-medium">Próxima ação recomendada</span>
            </div>
            <p className="text-lg font-medium leading-snug text-balance">
              Revisar 93 anotações classificadas como possíveis erros.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" nativeButton={false} render={<Link href="/revisar" />}>
              Continuar revisão
              <ArrowRight className="size-4" />
            </Button>
            <Button variant="outline" size="lg" nativeButton={false} render={<Link href="/revisar" />}>
              Ver fila de revisão
            </Button>
          </div>
        </Card>

        {kpis.map((kpi) => (
          <Card key={kpi.label} className="flex flex-col gap-3 xl:col-span-1">
            <div className="flex items-start justify-between">
              <span className="text-xs font-medium text-muted-foreground text-pretty">{kpi.label}</span>
              <span className={`inline-flex size-7 items-center justify-center rounded-lg ${kpi.tone} [&_svg]:size-4`}>
                <kpi.icon />
              </span>
            </div>
            <span className={`text-3xl font-semibold tracking-tight tabular-nums ${kpi.valueTone ?? ""}`}>
              {kpi.value}
            </span>
            {kpi.bar != null && <ProgressBar value={kpi.bar} color="bg-brand-green" />}
            <span className={`text-xs font-medium ${kpi.subTone}`}>{kpi.sub}</span>
          </Card>
        ))}
      </div>

      {/* Model / trainings / release */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Modelo atual</CardTitle>
              <Badge variant="info">Melhor</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <p className="text-xl font-semibold tracking-tight">YOLO11m v18</p>
              <p className="text-xs text-muted-foreground">mAP50-95</p>
              <p className="text-3xl font-semibold tabular-nums">0,83</p>
            </div>
            <div className="-mx-2">
              <SparkLineChart data={modelEvolution} dataKey="map" color="var(--brand-blue)" highlightLast />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Dataset: release_014</span>
              <StatusBadge status="aprovado" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Treinamentos ativos</CardTitle>
              <Badge variant="info">1</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Link href="/treinar/18" className="flex flex-col gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-muted">
              <div className="flex items-center justify-between">
                <span className="font-medium">Treinamento #18</span>
                <StatusBadge status="executando" />
              </div>
              <p className="text-xs text-muted-foreground">YOLO11m · release_014</p>
              <ProgressBar value={37} color="bg-brand-green" />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Época 37/100</span>
                <span>ETA 00:32:18</span>
              </div>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Último dataset release</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <p className="text-xl font-semibold tracking-tight">release_014</p>
              <p className="text-xs text-muted-foreground">Criado em 14/07/2024 09:30</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["Imagens", "8.420"],
                ["Objetos", "43.718"],
                ["Tamanho", "128.6 GB"],
              ].map(([l, v]) => (
                <div key={l} className="rounded-lg bg-muted p-2">
                  <p className="text-sm font-semibold tabular-nums">{v}</p>
                  <p className="text-xs text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
            <Button variant="outline" className="w-full" nativeButton={false} render={<Link href="/releases" />}>
              Ver detalhes do release
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Evolution / distribution / activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1 xl:col-span-1">
          <CardHeader>
            <CardTitle>Evolução do modelo</CardTitle>
            <span className="rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">mAP50-95</span>
          </CardHeader>
          <CardContent className="min-w-0">
            <MetricLineChart
              data={modelEvolution}
              xKey="version"
              height={220}
              series={[{ key: "map", label: "mAP50-95", color: "var(--brand-blue)" }]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Distribuição por classe (objetos)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <div className="relative w-44 max-w-full">
              <DonutChart data={classes.map((c) => ({ label: c.name, value: c.count, color: c.color }))} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-semibold tabular-nums">43.718</span>
                <span className="text-xs text-muted-foreground">objetos</span>
              </div>
            </div>
            <ul className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
              {classes.slice(0, 6).map((c) => (
                <li key={c.name} className="flex items-center gap-2 whitespace-nowrap">
                  <span className="flex items-center gap-2 text-foreground">
                    <span className="size-2 rounded-full" style={{ background: c.color }} />
                    {c.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{c.share}%</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Atividades recentes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {activities.map((a) => (
              <div key={a.title} className="flex items-center gap-3 rounded-lg py-2">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                  <a.icon />
                </span>
                <span className="flex-1 truncate text-sm">{a.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.time}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Attention */}
      <Card tone="subtle">
        <CardHeader>
          <CardTitle>Atenções requeridas</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {attentions.map((a) => (
            <Link
              key={a.title}
              href={a.href}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted"
            >
              <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg ${a.tone} [&_svg]:size-4.5`}>
                <a.icon />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{a.title}</span>
                <span className="truncate text-xs text-muted-foreground">{a.desc}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
