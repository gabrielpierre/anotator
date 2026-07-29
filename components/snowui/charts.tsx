'use client'

import * as React from 'react'
import {
  Area,
  AreaChart as ReAreaChart,
  Bar,
  BarChart as ReBarChart,
  Cell,
  Pie,
  PieChart as RePieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

/**
 * SnowUI charts. Thin recharts wrappers pre-styled with SnowUI data tokens
 * (the raw --chart-* / --brand-* CSS variables). All are responsive via
 * ResponsiveContainer and inherit theme colors from CSS variables.
 */

/*
  NOTE: chart colors reference the raw :root token variables (--chart-*,
  --brand-*) rather than the Tailwind `--color-*` aliases. Tailwind v4's
  `@theme inline` inlines `--color-*` into utility classes and does not emit
  them as runtime CSS variables, so `var(--color-*)` would not resolve here.
*/
const axisProps = {
  stroke: 'oklch(from var(--foreground) l c h / 0.4)',
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const

const formatCompact = (value: number) =>
  value >= 1000 ? `${value / 1000}K` : `${value}`

const formatNumberPt = (value: number) => value.toLocaleString('pt-BR')

const formatPercentPt = (value: number) =>
  value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

export function AreaTrendChart({
  data,
  height = 260,
}: {
  data: { label: string; current: number; previous: number }[]
  height?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReAreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="snowui-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-5)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--chart-5)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} width={48} tickFormatter={formatCompact} />
        <Area
          type="monotone"
          dataKey="previous"
          stroke="var(--chart-1)"
          strokeWidth={2}
          strokeDasharray="5 5"
          fill="transparent"
        />
        <Area
          type="monotone"
          dataKey="current"
          stroke="var(--chart-5)"
          strokeWidth={2}
          fill="url(#snowui-area)"
        />
      </ReAreaChart>
    </ResponsiveContainer>
  )
}

export function BarTrafficChart({
  data,
  height = 260,
}: {
  data: { label: string; value: number; color: string }[]
  height?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} width={48} tickFormatter={formatCompact} />
        <Bar dataKey="value" radius={[8, 8, 8, 8]} barSize={36}>
          {data.map((d) => (
            <Cell key={d.label} fill={d.color} />
          ))}
        </Bar>
      </ReBarChart>
    </ResponsiveContainer>
  )
}

export function DonutChart({
  data,
  height = 180,
  onSliceClick,
}: {
  data: { label: string; value: number; color: string }[]
  height?: number
  onSliceClick?: (label: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = React.useState(height)
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)
  const [lastActiveIndex, setLastActiveIndex] = React.useState(0)
  const total = data.reduce((sum, item) => sum + item.value, 0)
  const tooltipIndex = activeIndex ?? lastActiveIndex
  const tooltipItem = data[tooltipIndex]
  const tooltipPosition = donutTooltipPosition(data, tooltipIndex, total, containerWidth, height)

  React.useEffect(() => {
    const node = containerRef.current
    if (!node) return

    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width || height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [height])

  return (
    <div ref={containerRef} className="relative overflow-visible" style={{ height }}>
      <ResponsiveContainer width="100%" height={height}>
        <RePieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={52}
            outerRadius={80}
            paddingAngle={3}
            stroke="none"
            isAnimationActive={false}
            onMouseEnter={(_, index) => {
              setActiveIndex(index)
              setLastActiveIndex(index)
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onClick={
              onSliceClick
                ? (entry: unknown) => {
                    const dataEntry = entry && typeof entry === 'object'
                      ? entry as { label?: unknown; name?: unknown; payload?: { label?: unknown } }
                      : null
                    const label = String(dataEntry?.label ?? dataEntry?.name ?? dataEntry?.payload?.label ?? '')
                    if (label) onSliceClick(label)
                  }
                : undefined
            }
          >
            {data.map((d, index) => (
              <Cell
                key={d.label}
                fill={d.color}
                fillOpacity={activeIndex == null || activeIndex === index ? 1 : 0.82}
                className={onSliceClick ? 'cursor-pointer outline-none transition-opacity duration-150' : undefined}
              />
            ))}
          </Pie>
        </RePieChart>
      </ResponsiveContainer>
      {tooltipItem && (
        <div
          className="pointer-events-none absolute z-20 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-[0_10px_30px_oklch(from_var(--foreground)_l_c_h_/_0.12)] transition-[left,top,transform,opacity] duration-300 ease-out"
          style={{
            left: tooltipPosition.x,
            top: tooltipPosition.y,
            opacity: activeIndex == null ? 0 : 1,
            transform:
              tooltipPosition.side === 'right'
                ? 'translate(10px, -50%)'
                : 'translate(calc(-100% - 10px), -50%)',
          }}
        >
          <div className="flex items-center gap-2 font-semibold">
            <span className="inline-block size-2 rounded-full" style={{ background: tooltipItem.color }} />
            {tooltipItem.label}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {formatNumberPt(tooltipItem.value)} objetos · {formatPercentPt(total > 0 ? (tooltipItem.value / total) * 100 : 0)}%
          </div>
        </div>
      )}
    </div>
  )
}

function donutTooltipPosition(
  data: { value: number }[],
  index: number,
  total: number,
  width: number,
  height: number,
) {
  const centerX = width / 2
  const centerY = height / 2
  if (!data.length || total <= 0) {
    return { x: centerX + 92, y: centerY, side: 'right' as const }
  }

  const startAngle = 0
  const previousAngle = data
    .slice(0, index)
    .reduce((angle, item) => angle + (item.value / total) * 360, startAngle)
  const sliceAngle = (data[index]?.value ?? 0) / total * 360
  const angle = previousAngle + sliceAngle / 2
  const radians = (angle * Math.PI) / 180
  const radius = 104
  const x = centerX + Math.cos(radians) * radius
  const y = Math.min(height - 18, Math.max(18, centerY - Math.sin(radians) * radius))
  return {
    x,
    y,
    side: x >= centerX ? 'right' as const : 'left' as const,
  }
}
