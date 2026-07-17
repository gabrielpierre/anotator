"use client"

import { Pause, Square, Play, Cpu, HardDrive, MemoryStick, Clock } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { StatusBadge, ProgressBar, Meter } from "@/components/app/primitives"
import { MetricCard } from "@/components/snowui/metric-card"
import { activeJobs, queuedJobs, recentJobs, machineResources } from "@/lib/mock-data"

export function JobsView() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Central de jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitore treinos, pipelines e exportações em execução, na fila e recentes.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Em execução" value="2" hint="Treino + Pipeline" tone="blue" />
        <MetricCard label="Na fila" value="3" hint="Aguardando recursos" tone="purple" />
        <MetricCard label="Concluídos hoje" value="14" hint="1 falha" tone="mint" />
        <MetricCard label="Uso de GPU" value="75%" hint="2x RTX 4090" tone="blue" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          {/* Active */}
          <Card>
            <CardHeader>
              <CardTitle>Em execução</CardTitle>
              <span className="text-xs text-muted-foreground">{activeJobs.length} jobs</span>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {activeJobs.map((job) => (
                <div key={job.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{job.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {job.type}
                      </span>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      {job.status === "executando" ? (
                        <>
                          <Button variant="ghost" size="sm">
                            <Pause className="size-3.5" />
                            Pausar
                          </Button>
                          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10">
                            <Square className="size-3.5" />
                            Parar
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm">
                          <Play className="size-3.5" />
                          Iniciar agora
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{job.detail}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <ProgressBar
                      value={job.progress}
                      color={job.status === "na-fila" ? "bg-warning" : "bg-brand-blue"}
                    />
                    <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
                      {job.progress}%
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                    <Info label="Etapa" value={job.progressLabel} />
                    <Info label="Decorrido" value={job.elapsed} />
                    <Info label="ETA" value={job.eta} />
                    <Info label="GPU" value={`${job.gpu}%`} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Queue */}
          <Card>
            <CardHeader>
              <CardTitle>Na fila</CardTitle>
              <span className="text-xs text-muted-foreground">{queuedJobs.length} jobs</span>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {queuedJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-3 py-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-warning/12 text-warning">
                    <Clock className="size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{job.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.type} · {job.detail}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{job.position}</span>
                  <Button variant="ghost" size="sm">Cancelar</Button>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Recent */}
          <Card>
            <CardHeader>
              <CardTitle>Recentes</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border">
              {recentJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-3 py-3">
                  <StatusBadge status={job.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{job.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{job.detail}</p>
                  </div>
                  <div className="hidden text-right text-xs text-muted-foreground sm:block">
                    <p>{job.startedAt}</p>
                    <p className="tabular-nums">Duração {job.elapsed}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right rail — resources */}
        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Recursos da máquina</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {machineResources.gpus.map((gpu, i) => (
                <div key={gpu.name} className="flex flex-col gap-2">
                  <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Cpu className="size-3.5 text-brand-blue" />
                    GPU {i}
                  </span>
                  <Meter label="Utilização" value={gpu.util} color="bg-brand-blue" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Memória</span>
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
                <Meter label="Uso" value={machineResources.disk.util} detail={machineResources.disk.label} color="bg-brand-indigo" />
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
