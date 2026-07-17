'use client'

import * as React from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Logo } from '@/components/snowui/logo'
import { cn } from '@/lib/utils'

/**
 * SnowUI Sidebar. Left navigation rail: brand header, grouped sections and
 * nav items with optional nesting. Fixed-width on desktop; on mobile it
 * renders as a slide-over controlled by `open` / `onClose`.
 */
export type NavItem = {
  label: string
  icon?: LucideIcon
  active?: boolean
  children?: { label: string }[]
}

export type NavSection = {
  title?: string
  items: NavItem[]
}

export function Sidebar({
  sections,
  open = false,
  onClose,
  className,
}: {
  sections: NavSection[]
  open?: boolean
  onClose?: () => void
  className?: string
}) {
  return (
    <>
      {/* mobile scrim */}
      <div
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-hidden="true"
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-4 transition-transform lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
          className,
        )}
      >
        <div className="flex items-center gap-2 px-2 pt-1">
          <Logo />
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto">
          {sections.map((section, i) => (
            <div key={section.title ?? i} className="flex flex-col gap-1">
              {section.title && (
                <p className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  {section.title}
                </p>
              )}
              {section.items.map((item) => (
                <NavRow key={item.label} item={item} />
              ))}
            </div>
          ))}
        </nav>
      </aside>
    </>
  )
}

function NavRow({ item }: { item: NavItem }) {
  const [expanded, setExpanded] = React.useState(false)
  const Icon = item.icon
  const hasChildren = !!item.children?.length

  return (
    <div>
      <button
        type="button"
        onClick={() => hasChildren && setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
          item.active
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-foreground hover:bg-sidebar-accent',
        )}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        {Icon && <Icon className="size-4.5 shrink-0" />}
        <span className="truncate">{item.label}</span>
      </button>

      {hasChildren && expanded && (
        <div className="mt-1 flex flex-col gap-1 pl-9">
          {item.children!.map((child) => (
            <button
              key={child.label}
              type="button"
              className="flex items-center rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
