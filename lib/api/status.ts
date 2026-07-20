import type { BackendJobStatus, BackendTask } from "@/lib/api/types"

export type UiJobStatus = "executando" | "na-fila" | "pausado" | "concluido" | "falhou" | "cancelado"

export function toUiJobStatus(status: BackendJobStatus): UiJobStatus {
  switch (status) {
    case "running":
      return "executando"
    case "queued":
      return "na-fila"
    case "paused":
      return "pausado"
    case "succeeded":
      return "concluido"
    case "failed":
      return "falhou"
    case "canceled":
      return "cancelado"
  }
}

export function formatPtNumber(value: number) {
  return value.toLocaleString("pt-BR")
}

export function formatDateTimePt(value: string | null | undefined) {
  if (!value) return "--"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "--"
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
}

export type ApiClassItem = { name: string; color: string; parent?: string; count?: number }

const fallbackPalette = [
  "oklch(0.65 0.18 25)",
  "oklch(0.6 0.15 300)",
  "oklch(0.7 0.14 160)",
  "oklch(0.68 0.16 70)",
  "oklch(0.62 0.17 220)",
  "oklch(0.58 0.16 145)",
]

export function labelsFromTasks(tasks: BackendTask[] | null | undefined): ApiClassItem[] {
  const byName = new Map<string, ApiClassItem>()
  for (const task of tasks ?? []) {
    for (const rawLabel of task.labels ?? []) {
      const label = rawLabel && typeof rawLabel === "object" ? (rawLabel as Record<string, unknown>) : null
      const name = String(label?.name ?? label?.label ?? rawLabel ?? "").trim()
      if (!name) continue
      const current = byName.get(name)
      byName.set(name, {
        name,
        color: String(label?.color ?? current?.color ?? fallbackPalette[byName.size % fallbackPalette.length]),
        count: (current?.count ?? 0) + 1,
      })
    }
  }
  return [...byName.values()]
}
