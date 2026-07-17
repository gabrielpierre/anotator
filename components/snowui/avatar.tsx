import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * SnowUI Avatar. Circular, soft-tinted container for a user image or initials.
 * Sizes map to the icon scale used throughout the app (sm 24, md 32, lg 40).
 */
const sizeClass = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const

function Avatar({
  className,
  size = 'md',
  src,
  name,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  size?: keyof typeof sizeClass
  src?: string
  name: string
}) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <span
      data-slot="avatar"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground',
        sizeClass[size],
        className,
      )}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src || '/placeholder.svg'} alt={name} className="size-full object-cover" />
      ) : (
        initials
      )}
    </span>
  )
}

export { Avatar }
