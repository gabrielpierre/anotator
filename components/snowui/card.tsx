import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * SnowUI Card / Panel. The core surface primitive: rounded-2xl, hairline
 * border, generous padding. `tone` swaps the fill for a brand pastel
 * (used by metric tiles and highlighted panels).
 */
const toneClass = {
  default: 'bg-card',
  subtle: 'bg-surface-subtle border-transparent',
  blue: 'bg-surface-blue border-transparent',
  purple: 'bg-surface-purple border-transparent',
  mint: 'bg-surface-mint border-transparent',
} as const

export type CardTone = keyof typeof toneClass

function Card({
  className,
  tone = 'default',
  ...props
}: React.ComponentProps<'div'> & { tone?: CardTone }) {
  return (
    <div
      data-slot="card"
      className={cn(
        'rounded-2xl border p-6 text-card-foreground',
        toneClass[tone],
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('mb-4 flex items-center justify-between gap-3', className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      data-slot="card-title"
      className={cn('text-sm font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn(className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardContent }
