'use client'

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
}: {
  data: { label: string; value: number; color: string }[]
  height?: number
}) {
  return (
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
        >
          {data.map((d) => (
            <Cell key={d.label} fill={d.color} />
          ))}
        </Pie>
      </RePieChart>
    </ResponsiveContainer>
  )
}
