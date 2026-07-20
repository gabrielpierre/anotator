"use client"

import * as React from "react"
import Link from "next/link"
import { Menu, Bell, HelpCircle, ChevronDown, Activity, Check, ShieldCheck } from "lucide-react"
import { ThemeToggle } from "@/components/snowui/theme-toggle"
import { Avatar } from "@/components/snowui/avatar"
import { activeJobs } from "@/lib/mock-data"
import { fetchJobs, mockFallbackEnabled } from "@/lib/api/client"
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
  const useMocks = mockFallbackEnabled()
  const [activeJobCount, setActiveJobCount] = React.useState(useMocks ? activeJobs.length : 0)
  const { currentUser, users, switchUser } = useCurrentUser()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)

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
    fetchJobs(controller.signal)
      .then((jobs) =>
        setActiveJobCount(jobs.filter((job) => job.status === "running" || job.status === "queued").length),
      )
      .catch(() => setActiveJobCount(useMocks ? activeJobs.length : 0))
    return () => controller.abort()
  }, [useMocks])

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

      <div className="ml-auto flex items-center gap-1.5">
        <Link
          href="/jobs"
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
          <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
            2
          </span>
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
              <div className="p-1.5">
                <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
                  <ShieldCheck className="size-3.5" />
                  Trocar de perfil
                </p>
                {users.map((user) => {
                  const active = user.id === currentUser.id
                  return (
                    <button
                      key={user.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        switchUser(user.id)
                        setMenuOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                        active && "bg-muted",
                      )}
                    >
                      <Avatar name={user.name} src={user.avatar} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate font-medium text-foreground">{user.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{roleLabels[user.role]}</span>
                      </span>
                      {active && <Check className="size-4 text-brand-blue" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
