"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AppSidebar } from "@/components/app/app-sidebar"
import { AppTopbar, type Crumb } from "@/components/app/app-topbar"
import { useCurrentUser } from "@/lib/auth/user-context"

export function AppShell({
  breadcrumb,
  children,
}: {
  breadcrumb: Crumb[]
  children: React.ReactNode
}) {
  return (
    <React.Suspense fallback={<AppShellLoading />}>
      <AppShellInner breadcrumb={breadcrumb}>{children}</AppShellInner>
    </React.Suspense>
  )
}

function AppShellInner({
  breadcrumb,
  children,
}: {
  breadcrumb: Crumb[]
  children: React.ReactNode
}) {
  const [navOpen, setNavOpen] = React.useState(false)
  const searchParams = useSearchParams()
  const { isAuthenticated, authReady, activeProject, projects, setActiveProjectId } = useCurrentUser()
  const router = useRouter()
  const currentProjectName = activeProject?.name ?? "Nenhum projeto"
  const resolvedBreadcrumb = breadcrumb.map((crumb) =>
    crumb.label === "Projeto atual" ? { ...crumb, label: currentProjectName } : crumb,
  )

  // Rotas do painel exigem sessão ativa — redireciona para o login caso contrário.
  // Aguarda a reidratação da sessão para não redirecionar prematuramente.
  React.useEffect(() => {
    if (authReady && !isAuthenticated) router.replace("/login")
  }, [authReady, isAuthenticated, router])

  React.useEffect(() => {
    const requestedProjectId = searchParams.get("project")
    if (!requestedProjectId) return
    if (!projects.some((project) => project.id === requestedProjectId)) return
    if (activeProject?.id === requestedProjectId) return
    setActiveProjectId(requestedProjectId)
  }, [activeProject?.id, projects, searchParams, setActiveProjectId])

  if (!authReady || !isAuthenticated) {
    return <AppShellLoading />
  }

  return (
    <div className="flex min-h-svh bg-background">
      <AppSidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar breadcrumb={resolvedBreadcrumb} onMenuClick={() => setNavOpen(true)} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}

function AppShellLoading() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <span className="sr-only">Redirecionando para o login</span>
      <span className="size-8 animate-spin rounded-full border-2 border-border border-t-brand-blue" aria-hidden="true" />
    </div>
  )
}
