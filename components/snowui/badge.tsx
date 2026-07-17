import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * SnowUI Badge. Small, pill-shaped status/trend indicator. Trend variants
 * (up/down) pair a soft tint with a saturated foreground for deltas like
 * "+11.01%" on metric tiles.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground',
        up: 'bg-success/15 text-success',
        down: 'bg-destructive/12 text-destructive',
        info: 'bg-surface-blue text-brand-blue',
        accent: 'bg-surface-purple text-brand-indigo',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
