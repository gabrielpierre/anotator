import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * SnowUI list primitives. Compose feeds and contact lists:
 * - ListSection: labelled group
 * - ListItem: leading slot (icon tile or avatar) + title + optional meta
 * - IconTile: soft-tinted square that holds a small glyph
 */
export function ListSection({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('flex flex-col gap-1', className)}>
      <h3 className="px-2 py-1 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

export function ListItem({
  leading,
  title,
  meta,
  className,
}: {
  leading: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-muted',
        className,
      )}
    >
      <span className="shrink-0">{leading}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{title}</span>
        {meta && (
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        )}
      </span>
    </div>
  )
}

const tileTone = {
  blue: 'bg-surface-blue',
  purple: 'bg-surface-purple',
  mint: 'bg-surface-mint',
  subtle: 'bg-muted',
} as const

export function IconTile({
  tone = 'blue',
  className,
  children,
}: {
  tone?: keyof typeof tileTone
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg text-foreground [&_svg]:size-4',
        tileTone[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
