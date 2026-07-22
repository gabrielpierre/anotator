"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ArrowRight,
  Database,
  FolderKanban,
  FolderOpen,
  HardDrive,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react"
import { Card, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader, ProgressBar } from "@/components/app/primitives"
import { AdminOnly } from "@/components/app/admin-only"
import { ImportDatasetDialog } from "@/components/data/import-dataset-dialog"
import { ProjectDialog, type ProjectDialogTarget } from "@/components/projects/project-dialog"
import { useCurrentUser, projectRecordFromBackend, type ProjectRecord } from "@/lib/auth/user-context"
import type { BackendProject } from "@/lib/api/types"

export function ProjectsView() {
  const router = useRouter()
  const { users, projects, addProject, updateProject, removeProject, setActiveProjectId } = useCurrentUser()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"create" | "edit">("create")
  const [editTarget, setEditTarget] = React.useState<ProjectDialogTarget | null>(null)
  const [datasetImportOpen, setDatasetImportOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<ProjectRecord | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

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
      void updateProject(project.id, {
        name: record.name,
        storagePath: record.storagePath,
        quotaGb: record.quotaGb,
        annotatorIds,
      })
    } else {
      void addProject({ ...record, annotatorIds })
    }
  }

  async function confirmDeleteProject() {
    if (!deleteTarget) return
    setDeleteSubmitting(true)
    setDeleteError(null)
    try {
      await removeProject(deleteTarget.id)
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Nao foi possivel excluir o projeto.")
    } finally {
      setDeleteSubmitting(false)
    }
  }

  return (
    <AdminOnly>
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Projetos"
        subtitle="Gerencie os projetos de anotação, o storage reservado e os acessos da equipe."
        actions={
          <>
            <Button size="lg" variant="outline" onClick={() => setDatasetImportOpen(true)}>
              <Database className="size-4" />
              Importar dataset
            </Button>
            <Button size="lg" onClick={openCreate}>
              <Plus className="size-4" />
              Novo projeto
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Projetos" value={String(items.length)} hint="projetos ativos" tone="blue" />
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
      <ImportDatasetDialog
        open={datasetImportOpen}
        onClose={() => setDatasetImportOpen(false)}
        onImported={(_, projectId) => {
          setDatasetImportOpen(false)
          if (projectId) {
            setActiveProjectId(projectId)
            router.push(`/dados?project=${encodeURIComponent(projectId)}`)
          }
        }}
      />
      <DeleteProjectDialog
        project={deleteTarget}
        submitting={deleteSubmitting}
        error={deleteError}
        onClose={() => {
          if (deleteSubmitting) return
          setDeleteTarget(null)
          setDeleteError(null)
        }}
        onConfirm={confirmDeleteProject}
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
            <Link
              key={item.id}
              href={`/?project=${encodeURIComponent(item.id)}`}
              onClick={() => setActiveProjectId(item.id)}
              className="group block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={`Abrir visão geral de ${item.name}`}
            >
              <Card className="flex flex-col gap-4 transition-colors group-hover:bg-muted/30">
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
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openEdit(item)
                      }}
                      aria-label={`Editar ${item.name}`}
                    >
                      <Pencil className="size-4" />
                      Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setDeleteTarget(item)
                        setDeleteError(null)
                      }}
                      aria-label={`Excluir ${item.name}`}
                    >
                      <Trash2 className="size-4" />
                      Excluir
                    </Button>
                  </div>
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
                  className="pointer-events-none justify-between"
                >
                  Abrir visão geral
                  <ArrowRight className="size-4" />
                </Button>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
    </AdminOnly>
  )
}

function DeleteProjectDialog({
  project,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  project: ProjectRecord | null
  submitting: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  if (!project) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Excluir projeto ${project.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">Excluir projeto</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              O projeto <span className="font-medium text-foreground">{project.name}</span> sairá da lista e os acessos dos anotadores serão removidos.
            </p>
          </div>
        </div>
        <div className="p-5">
          <p className="text-sm text-muted-foreground">
            Os registros vinculados ficam preservados no banco para auditoria.
          </p>
          {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="button" onClick={onConfirm} disabled={submitting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Excluir
          </Button>
        </div>
      </div>
    </div>
  )
}
