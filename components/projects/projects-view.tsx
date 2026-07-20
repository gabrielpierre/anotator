"use client"

import * as React from "react"
import Link from "next/link"
import { Plus, FolderKanban, HardDrive, Pencil, ArrowRight, FolderOpen } from "lucide-react"
import { Card, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, ProgressBar } from "@/components/app/primitives"
import { ProjectDialog, type ProjectDialogTarget } from "@/components/projects/project-dialog"
import { fetchProjects, mockFallbackEnabled } from "@/lib/api/client"
import { formatDateTimePt } from "@/lib/api/status"
import type { BackendProject } from "@/lib/api/types"

type ProjectItem = {
  id: string
  name: string
  status: string
  storagePath: string
  quotaGb: number
  usedGb: number
  percent: number
  createdAt: string
}

const mockProjects: ProjectItem[] = [
  {
    id: "veiculos-cityscapes",
    name: "Veículos - Cityscapes",
    status: "active",
    storagePath: "D:\\datasets\\cityscapes",
    quotaGb: 200,
    usedGb: 128.6,
    percent: 64,
    createdAt: "01/06/2024 09:12",
  },
  {
    id: "rodovia-2026",
    name: "Rodovia - Tráfego 2026",
    status: "active",
    storagePath: "D:\\datasets\\rodovia-2026",
    quotaGb: 100,
    usedGb: 42.3,
    percent: 42,
    createdAt: "28/06/2024 15:40",
  },
  {
    id: "pedestres-noturno",
    name: "Pedestres - Cenas Noturnas",
    status: "active",
    storagePath: "D:\\datasets\\pedestres-noturno",
    quotaGb: 60,
    usedGb: 12.8,
    percent: 21,
    createdAt: "10/07/2024 11:05",
  },
]

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toProjectItem(project: BackendProject): ProjectItem {
  const storage = (project.raw?.storage ?? {}) as Record<string, unknown>
  const quotaGb = numberFromUnknown(storage.quota_gb) ?? 0
  const usedBytes = numberFromUnknown(storage.used_bytes) ?? 0
  const usedGb = usedBytes / 1024 ** 3
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    storagePath: String(storage.path ?? "--"),
    quotaGb,
    usedGb,
    percent: quotaGb > 0 ? Math.min(100, Math.round((usedGb / quotaGb) * 100)) : 0,
    createdAt: formatDateTimePt(project.created_at),
  }
}

export function ProjectsView() {
  const useMocks = mockFallbackEnabled()
  const [projects, setProjects] = React.useState<ProjectItem[] | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"create" | "edit">("create")
  const [editTarget, setEditTarget] = React.useState<ProjectDialogTarget | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchProjects(controller.signal)
      .then((data) => setProjects(data.map(toProjectItem)))
      .catch(() => setProjects(null))
    return () => controller.abort()
  }, [])

  const items = projects && projects.length > 0 ? projects : useMocks ? mockProjects : []

  const totalQuota = items.reduce((total, item) => total + item.quotaGb, 0)
  const totalUsed = items.reduce((total, item) => total + item.usedGb, 0)
  const totalPercent = totalQuota > 0 ? Math.min(100, Math.round((totalUsed / totalQuota) * 100)) : 0

  function openCreate() {
    setDialogMode("create")
    setEditTarget(null)
    setDialogOpen(true)
  }

  function openEdit(item: ProjectItem) {
    setDialogMode("edit")
    setEditTarget({ id: item.id, name: item.name, storagePath: item.storagePath, quotaGb: item.quotaGb })
    setDialogOpen(true)
  }

  function handleSaved(project: BackendProject, mode: "create" | "edit") {
    const next = toProjectItem(project)
    setProjects((current) => {
      const base = current ?? (useMocks ? mockProjects : [])
      if (mode === "edit") {
        return base.map((item) => (item.id === next.id ? { ...item, ...next } : item))
      }
      return [next, ...base]
    })
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Projetos"
        subtitle="Gerencie os projetos de anotação, o storage reservado e crie novos datasets."
        actions={
          <Button size="lg" onClick={openCreate}>
            <Plus className="size-4" />
            Novo projeto
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Projetos" value={String(items.length)} hint="datasets ativos" tone="blue" />
        <MetricCard
          label="Memória reservada"
          value={`${Math.round(totalQuota)} GB`}
          hint="soma dos limites"
          tone="purple"
        />
        <MetricCard
          label="Memória em uso"
          value={`${totalUsed.toFixed(1)} GB`}
          hint={`${totalPercent}% do total reservado`}
          tone="mint"
        />
      </div>

      <ProjectDialog
        open={dialogOpen}
        mode={dialogMode}
        project={editTarget}
        onClose={() => setDialogOpen(false)}
        onSaved={handleSaved}
      />

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
              <FolderKanban className="size-6" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-base font-medium text-foreground">Nenhum projeto ainda</p>
              <p className="text-sm text-muted-foreground text-pretty">
                Crie seu primeiro projeto para começar a importar e anotar imagens.
              </p>
            </div>
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              Criar projeto
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Card key={item.id} className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                    <FolderKanban className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold tracking-tight text-foreground">{item.name}</h2>
                    <p className="text-xs text-muted-foreground">Criado em {item.createdAt}</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => openEdit(item)} aria-label={`Editar ${item.name}`}>
                  <Pencil className="size-4" />
                  Editar
                </Button>
              </div>

              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <FolderOpen className="size-4 shrink-0" />
                <span className="truncate" title={item.storagePath}>
                  {item.storagePath}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <HardDrive className="size-3.5" />
                    Memória
                  </span>
                  <span className="font-medium tabular-nums text-foreground">
                    {item.usedGb.toFixed(1)} / {item.quotaGb} GB
                  </span>
                </div>
                <ProgressBar
                  value={item.percent}
                  color={item.percent >= 85 ? "bg-warning" : "bg-brand-blue"}
                />
              </div>

              <Button
                variant="ghost"
                className="justify-between"
                nativeButton={false}
                render={<Link href="/" />}
              >
                Abrir visão geral
                <ArrowRight className="size-4" />
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
