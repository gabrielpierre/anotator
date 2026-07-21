"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Sliders,
  Upload,
  HardDrive,
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
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/snowui/badge"
import { DonutChart } from "@/components/snowui/charts"
import { MetricLineChart, SparkLineChart } from "@/components/app/charts"
import { StatusBadge, ProgressBar } from "@/components/app/primitives"
import { ImportBatchDialog } from "@/components/data/import-batch-dialog"
import { ProjectDialog, type ProjectDialogTarget } from "@/components/projects/project-dialog"
import {
  fetchAuditEvents,
  fetchDashboard,
  fetchDatasetReleases,
  fetchJobs,
  fetchModelVersions,
  fetchTasks,
  fetchTrainingRuns,
} from "@/lib/api/client"
import { formatDateTimePt, formatPtNumber, labelsFromTasks, toUiJobStatus } from "@/lib/api/status"
import { projectRecordFromBackend, useCurrentUser } from "@/lib/auth/user-context"
import type {
  BackendAuditEvent,
  BackendDashboard,
  BackendDatasetRelease,
  BackendJob,
  BackendModelVersion,
  BackendProject,
  BackendTask,
  BackendTrainingRun,
} from "@/lib/api/types"

const kpiMeta = [
  { label: "Imagens importadas", subTone: "text-brand-green", icon: ImageIcon, tone: "bg-surface-blue text-brand-blue" },
  { label: "Imagens anotadas", subTone: "text-muted-foreground", icon: PenLine, tone: "bg-surface-mint text-brand-mint" },
  { label: "Objetos anotados", subTone: "text-brand-green", icon: Box, tone: "bg-surface-purple text-brand-lavender" },
  { label: "Anotações pendentes", subTone: "text-muted-foreground", icon: Clock, tone: "bg-warning/15 text-warning", valueTone: "text-warning" },
]

const classColors = [
  "var(--brand-blue)",
  "var(--brand-green)",
  "var(--brand-lavender)",
  "var(--warning)",
  "var(--brand-indigo)",
  "var(--brand-sky)",
]

export function ProjectOverview() {
  const router = useRouter()
  const [dashboard, setDashboard] = React.useState<BackendDashboard | null>(null)
  const [tasks, setTasks] = React.useState<BackendTask[] | null>(null)
  const [releases, setReleases] = React.useState<BackendDatasetRelease[]>([])
  const [trainingRuns, setTrainingRuns] = React.useState<BackendTrainingRun[]>([])
  const [models, setModels] = React.useState<BackendModelVersion[]>([])
  const [jobs, setJobs] = React.useState<BackendJob[]>([])
  const [auditEvents, setAuditEvents] = React.useState<BackendAuditEvent[]>([])
  const [importDialogOpen, setImportDialogOpen] = React.useState(false)
  const [customizeOpen, setCustomizeOpen] = React.useState(false)
  const { isAdmin, projects, updateProject } = useCurrentUser()

  React.useEffect(() => {
    const controller = new AbortController()
    fetchDashboard("default", controller.signal).then(setDashboard).catch(() => setDashboard(null))
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    fetchDatasetReleases(controller.signal).then(setReleases).catch(() => setReleases([]))
    fetchTrainingRuns(controller.signal).then(setTrainingRuns).catch(() => setTrainingRuns([]))
    fetchModelVersions(controller.signal).then(setModels).catch(() => setModels([]))
    fetchJobs(controller.signal).then(setJobs).catch(() => setJobs([]))
    fetchAuditEvents({ limit: 5 }, controller.signal).then((page) => setAuditEvents(page.items)).catch(() => setAuditEvents([]))
    return () => controller.abort()
  }, [])

  const stats = dashboard?.stats
  const taskList = tasks ?? []
  const annotatedImages = taskList
    .filter((task) => task.status.toLowerCase() === "completed")
    .reduce((total, task) => total + task.size, 0)
  const importedImages = stats?.images ?? taskList.reduce((total, task) => total + task.size, 0)
  const objectCount = dashboard?.class_distribution.reduce((total, item) => total + item.count, 0) ?? 0
  const currentProject = dashboard?.project ?? null
  const currentProjectStorage = storageFromProject(currentProject)
  const contextProject = projects.find((project) => project.id === currentProject?.id) ?? projects[0] ?? null
  const projectJobsHref = contextProject?.id ? `/jobs?project=${encodeURIComponent(contextProject.id)}` : "/jobs"
  const projectTasks = taskList.filter((task) => {
    const projectExternalId = currentProject?.external_id
    return projectExternalId ? task.project_external_id === projectExternalId : false
  })
  const projectJobs = jobs.filter((job) => jobMatchesProject(job, currentProject, contextProject?.id ?? null, projectTasks))
  const failedJobs = projectJobs.filter((job) => job.status === "failed")
  const activeProjectJobs = projectJobs.filter((job) => job.status === "running" || job.status === "queued")
  const overviewKpis = [
    {
      ...kpiMeta[0],
      value: formatPtNumber(importedImages),
      sub: `${formatPtNumber(stats?.tasks ?? taskList.length)} tasks sincronizadas`,
    },
    {
      ...kpiMeta[1],
      value: formatPtNumber(annotatedImages),
      sub: "Tasks concluídas no CVAT",
      bar: importedImages > 0 ? Math.round((annotatedImages / importedImages) * 100) : 0,
    },
    {
      ...kpiMeta[2],
      value: formatPtNumber(objectCount),
      sub: "Labels/classes conhecidas",
    },
    {
      ...kpiMeta[3],
      value: formatPtNumber(stats?.pending_review ?? 0),
      sub: `${formatPtNumber(activeProjectJobs.length)} jobs ativos`,
    },
  ]

  const taskClasses = labelsFromTasks(tasks)
  const classItems =
    dashboard?.class_distribution && dashboard.class_distribution.length > 0
      ? dashboard.class_distribution.map((item, index) => ({
          name: item.name,
          count: item.count,
          share: item.share,
          color: classColors[index % classColors.length],
        }))
      : taskClasses.length > 0
        ? taskClasses.map((item) => ({
            name: item.name,
            count: item.count ?? 1,
            share: Math.round((100 / taskClasses.length) * 100) / 100,
            color: item.color,
          }))
      : []

  const activeTrainingRuns = trainingRuns.filter((run) => run.status === "running" || run.status === "queued")
  const latestRelease = releases[0] ?? null
  const latestReleaseCounts = snapshotCounts(latestRelease?.snapshot ?? {})
  const currentModel = bestModel(models)
  const modelEvolutionItems = models
    .map((model) => {
      const map = bestMapFromMetrics(model.metrics)
      return map === null
        ? null
        : {
            version: `${model.name} ${model.version}`,
            map,
          }
    })
    .filter((item): item is { version: string; map: number } => item !== null)
  const projectActivityItems = auditEvents
    .filter((event) => isProjectAuditEvent(event, currentProject, projectTasks, releases, jobs))
    .map((event) => formatAuditActivity(event, currentProject))
  const attentionItems = [
    ...(stats?.pending_review
      ? [
          {
            icon: AlertCircle,
            tone: "bg-warning/15 text-warning",
            title: `${formatPtNumber(stats.pending_review)} anotações`,
            desc: "Precisam ser revisadas",
            href: "/revisar",
          },
        ]
      : []),
    ...(failedJobs.length
      ? [
          {
            icon: TriangleAlert,
            tone: "bg-destructive/12 text-destructive",
            title: `${formatPtNumber(failedJobs.length)} jobs falharam`,
            desc: "Ver detalhes",
            href: projectJobsHref,
          },
        ]
      : []),
    ...(!taskList.length
      ? [
          {
            icon: Info,
            tone: "bg-surface-blue text-brand-blue",
            title: "Sem lotes importados",
            desc: "Suba imagens para iniciar o projeto",
            href: "/dados",
          },
        ]
      : []),
    ...(taskList.length && !releases.length
      ? [
          {
            icon: Info,
            tone: "bg-surface-mint text-brand-mint",
            title: "Sem release",
            desc: "Crie uma versão do dataset",
            href: "/releases",
          },
        ]
      : []),
  ]
  const recommendedAction = recommendation({
    pendingReview: stats?.pending_review ?? 0,
    failedJobs: failedJobs.length,
    jobsHref: projectJobsHref,
    tasks: taskList.length,
    releases: releases.length,
    trainingRuns: trainingRuns.length,
  })
  const customizeTarget: ProjectDialogTarget | null = dashboard?.project
    ? {
        id: dashboard.project.id,
        name: dashboard.project.name,
        storagePath: currentProjectStorage?.path ?? contextProject?.storagePath ?? "",
        quotaGb: currentProjectStorage?.quotaGb ?? contextProject?.quotaGb ?? 40,
        annotatorIds: contextProject?.annotatorIds ?? [],
      }
    : contextProject
      ? {
          id: contextProject.id,
          name: contextProject.name,
          storagePath: contextProject.storagePath,
          quotaGb: contextProject.quotaGb,
          annotatorIds: contextProject.annotatorIds,
        }
      : null

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Visão geral do projeto</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            Resumo do estado atual e próximos passos recomendados.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={() => setCustomizeOpen(true)}
              disabled={!customizeTarget}
            >
              <Sliders className="size-4" />
              Personalizar
            </Button>
            <Button size="lg" onClick={() => setImportDialogOpen(true)}>
              <Upload className="size-4" />
              Importar lote
            </Button>
          </div>
        )}
      </div>
      <ImportBatchDialog
        open={importDialogOpen}
        projectId={contextProject?.id ?? dashboard?.project?.id ?? null}
        onClose={() => setImportDialogOpen(false)}
        onImported={() => {
          setImportDialogOpen(false)
          const projectId = contextProject?.id ?? dashboard?.project?.id
          router.push(projectId ? `/jobs?project=${encodeURIComponent(projectId)}` : "/jobs")
        }}
      />
      <ProjectDialog
        open={customizeOpen}
        mode="edit"
        project={customizeTarget}
        onClose={() => setCustomizeOpen(false)}
        onSaved={(project, _mode, annotatorIds) => {
          const record = projectRecordFromBackend(project, annotatorIds)
          void updateProject(project.id, {
            name: record.name,
            storagePath: record.storagePath,
            quotaGb: record.quotaGb,
            annotatorIds,
          })
          setDashboard((current) => (current ? { ...current, project } : current))
        }}
      />

      {/* Recommended action + KPIs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-6">
        <Card tone="subtle" className="flex flex-col justify-between gap-6 lg:col-span-2 xl:col-span-2">
          <div className="flex flex-col gap-3">
            <div className={`flex items-center gap-2 ${recommendedAction.tone}`}>
              <recommendedAction.icon className="size-4" />
              <span className="text-sm font-medium">Próxima ação recomendada</span>
            </div>
            <p className="text-lg font-medium leading-snug text-balance">
              {recommendedAction.title}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" nativeButton={false} render={<Link href={recommendedAction.href} />}>
              {recommendedAction.primaryLabel}
              <ArrowRight className="size-4" />
            </Button>
            {recommendedAction.secondaryHref && (
              <Button variant="outline" size="lg" nativeButton={false} render={<Link href={recommendedAction.secondaryHref} />}>
                {recommendedAction.secondaryLabel}
              </Button>
            )}
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
            {"bar" in kpi && kpi.bar != null && <ProgressBar value={kpi.bar} color="bg-brand-green" />}
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
              {currentModel && <Badge variant="info">Melhor</Badge>}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {currentModel ? (
              <>
                <div>
                  <p className="text-xl font-semibold tracking-tight">
                    {currentModel.name} {currentModel.version}
                  </p>
                  <p className="text-xs text-muted-foreground">mAP50-95</p>
                  <p className="text-3xl font-semibold tabular-nums">
                    {currentModel.map === null ? "--" : currentModel.map.toFixed(3).replace(".", ",")}
                  </p>
                </div>
                <div className="-mx-2">
                  <SparkLineChart data={modelEvolutionItems} dataKey="map" color="var(--brand-blue)" highlightLast />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Dataset: {currentModel.dataset}</span>
                  <StatusBadge status={modelStatus(currentModel.status)} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhum modelo registrado no backend.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle>Treinamentos ativos</CardTitle>
              <Badge variant="info">{activeTrainingRuns.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {activeTrainingRuns.slice(0, 2).map((run) => {
              const epochs = numberFromRecord(run.config, "epochs") ?? 100
              const epoch = numberFromRecord(run.metrics, "epoch") ?? Math.round((run.progress / 100) * epochs)
              return (
                <Link
                  key={run.id}
                  href={`/treinar/${run.id}`}
                  className="flex flex-col gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-muted"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Treinamento {run.id.slice(0, 8)}</span>
                    <StatusBadge status={toUiJobStatus(run.status)} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {run.base_model.replace(/\.pt$/i, "")} · {run.dataset_release_id.slice(0, 8)}
                  </p>
                  <ProgressBar value={run.progress} color="bg-brand-green" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Época {epoch}/{epochs}</span>
                    <span>{formatDateTimePt(run.created_at)}</span>
                  </div>
                </Link>
              )
            })}
            {activeTrainingRuns.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhum treinamento ativo.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Último dataset release</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {latestRelease ? (
              <>
                <div>
                  <p className="text-xl font-semibold tracking-tight">{latestRelease.name}</p>
                  <p className="text-xs text-muted-foreground">Criado em {formatDateTimePt(latestRelease.created_at)}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ["Imagens", formatPtNumber(latestReleaseCounts.images ?? 0)],
                    ["Objetos", formatPtNumber(latestReleaseCounts.annotations ?? latestReleaseCounts.objects ?? 0)],
                    ["Artefatos", latestRelease.artifact_uri ? "1" : "0"],
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
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhum dataset release criado.</p>
            )}
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
            {projectActivityItems.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg py-2">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                  <a.icon />
                </span>
                <span className="flex-1 truncate text-sm">{a.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{a.time}</span>
              </div>
            ))}
            {projectActivityItems.length === 0 && (
              <p className="text-sm text-muted-foreground">Nenhuma atividade recente deste projeto.</p>
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

function snapshotCounts(snapshot: Record<string, unknown>) {
  const counts = snapshot.counts
  return counts && typeof counts === "object"
    ? (counts as { annotations?: number; images?: number; objects?: number })
    : {}
}

function bestModel(models: BackendModelVersion[]) {
  const ranked = models
    .map((model) => ({
      ...model,
      map: bestMapFromMetrics(model.metrics),
      dataset: model.dataset_release_id?.slice(0, 8) ?? "--",
    }))
    .sort((a, b) => (b.map ?? -1) - (a.map ?? -1))
  return ranked[0] ?? null
}

function bestMapFromMetrics(metrics: Record<string, unknown>) {
  for (const key of ["metrics/mAP50-95(B)", "map5095", "box_map", "box.map", "mAP50-95"]) {
    const value = numberFromUnknown(metrics[key])
    if (value !== null) return value
  }
  return null
}

function modelStatus(status: string) {
  if (status === "archived") return "arquivado"
  if (status === "registered" || status === "published") return "publicado"
  if (status === "approved") return "aprovado"
  return "em-construcao"
}

function numberFromRecord(record: Record<string, unknown>, key: string) {
  return numberFromUnknown(record[key])
}

function jobMatchesProject(
  job: BackendJob,
  project: BackendProject | null,
  projectId: string | null,
  projectTasks: BackendTask[],
) {
  const raw = job.raw ?? {}
  const payload = objectValue(raw.payload)
  const lineage = objectValue(raw.lineage)
  const projectIds = new Set([project?.id, project?.external_id, project?.name, projectId].filter(Boolean).map(String))
  const taskIds = new Set(
    projectTasks.flatMap((task) => [task.id, task.external_id, task.name]).filter(Boolean).map(String),
  )
  const values = [
    job.task_external_id,
    raw.project_id,
    raw.project_external_id,
    raw.task_external_id,
    payload.project_id,
    payload.project_external_id,
    payload.task_external_id,
    lineage.project_id,
    lineage.project_external_id,
  ].map((value) => String(value ?? ""))

  return values.some((value) => projectIds.has(value) || taskIds.has(value))
}

function isProjectAuditEvent(
  event: BackendAuditEvent,
  project: BackendProject | null,
  projectTasks: BackendTask[],
  releases: BackendDatasetRelease[],
  jobs: BackendJob[],
) {
  if (!project) return false
  const payload = event.payload ?? {}
  const projectIds = new Set([project.id, project.external_id, project.name].filter(Boolean).map(String))
  const taskIds = new Set(
    projectTasks.flatMap((task) => [task.id, task.external_id, task.name]).filter(Boolean).map(String),
  )
  const releaseIds = new Set(
    releases
      .filter((release) => release.project_id === project.id || release.project_id === project.external_id)
      .flatMap((release) => [release.id, release.name])
      .filter(Boolean)
      .map(String),
  )
  const jobIds = new Set(
    jobs
      .filter((job) => {
        const raw = job.raw ?? {}
        return (
          projectIds.has(String(raw.project_id ?? "")) ||
          projectIds.has(String(raw.project_external_id ?? "")) ||
          taskIds.has(String(job.task_external_id ?? "")) ||
          taskIds.has(String(raw.task_external_id ?? ""))
        )
      })
      .flatMap((job) => [job.id, job.external_id])
      .filter(Boolean)
      .map(String),
  )
  const directValues = [
    event.target,
    payload.project_id,
    payload.external_id,
    payload.project_external_id,
    payload.task_external_id,
    payload.dataset_release_id,
    payload.release_id,
    payload.job_id,
    payload.pipeline_run_id,
  ].map((value) => String(value ?? ""))

  return directValues.some(
    (value) => projectIds.has(value) || taskIds.has(value) || releaseIds.has(value) || jobIds.has(value),
  )
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function formatAuditActivity(event: BackendAuditEvent, project: BackendProject | null) {
  const label = auditActionLabel(event.action)
  const target = auditTargetLabel(event, project)
  return {
    id: event.id,
    icon: auditIcon(event.action),
    title: target ? `${label} - ${target}` : label,
    time: formatDateTimePt(event.created_at),
  }
}

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    project_created: "Projeto criado",
    project_updated: "Projeto atualizado",
    project_members_updated: "Equipe atualizada",
    import_task_queued: "Importacao agendada",
    import_task_files_uploaded: "Imagens enviadas",
    import_task_completed: "Importacao concluida",
    cvat_sync_completed: "CVAT sincronizado",
    cvat_sync_partial_error: "Sync parcial do CVAT",
    cvat_sync_failed: "Sync do CVAT falhou",
    dataset_release_queued: "Release do dataset iniciado",
    dataset_release_ready: "Release do dataset pronto",
    dataset_release_failed: "Release do dataset falhou",
    derived_dataset_release_queued: "Dataset derivado iniciado",
    pipeline_run_created: "Pipeline criado",
    pipeline_run_completed: "Pipeline concluido",
    job_queued: "Job enfileirado",
    job_succeeded: "Job concluido",
    job_failed: "Job falhou",
    training_run_created: "Treinamento iniciado",
    training_run_completed: "Treinamento concluido",
    inference_suggestions_created: "Sugestoes geradas",
    inference_suggestions_replaced: "Sugestoes atualizadas",
    manual_annotations_saved: "Anotacoes salvas",
  }
  if (labels[action]) return labels[action]
  if (action.startsWith("review_")) return "Revisao registrada"
  if (action.startsWith("track_")) return "Track atualizada"
  return titleFromSnakeCase(action)
}

function auditTargetLabel(event: BackendAuditEvent, project: BackendProject | null) {
  const target = String(event.target ?? "")
  if (!target) return ""
  if (project && (target === project.id || target === project.external_id)) return project.name
  if (event.action.includes("project")) return project?.name ?? "Projeto"
  if (event.action.includes("job")) return `Job ${target.slice(0, 8)}`
  if (event.action.includes("pipeline")) return `Pipeline ${target.slice(0, 8)}`
  if (event.action.includes("release")) return `Release ${target.slice(0, 8)}`
  if (event.action.includes("training")) return `Treino ${target.slice(0, 8)}`
  if (event.action.includes("sync")) return `Sync ${target.slice(0, 8)}`
  if (target.length > 18) return target.slice(0, 8)
  return target
}

function titleFromSnakeCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function recommendation({
  pendingReview,
  failedJobs,
  jobsHref,
  tasks,
  releases,
  trainingRuns,
}: {
  pendingReview: number
  failedJobs: number
  jobsHref: string
  tasks: number
  releases: number
  trainingRuns: number
}) {
  if (pendingReview > 0) {
    return {
      icon: AlertCircle,
      tone: "text-warning",
      title: `Revisar ${formatPtNumber(pendingReview)} anotações pendentes.`,
      primaryLabel: "Continuar revisão",
      href: "/revisar",
      secondaryLabel: "Ver fila de revisão",
      secondaryHref: "/revisar",
    }
  }
  if (failedJobs > 0) {
    return {
      icon: TriangleAlert,
      tone: "text-destructive",
      title: `Verificar ${formatPtNumber(failedJobs)} jobs com falha.`,
      primaryLabel: "Abrir jobs",
      href: jobsHref,
    }
  }
  if (tasks === 0) {
    return {
      icon: Upload,
      tone: "text-brand-blue",
      title: "Importar o primeiro lote de imagens do projeto.",
      primaryLabel: "Importar lote",
      href: "/dados",
    }
  }
  if (releases === 0) {
    return {
      icon: GitCommitVertical,
      tone: "text-brand-indigo",
      title: "Criar um dataset release a partir das tasks sincronizadas.",
      primaryLabel: "Criar release",
      href: "/releases",
    }
  }
  if (trainingRuns === 0) {
    return {
      icon: Boxes,
      tone: "text-brand-green",
      title: "Iniciar o primeiro treinamento com um release pronto.",
      primaryLabel: "Novo treinamento",
      href: "/treinar",
    }
  }
  return {
    icon: Info,
    tone: "text-brand-green",
    title: "Nenhuma ação operacional pendente no momento.",
    primaryLabel: "Ver jobs",
    href: "/jobs",
  }
}

function auditIcon(action: string) {
  if (action.includes("training")) return Boxes
  if (action.includes("release")) return GitCommitVertical
  if (action.includes("review")) return FileClock
  if (action.includes("failed")) return TriangleAlert
  return Info
}
