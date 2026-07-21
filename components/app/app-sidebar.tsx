"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { PanelLeftClose, PanelLeft } from "lucide-react"
import { Brand } from "@/components/app/brand"
import { navEntries } from "@/components/app/nav-config"
import { fetchReviewQueueCount } from "@/lib/api/client"
import { useCurrentUser } from "@/lib/auth/user-context"
import { cn } from "@/lib/utils"

export function AppSidebar({
  open = false,
  onClose,
}: {
  open?: boolean
  onClose?: () => void
}) {
  const pathname = usePathname()
  const { isAdmin, projects } = useCurrentUser()
  const [collapsed, setCollapsed] = React.useState(false)
  const [reviewPendingCount, setReviewPendingCount] = React.useState<number | null>(null)
  const entries = navEntries.filter((item) => !item.adminOnly || isAdmin)

  const refreshReviewCount = React.useCallback((signal?: AbortSignal) => {
    fetchReviewQueueCount(signal)
      .then((summary) => setReviewPendingCount(summary.pending))
      .catch(() => {
        if (!signal?.aborted) setReviewPendingCount(null)
      })
  }, [])

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
            /* Símbolo que revela o botão de expandir ao passar o mouse (desktop) */
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
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
            <Link href="/" aria-label="CVAT++ — Visão geral" className="hidden lg:block">
              <Brand showWordmark />
            </Link>
          )}
          {/* Símbolo/logo no mobile (drawer) */}
          <Link href="/" aria-label="CVAT++ — Visão geral" className="lg:hidden">
            <Brand showWordmark />
          </Link>
          {/* Fechar (mobile) */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar navegação"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
          >
            <PanelLeftClose className="size-4.5" />
          </button>
          {/* Retrair (desktop, apenas quando expandido) */}
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

        <nav className={cn("flex flex-1 flex-col gap-1 overflow-y-auto p-3", collapsed && "lg:items-center")}>
          <p
            className={cn(
              "px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground transition-opacity",
              collapsed && "lg:hidden",
            )}
          >
            NAVEGAÇÃO
          </p>
          {entries.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
            const Icon = item.icon
            const href = item.href === "/" && isAdmin && projects.length === 0 ? "/projetos" : item.href
            const badge = item.href === "/revisar" ? reviewPendingCount : item.badge
            return (
              <Link
                key={item.href}
                href={href}
                onClick={(e) => {
                  // Evita que o clique no link também dispare a expansão da barra retraída.
                  e.stopPropagation()
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
                <span className={cn("flex-1 truncate", collapsed && "lg:hidden")}>{item.label}</span>
                {badge != null && badge > 0 && (
                  <span
                    className={cn(
                      "rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium tabular-nums text-warning",
                      collapsed && "lg:hidden",
                    )}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
