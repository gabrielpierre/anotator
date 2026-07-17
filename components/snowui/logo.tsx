import { cn } from '@/lib/utils'

/**
 * SnowUI brand mark: a six-point snowflake glyph paired with the wordmark.
 * Use `showWordmark={false}` for compact placements (collapsed nav, favicons).
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Snowflake className="size-6 text-brand-blue" />
      {showWordmark && (
        <span className="text-lg font-semibold tracking-tight text-foreground">
          SnowUI
        </span>
      )}
    </span>
  )
}

export function Snowflake({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2v20" />
      <path d="M3.34 7 20.66 17" />
      <path d="M20.66 7 3.34 17" />
      <path d="M12 6 9.6 4.4M12 6l2.4-1.6" />
      <path d="M12 18l-2.4 1.6M12 18l2.4 1.6" />
      <path d="m5.9 8.5-2.8.2M5.9 8.5 5.6 5.7" />
      <path d="m18.1 8.5 2.8.2M18.1 8.5l.3-2.8" />
      <path d="m5.9 15.5-2.8-.2M5.9 15.5l-.3 2.8" />
      <path d="m18.1 15.5 2.8-.2M18.1 15.5l.3 2.8" />
    </svg>
  )
}
