"use client"

import * as React from "react"
import Link from "next/link"
import {
  Sliders,
  Plus,
  FolderOpen,
  HardDrive,
  X,
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
import { classes, modelEvolution, project } from "@/lib/mock-data"
import { createProject, fetchDashboard, fetchTasks, mockFallbackEnabled } from "@/lib/api/client"
import { formatPtNumber, labelsFromTasks } from "@/lib/api/status"
import type { BackendDashboard, BackendProject, BackendTask } from "@/lib/api/types"

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

const quotaPresets = [30, 40, 60, 100]

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name: string }>
}

export function ProjectOverview() {
  const [dashboard, setDashboard] = React.useState<BackendDashboard | null>(null)
  const [tasks, setTasks] = React.useState<BackendTask[] | null>(null)
  const [projectModalOpen, setProjectModalOpen] = React.useState(false)
  const useMocks = mockFallbackEnabled()

  React.useEffect(() => {
    const controller = new AbortController()
    fetchDashboard("default", controller.signal).then(setDashboard).catch(() => setDashboard(null))
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    return () => controller.abort()
  }, [])

  const overviewKpis = dashboard
    ? [
        {
          ...kpis[0],
          value: formatPtNumber(dashboard.stats.images),
          sub: `${dashboard.stats.tasks} tasks sincronizadas`,
        },
        {
          ...kpis[1],
          value: formatPtNumber(dashboard.stats.images || (useMocks ? project.imagesAnnotated : 0)),
          sub: "Sincronizado do CVAT",
          bar: dashboard.stats.images > 0 ? 100 : useMocks ? kpis[1].bar : 0,
        },
        {
          ...kpis[2],
          value: formatPtNumber(
            dashboard.class_distribution.reduce((total, item) => total + item.count, 0) ||
              (useMocks ? project.objectsAnnotated : 0),
          ),
          sub: "Labels/classes conhecidas",
        },
        {
          ...kpis[3],
          value: formatPtNumber(dashboard.stats.pending_review),
          sub: `${dashboard.stats.jobs_running} jobs ativos`,
        },
      ]
    : useMocks
      ? kpis
      : kpis.map((kpi) => ({ ...kpi, value: "0", sub: "Aguardando backend", bar: 0 }))

  const taskClasses = labelsFromTasks(tasks)
  const classItems =
    dashboard?.class_distribution && dashboard.class_distribution.length > 0
      ? dashboard.class_distribution.map((item, index) => ({
          name: item.name,
          count: item.count,
          share: item.share,
          color: classes[index % classes.length]?.color ?? "var(--brand-blue)",
        }))
      : taskClasses.length > 0
        ? taskClasses.map((item) => ({
            name: item.name,
            count: item.count ?? 1,
            share: Math.round((100 / taskClasses.length) * 100) / 100,
            color: item.color,
          }))
      : useMocks
        ? classes
        : []

  const activityItems = useMocks ? activities : []
  const attentionItems = useMocks ? attentions : []
  const modelEvolutionItems = useMocks ? modelEvolution : []
  const currentProjectStorage = storageFromProject(dashboard?.project ?? null)

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
          <Button size="lg" onClick={() => setProjectModalOpen(true)}>
            <Plus className="size-4" />
            Novo projeto
          </Button>
        </div>
      </div>
      <NewProjectDialog
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onCreated={(project) => {
          setDashboard((current) =>
            current
              ? {
                  ...current,
                  project,
                  stats: { ...current.stats, projects: current.stats.projects + 1 },
                }
              : {
                  project,
                  stats: {
                    projects: 1,
                    tasks: 0,
                    images: 0,
                    jobs_running: 0,
                    pending_review: 0,
                    dataset_releases: 0,
                    training_runs: 0,
                  },
                  class_distribution: [],
                  recent_jobs: [],
                },
          )
        }}
      />

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

        {overviewKpis.map((kpi) => (
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
      {currentProjectStorage && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
                <HardDrive className="size-5" />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">Storage do projeto</p>
                <p className="text-xs text-muted-foreground">{currentProjectStorage.path}</p>
              </div>
            </div>
            <div className="flex min-w-48 flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Uso</span>
                <span className="font-medium tabular-nums text-foreground">
                  {currentProjectStorage.usedGb.toFixed(1)} / {currentProjectStorage.quotaGb} GB
                </span>
              </div>
              <ProgressBar value={currentProjectStorage.percent} color="bg-brand-blue" />
            </div>
          </CardContent>
        </Card>
      )}

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
              <SparkLineChart data={modelEvolutionItems} dataKey="map" color="var(--brand-blue)" highlightLast />
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
              data={modelEvolutionItems}
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
              <DonutChart data={classItems.map((c) => ({ label: c.name, value: c.count, color: c.color }))} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-semibold tabular-nums">
                  {formatPtNumber(classItems.reduce((total, item) => total + item.count, 0))}
                </span>
                <span className="text-xs text-muted-foreground">objetos</span>
              </div>
            </div>
            <ul className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
              {classItems.slice(0, 6).map((c) => (
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
            {activityItems.map((a) => (
              <div key={a.title} className="flex items-center gap-3 rounded-lg py-2">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                  <a.icon />
                </span>
                <span className="flex-1 truncate text-sm">{a.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.time}</span>
              </div>
            ))}
            {activityItems.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhuma atividade recente sincronizada.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Attention */}
      <Card tone="subtle">
        <CardHeader>
          <CardTitle>Atenções requeridas</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {attentionItems.map((a) => (
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
          {attentionItems.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum alerta operacional sincronizado.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (project: BackendProject) => void
}) {
  const [name, setName] = React.useState("")
  const [storagePath, setStoragePath] = React.useState("")
  const [quotaGb, setQuotaGb] = React.useState(40)
  const [customQuota, setCustomQuota] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  async function chooseFolder() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (picker) {
      const handle = await picker()
      setStoragePath((current) => current || handle.name)
      return
    }
    setError("Seu navegador nao expoe o caminho da pasta. Informe o caminho manualmente.")
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const resolvedQuota = Number(customQuota || quotaGb)
    if (!name.trim() || !storagePath.trim() || !Number.isFinite(resolvedQuota) || resolvedQuota <= 0) {
      setError("Preencha nome, pasta e limite de storage.")
      return
    }
    setCreating(true)
    setError(null)
    try {
      const project = await createProject({
        name: name.trim(),
        storage_path: storagePath.trim(),
        storage_quota_gb: Math.round(resolvedQuota),
        warn_at_percent: 85,
      })
      onCreated(project)
      setName("")
      setStoragePath("")
      setQuotaGb(40)
      setCustomQuota("")
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar projeto.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Novo projeto" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form onSubmit={submit} className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Novo projeto</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Defina onde o dataset sera armazenado e o limite maximo de crescimento.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Nome</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Veiculos - Rodovia 2026"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Pasta do projeto</span>
            <div className="flex gap-2">
              <input
                value={storagePath}
                onChange={(event) => setStoragePath(event.target.value)}
                placeholder="Ex.: D:\\datasets\\rodovia-2026"
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
              />
              <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
                <FolderOpen className="size-4" />
                Escolher
              </Button>
            </div>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Limite de storage</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {quotaPresets.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setQuotaGb(value)
                    setCustomQuota("")
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    !customQuota && quotaGb === value
                      ? "border-brand-blue bg-surface-blue text-brand-blue"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {value} GB
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input
                value={customQuota}
                onChange={(event) => setCustomQuota(event.target.value)}
                inputMode="numeric"
                placeholder="Outro valor"
                className="h-10 w-36 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
              />
              <span className="text-sm text-muted-foreground">GB</span>
            </label>
          </div>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={creating}>
            {creating ? "Criando..." : "Criar projeto"}
          </Button>
        </div>
      </form>
    </div>
  )
}

function storageFromProject(project: BackendProject | null) {
  const storage = project?.raw?.storage
  if (!storage || typeof storage !== "object") return null
  const data = storage as Record<string, unknown>
  const quotaGb = numberFromUnknown(data.quota_gb)
  if (!quotaGb) return null
  const usedBytes = numberFromUnknown(data.used_bytes) ?? 0
  const usedGb = usedBytes / 1024 ** 3
  return {
    path: String(data.path ?? "--"),
    quotaGb,
    usedGb,
    percent: Math.min(100, Math.round((usedGb / quotaGb) * 100)),
  }
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
