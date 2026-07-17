"use client"

import * as React from "react"
import { AppSidebar } from "@/components/app/app-sidebar"
import { AppTopbar, type Crumb } from "@/components/app/app-topbar"

export function AppShell({
  breadcrumb,
  children,
}: {
  breadcrumb: Crumb[]
  children: React.ReactNode
}) {
  const [navOpen, setNavOpen] = React.useState(false)

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
