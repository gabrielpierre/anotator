"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AppShell } from "@/components/app/app-shell"
import { ProjectOverview } from "@/components/overview/project-overview"
import { useCurrentUser } from "@/lib/auth/user-context"

export default function Page() {
  const router = useRouter()
  const { authReady, isAuthenticated, isAdmin, projects } = useCurrentUser()
  const shouldChooseProject = authReady && isAuthenticated && isAdmin && projects.length === 0

  React.useEffect(() => {
    if (shouldChooseProject) router.replace("/projetos")
  }, [router, shouldChooseProject])

  if (shouldChooseProject) {
    return (
      <AppShell breadcrumb={[{ label: "Projetos" }]}>
        <div className="flex min-h-[50vh] items-center justify-center">
          <span className="sr-only">Abrindo projetos</span>
          <span className="size-8 animate-spin rounded-full border-2 border-border border-t-brand-blue" aria-hidden="true" />
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell breadcrumb={[{ label: "Projetos", href: "/projetos" }, { label: "Projeto atual" }]}>
      <ProjectOverview />
    </AppShell>
  )
}
