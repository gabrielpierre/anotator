"use client"

import {
  CartesianGrid,
  Line,
  LineChart as ReLineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Dot,
} from "recharts"

/**
 * Gráficos específicos do CVAT++. Wrappers finos sobre recharts usando os
 * tokens de dados do SnowUI (variáveis --chart-* / --brand-* em runtime).
 */

const axisProps = {
  stroke: "oklch(from var(--foreground) l c h / 0.4)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const

export type Series = {
  key: string
  label: string
  color: string
  dashed?: boolean
}

export function MetricLineChart({
  data,
  series,
  xKey = "epoch",
  height = 280,
  domain = [0, 1],
  referenceX,
}: {
  data: Record<string, number | string>[]
  series: Series[]
  xKey?: string
  height?: number
  domain?: [number, number] | undefined
  referenceX?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="oklch(from var(--foreground) l c h / 0.08)"
          vertical={false}
        />
        <XAxis dataKey={xKey} {...axisProps} minTickGap={24} />
        <YAxis {...axisProps} width={36} domain={domain} />
        <Tooltip
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            fontSize: 12,
            color: "var(--popover-foreground)",
          }}
          labelStyle={{ color: "var(--muted-foreground)" }}
        />
        {referenceX != null && (
          <ReferenceLine
            x={referenceX}
            stroke="oklch(from var(--foreground) l c h / 0.35)"
            strokeDasharray="4 4"
          />
        )}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "5 5" : undefined}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </ReLineChart>
    </ResponsiveContainer>
  )
}

export function SparkLineChart({
  data,
  dataKey,
  color = "var(--brand-blue)",
  height = 120,
  highlightLast = false,
}: {
  data: Record<string, number | string>[]
  dataKey: string
  color?: string
  height?: number
  highlightLast?: boolean
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReLineChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          dot={
            highlightLast
              ? (props: { cx?: number; cy?: number; index?: number }) => {
                  const isLast = props.index === data.length - 1
                  return isLast ? (
                    <Dot cx={props.cx} cy={props.cy} r={3.5} fill={color} stroke="var(--card)" strokeWidth={2} />
                  ) : (
                    <g key={props.index} />
                  )
                }
              : false
          }
          isAnimationActive={false}
        />
      </ReLineChart>
    </ResponsiveContainer>
  )
}
