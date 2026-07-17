"use client"

import { cn } from "@/lib/utils"

export function TabNav({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { key: string; label: string }[]
  value: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto border-b border-border", className)} role="tablist">
      {tabs.map((tab) => {
        const active = tab.key === value
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={cn(
              "relative shrink-0 px-3 py-2.5 text-sm font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-blue" />
            )}
          </button>
        )
      })}
    </div>
  )
}
