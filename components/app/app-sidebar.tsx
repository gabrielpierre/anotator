"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { PanelLeft, PanelLeftClose, Plus } from "lucide-react"
import { Brand } from "@/components/app/brand"
import { adminNavEntries } from "@/components/app/nav-config"
import { Button } from "@/components/ui/button"
import { ProjectDialog } from "@/components/projects/project-dialog"
import { projectRecordFromBackend, useCurrentUser } from "@/lib/auth/user-context"
import type { BackendProject } from "@/lib/api/types"
import { cn } from "@/lib/utils"

export function AppSidebar({
  open = false,
  onClose,
}: {
  open?: boolean
  onClose?: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const {
    isAdmin,
    projects,
    activeProject,
    addProject,
    setActiveProjectId,
  } = useCurrentUser()
  const [collapsed, setCollapsed] = React.useState(false)
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false)
  const visibleAdminEntries = adminNavEntries.filter((item) => !item.adminOnly || isAdmin)

  function handleCreated(project: BackendProject, _mode: "create" | "edit", annotatorIds: string[]) {
    const record = projectRecordFromBackend(project, annotatorIds)
    void addProject({ ...record, annotatorIds }).then(() => {
      setActiveProjectId(project.id)
      router.push(`/?project=${encodeURIComponent(project.id)}`)
      onClose?.()
    })
  }

  return (
    <>
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden="true"
      />
      <aside
        onClick={collapsed ? () => setCollapsed(false) : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-[transform,width] duration-300 ease-in-out lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          collapsed ? "lg:w-16 lg:cursor-pointer" : "lg:w-64",
        )}
        aria-label={collapsed ? "Expandir navegação" : undefined}
      >
        <div
          className={cn(
            "flex h-16 items-center border-b border-sidebar-border px-4",
            collapsed ? "lg:justify-center lg:px-0" : "justify-between",
          )}
        >
          {collapsed ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setCollapsed(false)
              }}
              aria-label="Expandir navegação"
              aria-expanded={false}
              className="group relative hidden size-9 items-center justify-center rounded-lg hover:bg-sidebar-accent lg:inline-flex"
            >
              <span className="transition-opacity duration-200 group-hover:opacity-0">
                <Brand showWordmark={false} />
              </span>
              <PanelLeft className="absolute size-4.5 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:text-foreground" />
            </button>
          ) : (
            <Link href="/" aria-label="CVAT++ - Visão geral" className="hidden lg:block">
              <Brand showWordmark />
            </Link>
          )}
          <Link href="/" aria-label="CVAT++ - Visão geral" className="lg:hidden">
            <Brand showWordmark />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar navegação"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
          >
            <PanelLeftClose className="size-4.5" />
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Retrair navegação"
              aria-expanded={true}
              className="hidden size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:inline-flex"
            >
              <PanelLeftClose className="size-4.5" />
            </button>
          )}
        </div>

        <nav className={cn("flex flex-1 flex-col gap-5 overflow-y-auto p-3", collapsed && "lg:items-center")}>
          <section className="flex min-h-0 flex-1 flex-col gap-2">
            <div
              className={cn(
                "flex items-center justify-between px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground",
                collapsed && "lg:hidden",
              )}
            >
              <span>PROJETOS</span>
              <span className="tabular-nums">{projects.length}</span>
            </div>

            <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
              {projects.map((project) => {
                const active = activeProject?.id === project.id
                return (
                  <Link
                    key={project.id}
                    href={`/?project=${encodeURIComponent(project.id)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setActiveProjectId(project.id)
                      onClose?.()
                    }}
                    title={collapsed ? project.name : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                      collapsed && "lg:w-10 lg:justify-center lg:px-0",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-foreground hover:bg-sidebar-accent",
                    )}
                  >
                    <ProjectAvatar name={project.name} active={active} />
                    <span className={cn("min-w-0 flex-1 truncate", collapsed && "lg:hidden")}>{project.name}</span>
                  </Link>
                )
              })}

              {projects.length === 0 && (
                <div
                  className={cn(
                    "rounded-lg border border-dashed border-sidebar-border px-3 py-4 text-sm text-muted-foreground",
                    collapsed && "lg:hidden",
                  )}
                >
                  Nenhum projeto ativo.
                </div>
              )}
            </div>

            {isAdmin && (
              <Button
                type="button"
                variant="outline"
                size={collapsed ? "icon" : "sm"}
                className={cn("mt-1", collapsed ? "lg:size-10 lg:px-0" : "justify-start")}
                onClick={(event) => {
                  event.stopPropagation()
                  setProjectDialogOpen(true)
                }}
                title={collapsed ? "Novo projeto" : undefined}
              >
                <Plus className="size-4" />
                <span className={cn(collapsed && "lg:hidden")}>Novo projeto</span>
              </Button>
            )}
          </section>

          {visibleAdminEntries.length > 0 && (
            <section className="flex flex-col gap-1 border-t border-sidebar-border pt-3">
              <p
                className={cn(
                  "px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground",
                  collapsed && "lg:hidden",
                )}
              >
                ADMIN
              </p>
              {visibleAdminEntries.map((item) => {
                const active = pathname.startsWith(item.href)
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose?.()
                    }}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                      collapsed && "lg:w-10 lg:justify-center lg:px-0",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-foreground hover:bg-sidebar-accent",
                    )}
                  >
                    <Icon className="size-4.5 shrink-0" />
                    <span className={cn("min-w-0 flex-1 truncate", collapsed && "lg:hidden")}>{item.label}</span>
                  </Link>
                )
              })}
            </section>
          )}
        </nav>
      </aside>

      <ProjectDialog
        open={projectDialogOpen}
        mode="create"
        project={null}
        onClose={() => setProjectDialogOpen(false)}
        onSaved={handleCreated}
      />
    </>
  )
}

function ProjectAvatar({ name, active }: { name: string; active: boolean }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || "P"
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
        active ? "bg-brand-blue text-white" : "bg-surface-blue text-brand-blue",
      )}
    >
      {initial}
    </span>
  )
}
