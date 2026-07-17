'use client'

import { Bell, Clock, Menu, PanelLeft, Search, Star } from 'lucide-react'
import { Input } from '@/components/snowui/input'
import { ThemeToggle } from '@/components/snowui/theme-toggle'
import { cn } from '@/lib/utils'

/**
 * SnowUI Topbar. Sticky page header: mobile menu trigger, breadcrumb,
 * global search and a cluster of utility actions (theme, history, alerts).
 */
export function Topbar({
  breadcrumb,
  onMenuClick,
  className,
}: {
  breadcrumb: string[]
  onMenuClick?: () => void
  className?: string
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6',
        className,
      )}
    >
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>

      <button
        type="button"
        aria-label="Toggle sidebar"
        className="hidden size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:inline-flex"
      >
        <PanelLeft className="size-4.5" />
      </button>
      <button
        type="button"
        aria-label="Favorite"
        className="hidden size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
      >
        <Star className="size-4.5" />
      </button>

      <nav aria-label="Breadcrumb" className="hidden items-center gap-2 text-sm sm:flex">
        {breadcrumb.map((crumb, i) => (
          <span key={crumb} className="flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground">/</span>}
            <span
              className={
                i === breadcrumb.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              }
            >
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <Input
          icon={<Search />}
          placeholder="Search"
          className="hidden w-56 md:flex"
          trailing={
            <kbd className="rounded bg-background px-1.5 text-xs text-muted-foreground">
              /
            </kbd>
          }
        />
        <ThemeToggle />
        <button
          type="button"
          aria-label="History"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Clock className="size-4.5" />
        </button>
        <button
          type="button"
          aria-label="Notifications"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Bell className="size-4.5" />
        </button>
      </div>
    </header>
  )
}
