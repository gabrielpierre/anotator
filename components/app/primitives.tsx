import * as React from "react"
import { cn } from "@/lib/utils"
import type { UiJobStatus } from "@/lib/api/status"

const statusMap: Record<
  UiJobStatus | "aprovado" | "em-construcao" | "publicado" | "arquivado",
  { label: string; dot: string; text: string; bg: string }
> = {
  executando: { label: "Executando", dot: "bg-brand-green", text: "text-brand-green", bg: "bg-brand-green/12" },
  "na-fila": { label: "Na fila", dot: "bg-warning", text: "text-warning", bg: "bg-warning/12" },
  pausado: { label: "Pausado", dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" },
  concluido: { label: "Concluído", dot: "bg-brand-green", text: "text-brand-green", bg: "bg-brand-green/12" },
  falhou: { label: "Falhou", dot: "bg-destructive", text: "text-destructive", bg: "bg-destructive/12" },
  cancelado: { label: "Cancelado", dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" },
  aprovado: { label: "Aprovado", dot: "bg-brand-green", text: "text-brand-green", bg: "bg-brand-green/12" },
  "em-construcao": { label: "Em construção", dot: "bg-warning", text: "text-warning", bg: "bg-warning/12" },
  publicado: { label: "Publicado", dot: "bg-brand-blue", text: "text-brand-blue", bg: "bg-surface-blue" },
  arquivado: { label: "Arquivado", dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" },
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: keyof typeof statusMap
  label?: string
  className?: string
}) {
  const s = statusMap[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        s.bg,
        s.text,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {label ?? s.label}
    </span>
  )
}

export function ProgressBar({
  value,
  className,
  color = "bg-brand-blue",
  track = "bg-muted",
  height = "h-1.5",
}: {
  value: number
  className?: string
  color?: string
  track?: string
  height?: string
}) {
  return (
    <span className={cn("block w-full overflow-hidden rounded-full", track, height, className)}>
      <span
        className={cn("block h-full rounded-full transition-all", color)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  )
}

export function Meter({
  label,
  value,
  detail,
  color = "bg-brand-blue",
}: {
  label: string
  value: number
  detail?: string
  color?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums text-foreground">{value}%</span>
      </div>
      <ProgressBar value={value} color={color} />
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  )
}

export function StatRow({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right font-medium tabular-nums text-foreground", valueClassName)}>
        {value}
      </span>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  className,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  badge?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
