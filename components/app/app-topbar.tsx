"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Menu, Bell, HelpCircle, ChevronDown, Activity, UserCog, LogOut } from "lucide-react"
import { ThemeToggle } from "@/components/snowui/theme-toggle"
import { Avatar } from "@/components/snowui/avatar"
import { projectNavEntries } from "@/components/app/nav-config"
import { fetchJobs, fetchReviewQueueCount, jobsEventsUrl } from "@/lib/api/client"
import type { BackendJob } from "@/lib/api/types"
import { useCurrentUser, roleLabels } from "@/lib/auth/user-context"
import { cn } from "@/lib/utils"

export type Crumb = { label: string; href?: string }

export function AppTopbar({
  breadcrumb,
  onMenuClick,
}: {
  breadcrumb: Crumb[]
  onMenuClick?: () => void
}) {
  const pathname = usePathname()
  const [activeJobCount, setActiveJobCount] = React.useState(0)
  const [reviewPendingCount, setReviewPendingCount] = React.useState<number | null>(null)
  const { currentUser, logout, activeProject, projects, isAdmin, setActiveProjectId } = useCurrentUser()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const jobProjectId = isAdmin ? null : activeProject?.id ?? projects[0]?.id ?? null
  const projectRoute = isProjectRoute(pathname)
  const activeProjectExternalId = activeProject?.externalId ?? null

  React.useEffect(() => {
    if (!menuOpen) return
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [menuOpen])

  React.useEffect(() => {
    const controller = new AbortController()
    fetchJobs({ projectId: jobProjectId }, controller.signal)
      .then((jobs) => setActiveJobCount(countActiveJobs(jobs)))
      .catch(() => setActiveJobCount(0))
    return () => controller.abort()
  }, [jobProjectId])

  React.useEffect(() => {
    const source = new EventSource(jobsEventsUrl({ projectId: jobProjectId }))
    const handleJobs = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { jobs?: BackendJob[] }
        if (Array.isArray(payload.jobs)) setActiveJobCount(countActiveJobs(payload.jobs))
      } catch {
        // Ignore malformed stream events; the next snapshot will replace state.
      }
    }
    source.addEventListener("jobs", handleJobs as EventListener)
    source.onerror = () => source.close()
    return () => source.close()
  }, [jobProjectId])

  const refreshReviewCount = React.useCallback((signal?: AbortSignal) => {
    if (!activeProjectExternalId) {
      setReviewPendingCount(null)
      return
    }
    fetchReviewQueueCount({ projectExternalId: activeProjectExternalId }, signal)
      .then((summary) => setReviewPendingCount(summary.pending))
      .catch(() => {
        if (!signal?.aborted) setReviewPendingCount(null)
      })
  }, [activeProjectExternalId])

  React.useEffect(() => {
    const controller = new AbortController()
    refreshReviewCount(controller.signal)
    const interval = window.setInterval(() => refreshReviewCount(), 30_000)
    const onFocus = () => refreshReviewCount()
    const onReviewQueueUpdated = () => refreshReviewCount()
    window.addEventListener("focus", onFocus)
    window.addEventListener("review-queue-updated", onReviewQueueUpdated)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("review-queue-updated", onReviewQueueUpdated)
    }
  }, [refreshReviewCount])

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Abrir navegação"
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      {projectRoute ? (
        <ProjectTabs
          pathname={pathname}
          projectId={activeProject?.id ?? null}
          projectName={activeProject?.name ?? null}
          reviewPendingCount={reviewPendingCount}
          onSelectProject={setActiveProjectId}
        />
      ) : (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
          {breadcrumb.map((crumb, i) => {
            const last = i === breadcrumb.length - 1
            return (
              <span key={crumb.label} className="flex min-w-0 items-center gap-2">
                {i > 0 && <span className="text-muted-foreground/60">/</span>}
                {crumb.href && !last ? (
                  <Link
                    href={crumb.href}
                    className="truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      "truncate",
                      last ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {crumb.label}
                  </span>
                )}
              </span>
            )
          })}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <Link
          href={jobProjectId ? `/jobs?project=${encodeURIComponent(jobProjectId)}` : "/jobs"}
          className="hidden items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-muted sm:inline-flex"
        >
          <Activity className="size-4 text-brand-green" />
          <span className="font-medium">Jobs ativos</span>
          <span className="rounded-full bg-surface-blue px-1.5 text-xs font-medium text-brand-blue">
            {activeJobCount}
          </span>
        </Link>

        <ThemeToggle />

        <button
          type="button"
          aria-label="Ajuda"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <HelpCircle className="size-4.5" />
        </button>
        <button
          type="button"
          aria-label="Notificações"
          className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Bell className="size-4.5" />
        </button>

        <div className="relative ml-1" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Menu do usuário"
            className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-muted"
          >
            <Avatar name={currentUser.name} src={currentUser.avatar} size="md" />
            <span className="hidden flex-col items-start leading-tight sm:flex">
              <span className="text-sm font-medium text-foreground">{currentUser.name}</span>
              <span className="text-xs text-muted-foreground">{roleLabels[currentUser.role]}</span>
            </span>
            <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
            >
              <div className="flex items-center gap-3 border-b border-border p-3">
                <Avatar name={currentUser.name} src={currentUser.avatar} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{currentUser.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
                </div>
              </div>
              <div className="border-b border-border p-1.5">
                <Link
                  href="/perfil"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
                >
                  <UserCog className="size-4 text-muted-foreground" />
                  Meu perfil
                </Link>
              </div>
              <div className="border-t border-border p-1.5">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void logout()
                    router.replace("/login")
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
                >
                  <LogOut className="size-4" />
                  Sair
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function countActiveJobs(jobs: BackendJob[]) {
  return jobs.filter((job) => job.status === "running" || job.status === "queued").length
}

function ProjectTabs({
  pathname,
  projectId,
  projectName,
  reviewPendingCount,
  onSelectProject,
}: {
  pathname: string
  projectId: string | null
  projectName: string | null
  reviewPendingCount: number | null
  onSelectProject: (projectId: string | null) => void
}) {
  if (!projectId || !projectName) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Link href="/projetos" className="rounded-full border border-border px-3 py-1.5 font-medium text-foreground hover:bg-muted">
          Nenhum projeto
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-3">
      <Link
        href={`/?project=${encodeURIComponent(projectId)}`}
        onClick={() => onSelectProject(projectId)}
        className="hidden max-w-56 truncate rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted md:block"
        title={projectName}
      >
        {projectName}
      </Link>
      <nav aria-label="Navegação do projeto" className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-full bg-muted p-1">
        {projectNavEntries.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`)
          const Icon = item.icon
          const badge = item.href === "/revisar" ? reviewPendingCount : null
          return (
            <Link
              key={item.href}
              href={projectTabHref(item.href, projectId)}
              onClick={() => onSelectProject(projectId)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
                active
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
              {badge != null && badge > 0 && (
                <span className="rounded-full bg-warning/15 px-1.5 text-xs font-medium tabular-nums text-warning">
                  {badge}
                </span>
              )}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

function projectTabHref(href: string, projectId: string) {
  const query = `project=${encodeURIComponent(projectId)}`
  return href === "/" ? `/?${query}` : `${href}?${query}`
}

function isProjectRoute(pathname: string) {
  return projectNavEntries.some((item) =>
    item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`),
  )
}
