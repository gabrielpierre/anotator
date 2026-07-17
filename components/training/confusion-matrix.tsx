"use client"

import * as React from "react"
import { confusionClasses, confusionMatrix } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function ConfusionMatrix() {
  const [normalized, setNormalized] = React.useState(true)

  const rowTotals = confusionMatrix.map((row) => row.reduce((a, b) => a + b, 0))

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="p-1 text-left font-normal text-muted-foreground">
                <span className="sr-only">Classe real</span>
              </th>
              {confusionClasses.map((c) => (
                <th key={c} className="p-1 text-center font-medium text-muted-foreground">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {confusionMatrix.map((row, i) => (
              <tr key={confusionClasses[i]}>
                <td className="whitespace-nowrap py-1 pr-2 text-right font-medium text-muted-foreground">
                  {confusionClasses[i]}
                </td>
                {row.map((cell, j) => {
                  const frac = rowTotals[i] ? cell / rowTotals[i] : 0
                  const isDiag = i === j
                  const intensity = normalized ? frac : cell / 1300
                  return (
                    <td key={j} className="p-0">
                      <div
                        className={cn(
                          "flex h-9 min-w-[44px] items-center justify-center rounded-md text-[11px] tabular-nums",
                          isDiag ? "text-brand-blue" : "text-foreground/80",
                        )}
                        style={{
                          backgroundColor: isDiag
                            ? `oklch(from var(--brand-blue) l c h / ${0.18 + intensity * 0.7})`
                            : `oklch(from var(--foreground) l c h / ${Math.min(0.22, intensity * 0.6)})`,
                        }}
                      >
                        {normalized ? (frac ? frac.toFixed(2) : "0") : cell}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-brand-blue" /> Diagonal (acertos)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-foreground/20" /> Confusões
          </span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          Normalizado
          <button
            type="button"
            role="switch"
            aria-checked={normalized}
            onClick={() => setNormalized((v) => !v)}
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              normalized ? "bg-brand-green" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                normalized ? "translate-x-4" : "translate-x-0",
              )}
            />
          </button>
        </label>
      </div>
    </div>
  )
}
