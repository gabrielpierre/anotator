"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Clock, Cpu, HardDrive, MemoryStick, Square } from "lucide-react"

import { ProgressBar, Meter, StatusBadge } from "@/components/app/primitives"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { MetricCard } from "@/components/snowui/metric-card"
import { Button } from "@/components/ui/button"
import { cancelJob, fetchJobCapacity, fetchJobs, jobsEventsUrl } from "@/lib/api/client"
import { formatDateTimePt, toUiJobStatus } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendJob, BackendJobCapacity } from "@/lib/api/types"

export function JobsView() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get("project")
  const { projects } = useCurrentUser()
  const [backendJobs, setBackendJobs] = React.useState<BackendJob[] | null>(null)
  const [capacity, setCapacity] = React.useState<BackendJobCapacity | null>(null)
  const [cancelingIds, setCancelingIds] = React.useState<Set<string>>(new Set())
  const scopedProject = projects.find((project) => project.id === projectId) ?? null
  const defaultProject = projects[0] ?? null
  const isProjectScoped = Boolean(projectId)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchJobs(controller.signal).then(setBackendJobs).catch(() => setBackendJobs(null))
    fetchJobCapacity(controller.signal).then(setCapacity).catch(() => setCapacity(null))
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    const source = new EventSource(jobsEventsUrl())
    const handleJobs = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { jobs?: BackendJob[] }
        if (Array.isArray(payload.jobs)) setBackendJobs(payload.jobs)
      } catch {
        // Ignore malformed stream events; the next snapshot will replace state.
      }
    }
    source.addEventListener("jobs", handleJobs as EventListener)
    source.onerror = () => {
      source.close()
    }
    return () => source.close()
  }, [])

  const handleCancel = async (jobId: string) => {
    setCancelingIds((current) => new Set(current).add(jobId))
    try {
      const canceled = await cancelJob(jobId)
      setBackendJobs((current) => current?.map((job) => (job.id === canceled.id ? canceled : job)) ?? [canceled])
    } finally {
      setCancelingIds((current) => {
        const next = new Set(current)
        next.delete(jobId)
        return next
      })
    }
  }

  const visibleBackendJobs = projectId
    ? (backendJobs ?? []).filter((job) => jobMatchesProject(job, projectId))
    : (backendJobs ?? [])
  const mappedJobs = visibleBackendJobs.map(mapBackendJob)
  const activeItems = mappedJobs
    .filter((job) => job.status === "executando" || job.status === "pausado")
  const queuedItems = mappedJobs
    .filter((job) => job.status === "na-fila")
    .map((job, index) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      detail: job.detail,
      position: `Posicao: ${index + 1}`,
    }))
  const recentItems = mappedJobs
    .filter((job) => ["concluido", "falhou", "cancelado"].includes(job.status))
  const runningCount = activeItems.filter((job) => job.status === "executando").length
  const queuedCount = queuedItems.length
  const memory = memoryUsage(capacity)
  const gpu = gpuSummary(capacity?.gpu)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isProjectScoped ? `Jobs do projeto ${scopedProject?.name ?? "selecionado"}` : "Jobs gerais"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isProjectScoped
              ? "Acompanhe importacoes, syncs, releases, treinos e pipelines deste projeto."
              : "Visao administrativa dos jobs de todos os projetos."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isProjectScoped && (
            <Button variant="outline" nativeButton={false} render={<Link href="/jobs" />}>
              Ver jobs gerais
            </Button>
          )}
          {!isProjectScoped && defaultProject && (
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/jobs?project=${encodeURIComponent(defaultProject.id)}`} />}
            >
              Ver projeto atual
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Em execucao" value={String(runningCount)} hint="Backend + CVAT" tone="blue" />
        <MetricCard label="Na fila" value={String(queuedCount)} hint="Aguardando worker" tone="purple" />
        <MetricCard label="Finalizados" value={String(recentItems.length)} hint="Historico local" tone="mint" />
        <MetricCard label="GPU" value={gpu.value} hint={gpu.hint} tone="blue" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Em execucao</CardTitle>
              <span className="text-xs text-muted-foreground">{activeItems.length} jobs</span>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {activeItems.map((job) => (
                <div key={job.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{job.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {job.type}
                      </span>
                      <StatusBadge status={job.status} />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      disabled={cancelingIds.has(job.id)}
                      onClick={() => handleCancel(job.id)}
                    >
                      <Square className="size-3.5" />
                      {cancelingIds.has(job.id) ? "Cancelando..." : "Cancelar"}
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{job.detail}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <ProgressBar value={job.progress} color="bg-brand-blue" />
                    <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">{job.progress}%</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                    <Info label="Etapa" value={job.progressLabel} />
                    <Info label="Inicio" value={job.startedAt} />
                    <Info label="ETA" value={job.eta} />
                    <Info label="GPU" value={`${job.gpu}%`} />
                  </div>
                </div>
              ))}
              {!activeItems.length ? <p className="text-sm text-muted-foreground">Nenhum job em execucao.</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Na fila</CardTitle>
              <span className="text-xs text-muted-foreground">{queuedItems.length} jobs</span>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {queuedItems.map((job) => (
                <div key={job.id} className="flex items-center gap-3 py-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-warning/12 text-warning">
                    <Clock className="size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{job.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.type} - {job.detail}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{job.position}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancelingIds.has(job.id)}
                    onClick={() => handleCancel(job.id)}
                  >
                    {cancelingIds.has(job.id) ? "Cancelando..." : "Cancelar"}
                  </Button>
                </div>
              ))}
              {!queuedItems.length ? <p className="py-3 text-sm text-muted-foreground">Fila vazia.</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recentes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {recentItems.map((job) => (
                <div key={job.id} className="flex items-center gap-3 py-3">
                  <StatusBadge status={job.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{job.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{job.detail}</p>
                  </div>
                  <div className="hidden text-right text-xs text-muted-foreground sm:block">
                    <p>{job.startedAt}</p>
                    <p className="tabular-nums">{job.progress}%</p>
                  </div>
                </div>
              ))}
              {!recentItems.length ? <p className="py-3 text-sm text-muted-foreground">Sem jobs recentes.</p> : null}
            </CardContent>
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Recursos da maquina</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Cpu className="size-3.5 text-brand-blue" />
                  GPU
                </span>
                <Meter label="Utilizacao" value={gpu.utilization} color="bg-brand-blue" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Status</span>
                  <span className="tabular-nums text-foreground">{gpu.hint}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <MemoryStick className="size-3.5 text-brand-lavender" />
                  CPU / RAM
                </span>
                <Meter label="CPU" value={0} detail={`${capacity?.cpu_count ?? "--"} cores detectados`} color="bg-brand-lavender" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>RAM</span>
                  <span className="tabular-nums text-foreground">{memory.label}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <HardDrive className="size-3.5 text-brand-indigo" />
                  Disco
                </span>
                <Meter label="Uso" value={0} detail="Não reportado pelo backend" color="bg-brand-indigo" />
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums text-foreground">{value}</p>
    </div>
  )
}

function mapBackendJob(job: BackendJob) {
  return {
    id: job.id,
    name: job.name,
    type: job.kind,
    detail: job.detail ?? job.kind,
    progress: Math.round(job.progress),
    progressLabel: job.detail ?? job.kind,
    status: toUiJobStatus(job.status),
    startedAt: formatDateTimePt(job.started_at ?? job.created_at),
    eta: "--",
    gpu: Number(job.resource_metrics.gpu ?? 0),
  }
}

function jobMatchesProject(job: BackendJob, projectId: string) {
  const raw = job.raw ?? {}
  const payload = objectValue(raw.payload)
  const lineage = objectValue(raw.lineage)
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
  ]
  return values.some((value) => String(value ?? "") === projectId)
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function memoryUsage(capacity: BackendJobCapacity | null) {
  const total = capacity?.memory_total_bytes ?? null
  const available = capacity?.memory_available_bytes ?? null
  if (!total || available === null) return { value: 0, label: "--" }
  const used = Math.max(0, total - available)
  return {
    value: Math.round((used / total) * 100),
    label: `${formatBytes(used)} / ${formatBytes(total)}`,
  }
}

function gpuSummary(gpu: Record<string, unknown> | undefined) {
  const available = gpu?.available === true
  const utilization = numberFromUnknown(gpu?.utilization_percent) ?? 0
  return {
    value: available ? `${utilization}%` : "--",
    hint: available ? "reportada pelo backend" : "indisponível",
    utilization,
  }
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
