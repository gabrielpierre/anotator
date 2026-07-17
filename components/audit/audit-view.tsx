"use client"

import { Search, Download, Check, X, Pencil, GitCommit, Play, ArrowUpRight, Bot } from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/snowui/input"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader } from "@/components/app/primitives"
import { auditEvents } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

const actionMeta: Record<string, { icon: typeof Check; tone: string; bg: string }> = {
  aceitou: { icon: Check, tone: "text-brand-green", bg: "bg-brand-green/12" },
  rejeitou: { icon: X, tone: "text-destructive", bg: "bg-destructive/12" },
  "corrigiu classe": { icon: Pencil, tone: "text-warning", bg: "bg-warning/12" },
  "criou release": { icon: GitCommit, tone: "text-brand-indigo", bg: "bg-surface-purple" },
  "aplicou ao track": { icon: ArrowUpRight, tone: "text-brand-blue", bg: "bg-surface-blue" },
  escalou: { icon: ArrowUpRight, tone: "text-warning", bg: "bg-warning/12" },
  "iniciou treinamento": { icon: Play, tone: "text-brand-blue", bg: "bg-surface-blue" },
}

function initials(name: string) {
  return name === "Sistema" ? null : name.slice(0, 2).toUpperCase()
}

export function AuditView() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Auditoria"
        subtitle="Registro imutável de decisões humanas e eventos do sistema."
        actions={
          <>
            <Input placeholder="Buscar eventos..." aria-label="Buscar eventos" icon={<Search />} className="w-48" />
            <Button variant="outline">
              <Download className="size-4" />
              Exportar log
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Eventos hoje" value="248" hint="+32 na última hora" tone="blue" />
        <MetricCard label="Aceitas" value="182" hint="73% das decisões" tone="mint" />
        <MetricCard label="Rejeitadas / corrigidas" value="54" hint="22% das decisões" tone="subtle" />
        <MetricCard label="Eventos do sistema" value="12" hint="pipelines + releases" tone="purple" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Linha do tempo</CardTitle>
          <span className="text-xs text-muted-foreground">Ordenado do mais recente</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {auditEvents.map((e, i) => {
            const meta = actionMeta[e.action] ?? { icon: Check, tone: "text-muted-foreground", bg: "bg-muted" }
            const ini = initials(e.actor)
            return (
              <div
                key={i}
                className="flex items-start gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-muted/40"
              >
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", meta.bg)}>
                  <meta.icon className={cn("size-4", meta.tone)} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    <span className="inline-flex items-center gap-1 font-medium">
                      {ini ? (
                        <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                          {ini}
                        </span>
                      ) : (
                        <Bot className="size-3.5 text-muted-foreground" />
                      )}
                      {e.actor}
                    </span>{" "}
                    <span className={meta.tone}>{e.action}</span> {e.target}
                  </p>
                  {e.reason !== "—" && (
                    <p className="text-xs text-muted-foreground">Motivo: {e.reason}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs text-muted-foreground">{e.time}</span>
                  {e.conf != null && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      conf {e.conf}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
