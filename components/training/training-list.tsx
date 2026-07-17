"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, Search, Clock, Cpu, TrendingUp, Database, Check, X, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { StatusBadge, ProgressBar } from "@/components/app/primitives"
import { trainings, releases } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function TrainingList() {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Treinamentos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe execuções de treino, compare métricas e inicie novos jobs.
          </p>
        </div>
        <Button size="lg" onClick={() => setPickerOpen(true)}>
          <Plus className="size-4" />
          Novo treinamento
        </Button>
      </div>

      <ReleasePicker open={pickerOpen} onClose={() => setPickerOpen(false)} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Em execução" value="1" hint="Treinamento #18" />
        <MetricCard label="Concluídos" value="16" hint="últimos 30 dias" />
        <MetricCard label="Melhor mAP50-95" value="0.83" hint="YOLO11m v18" />
        <MetricCard label="Tempo médio" value="1h 12m" hint="por treinamento" />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Histórico de treinamentos</CardTitle>
          <div className="w-full max-w-xs">
            <Input
              placeholder="Buscar por ID ou modelo..."
              aria-label="Buscar treinamentos"
              icon={<Search />}
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {trainings.map((t) => (
              <Link
                key={t.id}
                href={`/treinar/${t.slug}`}
                className="flex flex-col gap-4 px-5 py-4 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                    <TrendingUp className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">{t.name}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.model} · {t.dataset} · {t.startedAt}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 sm:flex sm:items-center sm:gap-8">
                  <div className="min-w-[84px]">
                    <p className="text-xs text-muted-foreground">Época</p>
                    <p className="text-sm font-medium text-foreground tabular-nums">
                      {t.epoch} / {t.epochs}
                    </p>
                  </div>
                  <div className="min-w-[84px]">
                    <p className="text-xs text-muted-foreground">mAP50-95</p>
                    <p className="text-sm font-medium text-foreground tabular-nums">{t.bestMap}</p>
                  </div>
                  <div className="hidden min-w-[120px] items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <Clock className="size-3.5" />
                    {t.elapsed}
                  </div>
                  <div className="hidden min-w-[120px] items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <Cpu className="size-3.5" />
                    {t.device}
                  </div>
                </div>

                <div className="w-full sm:w-40">
                  <ProgressBar value={t.progress} />
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

const statusLabels: Record<string, { label: string; className: string }> = {
  "em-construcao": { label: "Em construção", className: "bg-warning/15 text-warning" },
  publicado: { label: "Publicado", className: "bg-brand-green/15 text-brand-green" },
  arquivado: { label: "Arquivado", className: "bg-muted text-muted-foreground" },
}

function ReleasePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const [selected, setSelected] = React.useState(releases[0]?.id ?? "")

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  function confirm() {
    router.push(`/treinar/novo?release=${encodeURIComponent(selected)}`)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Selecionar dataset release"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Selecionar dataset release</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Escolha o release que será usado como base para o novo treinamento.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-4">
          {releases.map((r, i) => {
            const active = selected === r.id
            const s = statusLabels[r.status] ?? statusLabels.arquivado
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-colors",
                  active ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted/40",
                )}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-brand-blue">
                  <Database className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {r.id}
                    {i === 0 && (
                      <span className="rounded-full bg-brand-green/15 px-1.5 py-0.5 text-xs font-medium text-brand-green">
                        Mais recente
                      </span>
                    )}
                    <span className={cn("rounded-full px-1.5 py-0.5 text-xs font-medium", s.className)}>{s.label}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.images.toLocaleString("pt-BR")} imagens · {r.objects.toLocaleString("pt-BR")} objetos · {r.size}
                  </p>
                  <p className="text-xs text-muted-foreground">Criado em {r.date}</p>
                </div>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-brand-blue bg-brand-blue text-white" : "border-border",
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={!selected}>
            Continuar
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
