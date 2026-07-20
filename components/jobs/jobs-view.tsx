"use client"

import * as React from "react"
import { Clock, Cpu, HardDrive, MemoryStick, Square } from "lucide-react"

import { ProgressBar, Meter, StatusBadge } from "@/components/app/primitives"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { MetricCard } from "@/components/snowui/metric-card"
import { Button } from "@/components/ui/button"
import { activeJobs, machineResources, queuedJobs, recentJobs } from "@/lib/mock-data"
import { cancelJob, fetchJobs, jobsEventsUrl, mockFallbackEnabled } from "@/lib/api/client"
import { formatDateTimePt, toUiJobStatus } from "@/lib/api/status"
import type { BackendJob } from "@/lib/api/types"

export function JobsView() {
  const [backendJobs, setBackendJobs] = React.useState<BackendJob[] | null>(null)
  const [cancelingIds, setCancelingIds] = React.useState<Set<string>>(new Set())
  const useMocks = mockFallbackEnabled()

  React.useEffect(() => {
    const controller = new AbortController()
    fetchJobs(controller.signal).then(setBackendJobs).catch(() => setBackendJobs(null))
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

  const mappedJobs = backendJobs?.map(mapBackendJob)
  const activeItems = mappedJobs
    ? mappedJobs.filter((job) => job.status === "executando" || job.status === "pausado")
    : useMocks
      ? activeJobs
      : []
  const queuedItems = mappedJobs
    ? mappedJobs
        .filter((job) => job.status === "na-fila")
        .map((job, index) => ({
          id: job.id,
          name: job.name,
          type: job.type,
          detail: job.detail,
          position: `Posicao: ${index + 1}`,
        }))
    : useMocks
      ? queuedJobs
      : []
  const recentItems = mappedJobs
    ? mappedJobs.filter((job) => ["concluido", "falhou", "cancelado"].includes(job.status))
    : useMocks
      ? recentJobs.map((job) => ({ ...job, progress: job.status === "falhou" ? 0 : 100 }))
      : []
  const runningCount = activeItems.filter((job) => job.status === "executando").length
  const queuedCount = queuedItems.length

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Central de jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitore syncs, releases, treinos, pipelines e exportacoes em execucao.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Em execucao" value={String(runningCount)} hint="Backend + CVAT" tone="blue" />
        <MetricCard label="Na fila" value={String(queuedCount)} hint="Aguardando worker" tone="purple" />
        <MetricCard label="Finalizados" value={String(recentItems.length)} hint="Historico local" tone="mint" />
        <MetricCard label="Uso de GPU" value="75%" hint="2x RTX 4090" tone="blue" />
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
              {machineResources.gpus.map((gpu, i) => (
                <div key={gpu.name} className="flex flex-col gap-2">
                  <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Cpu className="size-3.5 text-brand-blue" />
                    GPU {i}
                  </span>
                  <Meter label="Utilizacao" value={gpu.util} color="bg-brand-blue" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Memoria</span>
                    <span className="tabular-nums text-foreground">{gpu.mem}</span>
                  </div>
                </div>
              ))}
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <MemoryStick className="size-3.5 text-brand-lavender" />
                  CPU / RAM
                </span>
                <Meter label="CPU" value={machineResources.cpu.util} color="bg-brand-lavender" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>RAM</span>
                  <span className="tabular-nums text-foreground">{machineResources.cpu.mem}</span>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <HardDrive className="size-3.5 text-brand-indigo" />
                  Disco
                </span>
                <Meter
                  label="Uso"
                  value={machineResources.disk.util}
                  detail={machineResources.disk.label}
                  color="bg-brand-indigo"
                />
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
