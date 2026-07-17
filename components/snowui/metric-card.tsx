import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import { Card, type CardTone } from '@/components/snowui/card'
import { cn } from '@/lib/utils'

/**
 * SnowUI MetricCard. The KPI tile from the Overview grid: label, large value
 * and a signed delta with a directional arrow. `tone` sets the pastel fill so
 * a row of tiles alternates blue/purple for rhythm.
 */
export function MetricCard({
  label,
  value,
  delta,
  hint,
  trend = 'up',
  tone = 'blue',
  className,
}: {
  label: string
  value: string
  delta?: string
  hint?: string
  trend?: 'up' | 'down'
  tone?: CardTone
  className?: string
}) {
  const Arrow = trend === 'up' ? ArrowUpRight : ArrowDownRight
  return (
    <Card tone={tone} className={cn('flex flex-col gap-3 p-5', className)}>
      <span className="text-sm font-medium text-card-foreground">{label}</span>
      <div className="flex items-end justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {delta && (
          <span className="flex items-center gap-1 text-xs font-medium text-foreground">
            {delta}
            <Arrow className="size-3.5" />
          </span>
        )}
      </div>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Card>
  )
}
