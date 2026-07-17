"use client"

import Link from "next/link"
import { Menu, Bell, HelpCircle, ChevronDown, Activity } from "lucide-react"
import { ThemeToggle } from "@/components/snowui/theme-toggle"
import { Avatar } from "@/components/snowui/avatar"
import { activeJobs } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export type Crumb = { label: string; href?: string }

export function AppTopbar({
  breadcrumb,
  onMenuClick,
}: {
  breadcrumb: Crumb[]
  onMenuClick?: () => void
}) {
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
            {activeJobs.length}
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

        <button
          type="button"
          className="ml-1 flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-muted"
        >
          <Avatar name="Gabriel" src="/operator-avatar.png" size="md" />
          <span className="hidden flex-col items-start leading-tight sm:flex">
            <span className="text-sm font-medium text-foreground">Gabriel</span>
            <span className="text-xs text-muted-foreground">admin</span>
          </span>
          <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
        </button>
      </div>
    </header>
  )
}
