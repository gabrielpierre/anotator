import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * SnowUI Input. Rounded, soft-filled text field. Pass `icon` to render a
 * leading glyph (e.g. search) and optional `trailing` for shortcuts/badges.
 */
function Input({
  className,
  icon,
  trailing,
  ...props
}: React.ComponentProps<'input'> & {
  icon?: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'flex h-9 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-foreground transition-colors focus-within:ring-2 focus-within:ring-ring/50',
        className,
      )}
    >
      {icon && (
        <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      )}
      <input
        data-slot="input"
        className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
        {...props}
      />
      {trailing && <span className="shrink-0">{trailing}</span>}
    </label>
  )
}

export { Input }
