"use client"

import * as React from "react"
import Link from "next/link"
import { Plus, FolderKanban, HardDrive, Pencil, ArrowRight, FolderOpen, Users } from "lucide-react"
import { Card, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, ProgressBar } from "@/components/app/primitives"
import { AdminOnly } from "@/components/app/admin-only"
import { ProjectDialog, type ProjectDialogTarget } from "@/components/projects/project-dialog"
import { useCurrentUser, projectRecordFromBackend, type ProjectRecord } from "@/lib/auth/user-context"
import type { BackendProject } from "@/lib/api/types"

export function ProjectsView() {
  const { users, projects, addProject, updateProject } = useCurrentUser()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"create" | "edit">("create")
  const [editTarget, setEditTarget] = React.useState<ProjectDialogTarget | null>(null)

  const usersById = React.useMemo(() => new Map(users.map((user) => [user.id, user])), [users])

  const items = projects

  const totalQuota = items.reduce((total, item) => total + item.quotaGb, 0)
  const totalUsed = items.reduce((total, item) => total + item.usedGb, 0)
  const totalPercent = totalQuota > 0 ? Math.min(100, Math.round((totalUsed / totalQuota) * 100)) : 0

  function openCreate() {
    setDialogMode("create")
    setEditTarget(null)
    setDialogOpen(true)
  }

  function openEdit(item: ProjectRecord) {
    setDialogMode("edit")
    setEditTarget({
      id: item.id,
      name: item.name,
      storagePath: item.storagePath,
      quotaGb: item.quotaGb,
      annotatorIds: item.annotatorIds,
    })
    setDialogOpen(true)
  }

  function handleSaved(project: BackendProject, mode: "create" | "edit", annotatorIds: string[]) {
    // O contexto é a fonte única — sincroniza a lista compartilhada com a aba Usuários.
    const record = projectRecordFromBackend(project, annotatorIds)
    if (mode === "edit") {
      updateProject(project.id, { name: record.name, quotaGb: record.quotaGb, annotatorIds })
    } else {
      addProject({ ...record, annotatorIds })
    }
  }

  return (
    <AdminOnly>
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

              <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="size-3.5" />
                  Anotadores
                </span>
                {item.annotatorIds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">Nenhum</span>
                ) : (
                  <div className="flex items-center -space-x-2">
                    {item.annotatorIds.slice(0, 4).map((id) => {
                      const user = usersById.get(id)
                      if (!user) return null
                      return (
                        <Avatar
                          key={id}
                          name={user.name}
                          src={user.avatar}
                          size="sm"
                          className="ring-2 ring-card"
                          title={user.name}
                        />
                      )
                    })}
                    {item.annotatorIds.length > 4 && (
                      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-card">
                        +{item.annotatorIds.length - 4}
                      </span>
                    )}
                  </div>
                )}
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
    </AdminOnly>
  )
}
