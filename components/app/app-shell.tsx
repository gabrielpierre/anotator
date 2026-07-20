"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
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
  const [navOpen, setNavOpen] = React.useState(false)
  const { isAuthenticated } = useCurrentUser()
  const router = useRouter()

  // Rotas do painel exigem sessão ativa — redireciona para o login caso contrário.
  React.useEffect(() => {
    if (!isAuthenticated) router.replace("/login")
  }, [isAuthenticated, router])

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <span className="sr-only">Redirecionando para o login</span>
        <span className="size-8 animate-spin rounded-full border-2 border-border border-t-brand-blue" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div className="flex min-h-svh bg-background">
      <AppSidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar breadcrumb={breadcrumb} onMenuClick={() => setNavOpen(true)} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
