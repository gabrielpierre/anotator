import { cn } from "@/lib/utils"

/**
 * Marca CVAT++ — glifo circular em tom mint/sky sobre a wordmark.
 * Use showWordmark={false} para placements compactos.
 */
export function Brand({
  className,
  showWordmark = true,
}: {
  className?: string
  showWordmark?: boolean
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark className="size-8 text-brand-mint" />
      {showWordmark && (
        <span className="text-lg font-semibold tracking-tight text-foreground">
          CVAT<span className="text-brand-mint">++</span>
        </span>
      )}
    </span>
  )
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <circle
        cx="16"
        cy="16"
        r="14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="44 88"
      />
      <circle cx="16" cy="16" r="4.5" fill="currentColor" />
    </svg>
  )
}
