"use client"

import * as React from "react"
import {
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Play,
  ZoomIn,
  ZoomOut,
  Copy,
  ChevronDown,
  Eye,
  Maximize2,
  Trash2,
  BarChart3,
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
} from "lucide-react"
import { reviewAnnotations, classes } from "@/lib/mock-data"
import { apiAssetUrl, createReviewDecision, fetchReviewQueue, fetchTasks, mockFallbackEnabled } from "@/lib/api/client"
import { labelsFromTasks, type ApiClassItem } from "@/lib/api/status"
import type { BackendReviewQueueItem, BackendTask } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Decision = "aceito" | "rejeitado" | "corrigido" | "incerto"

type Box = { x: number; y: number; w: number; h: number }
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
type ReviewAnnotation = {
  id: number
  cls: string
  conf: number
  origem: string
  criada: string
  color: string
  externalAnnotationId?: string | null
  annotationType?: "shape" | "track" | "tag" | null
  labelId?: number | null
  frame?: number | null
  points?: unknown[]
  shapeType?: string | null
  previewUrl?: string
  taskName?: string
  cvatJobId?: string | null
}

const initialBoxes: Record<number, Box> = {
  88213: { x: 7, y: 50, w: 22, h: 26 },
  88214: { x: 34, y: 48, w: 17, h: 20 },
  88215: { x: 54, y: 38, w: 24, h: 32 },
  88216: { x: 73, y: 42, w: 20, h: 26 },
  88217: { x: 26, y: 66, w: 10, h: 13 },
  88218: { x: 1, y: 58, w: 11, h: 16 },
}

const clampPct = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v))

const handles: { id: Handle; cls: string; cursor: string }[] = [
  { id: "nw", cls: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { id: "n", cls: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { id: "ne", cls: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { id: "e", cls: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", cls: "right-0 bottom-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
  { id: "s", cls: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "ns-resize" },
  { id: "sw", cls: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { id: "w", cls: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
]

const decisionInfo: Record<Decision, { label: string; text: string; dot: string; ring: string }> = {
  aceito: { label: "Aceito", text: "text-brand-green", dot: "bg-brand-green", ring: "ring-brand-green" },
  rejeitado: { label: "Rejeitado", text: "text-destructive", dot: "bg-destructive", ring: "ring-destructive" },
  corrigido: { label: "Corrigido", text: "text-warning", dot: "bg-warning", ring: "ring-warning" },
  incerto: { label: "Incerto", text: "text-brand-blue", dot: "bg-brand-blue", ring: "ring-brand-blue" },
}

const confOptions: { label: string; value: number }[] = [
  { label: "Todas", value: 0 },
  { label: "≥ 0.90", value: 0.9 },
  { label: "≥ 0.70", value: 0.7 },
  { label: "≥ 0.50", value: 0.5 },
]

const sizeOptions: { label: string; value: "all" | "small" | "medium" | "large" }[] = [
  { label: "Todos", value: "all" },
  { label: "Pequenas", value: "small" },
  { label: "Médias", value: "medium" },
  { label: "Grandes", value: "large" },
]

function clsColor(name: string) {
  return classes.find((c) => c.name === name)?.color ?? "var(--muted-foreground)"
}

function alternatives(cls: string, conf: number) {
  const pool = ["car", "truck", "bus", "motorcycle", "van", "bicycle", "person", "others"].filter((c) => c !== cls)
  const vals = [0.21, 0.12, 0.05, 0.03, 0.02]
  return [{ cls, v: conf }, ...pool.slice(0, 5).map((c, i) => ({ cls: c, v: vals[i] }))]
}

function queueItemToAnnotation(item: BackendReviewQueueItem, index: number, classCatalog: ApiClassItem[]): ReviewAnnotation {
  const fallbackClass = classCatalog[0]?.name ?? "unknown"
  const cls = item.label ?? fallbackClass
  return {
    id: stableNumericId(item.cvat_job_id ?? item.task_external_id ?? `queue-${index}`),
    cls,
    conf: item.confidence ?? 1,
    origem: item.origin ?? "CVAT",
    criada: "sync CVAT",
    color: classCatalog.find((c) => c.name === cls)?.color ?? clsColor(cls),
    externalAnnotationId: item.external_annotation_id,
    annotationType: item.annotation_type,
    labelId: item.label_id,
    frame: item.frame,
    points: item.points,
    shapeType: item.shape_type,
    previewUrl: apiAssetUrl(item.preview_url) ?? undefined,
    taskName: item.task_name ?? undefined,
    cvatJobId: item.cvat_job_id,
  }
}

function generatedBoxesFor(items: ReviewAnnotation[]): Record<number, Box> {
  const boxes: Record<number, Box> = {}
  items.forEach((item, index) => {
    const col = index % 3
    const row = Math.floor(index / 3) % 3
    boxes[item.id] = {
      x: 8 + col * 27,
      y: 18 + row * 20,
      w: 18,
      h: 16,
    }
  })
  return boxes
}

function stableNumericId(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return 100000 + (hash % 800000)
}

function decisionToBackend(decision: Decision) {
  if (decision === "aceito") return "accepted"
  if (decision === "rejeitado") return "rejected"
  if (decision === "corrigido") return "corrected"
  return "uncertain"
}

const emptyAnnotation: ReviewAnnotation = {
  id: 0,
  cls: "unknown",
  conf: 0,
  origem: "backend",
  criada: "--",
  color: "var(--muted-foreground)",
}

export function ReviewWorkspace() {
  const [tasks, setTasks] = React.useState<BackendTask[] | null>(null)
  const [reviewQueue, setReviewQueue] = React.useState<BackendReviewQueueItem[] | null>(null)
  const useMocks = mockFallbackEnabled()
  const classCatalog = React.useMemo<ApiClassItem[]>(() => {
    const cvatClasses = labelsFromTasks(tasks)
    return cvatClasses.length > 0 ? cvatClasses : useMocks ? classes : []
  }, [tasks, useMocks])
  const reviewItems = React.useMemo(
    () =>
      reviewQueue && reviewQueue.length > 0
        ? reviewQueue.map((item, index) => queueItemToAnnotation(item, index, classCatalog))
        : useMocks
          ? (reviewAnnotations as ReviewAnnotation[])
          : [],
    [classCatalog, reviewQueue, useMocks],
  )
  const [selectedId, setSelectedId] = React.useState<number>(useMocks ? reviewAnnotations[0].id : 0)
  const [decisions, setDecisions] = React.useState<Record<number, Decision>>({})
  const [syncState, setSyncState] = React.useState<Record<number, { synced: boolean; error?: string | null }>>({})
  const [log, setLog] = React.useState<{ id: number; decision: Decision }[]>([])
  const [autoAdvance, setAutoAdvance] = React.useState(true)
  const [scale, setScale] = React.useState(1)
  const [tab, setTab] = React.useState<"anotacoes" | "tracks" | "tags" | "comentarios">("anotacoes")
  const [checkedClasses, setCheckedClasses] = React.useState<Set<string>>(() =>
    new Set((useMocks ? classes : []).map((c) => c.name)),
  )
  const [boxState, setBoxState] = React.useState<Record<number, Box>>(initialBoxes)
  const [onlyUnreviewed, setOnlyUnreviewed] = React.useState(false)
  const [onlyThisClass, setOnlyThisClass] = React.useState(false)
  const [minConf, setMinConf] = React.useState(0)
  const [sizeFilter, setSizeFilter] = React.useState<"all" | "small" | "medium" | "large">("all")
  const [openFilter, setOpenFilter] = React.useState<"conf" | "size" | null>(null)
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const scaleRef = React.useRef(scale)
  scaleRef.current = scale

  // ---- Correção de classe com autocomplete ----
  const [clsOverride, setClsOverride] = React.useState<Record<number, string>>({})
  const [correcting, setCorrecting] = React.useState(false)
  const [classQuery, setClassQuery] = React.useState("")
  const correctInputRef = React.useRef<HTMLInputElement>(null)
  const clsColor = React.useCallback(
    (name: string) =>
      classCatalog.find((c) => c.name === name)?.color ??
      classes.find((c) => c.name === name)?.color ??
      "var(--muted-foreground)",
    [classCatalog],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    fetchReviewQueue(controller.signal).then(setReviewQueue).catch(() => setReviewQueue(null))
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    setCheckedClasses(new Set(classCatalog.map((c) => c.name)))
  }, [classCatalog])

  React.useEffect(() => {
    if (classCatalog.length > 0) {
      setCheckedClasses(new Set(classCatalog.map((c) => c.name)))
    }
  }, [classCatalog])

  React.useEffect(() => {
    if (!reviewQueue?.length) return
    const nextBoxes = generatedBoxesFor(reviewItems)
    setBoxState((prev) => ({ ...nextBoxes, ...prev }))
    if (!reviewItems.some((item) => item.id === selectedId)) {
      setSelectedId(reviewItems[0]?.id ?? selectedId)
    }
  }, [reviewItems, reviewQueue?.length, selectedId])

  const clsOf = React.useCallback(
    (a: { id: number; cls: string }) => clsOverride[a.id] ?? a.cls,
    [clsOverride],
  )

  const openCorrection = React.useCallback((id?: number) => {
    if (id != null) setSelectedId(id)
    setClassQuery("")
    setCorrecting(true)
    // Foca o input após renderizar
    requestAnimationFrame(() => correctInputRef.current?.focus())
  }, [])

  const classSuggestions = React.useMemo(() => {
    const q = classQuery.trim().toLowerCase()
    const names = classCatalog.map((c) => c.name)
    if (!q) return names.slice(0, 6)
    return names.filter((n) => n.toLowerCase().includes(q)).slice(0, 6)
  }, [classCatalog, classQuery])

  const selectedCls = reviewItems.find((a) => a.id === selectedId)?.cls

  const toggleClass = React.useCallback((name: string) => {
    setCheckedClasses((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const visibleAnnotations = React.useMemo(
    () =>
      reviewItems.filter((a) => {
        const b = boxState[a.id]
        if (!b || !checkedClasses.has(a.cls)) return false
        if (onlyUnreviewed && decisions[a.id]) return false
        if (onlyThisClass && selectedCls && a.cls !== selectedCls) return false
        if (a.conf < minConf) return false
        if (sizeFilter !== "all") {
          const area = b.w * b.h
          const bucket = area < 200 ? "small" : area <= 600 ? "medium" : "large"
          if (bucket !== sizeFilter) return false
        }
        return true
      }),
    [boxState, checkedClasses, onlyUnreviewed, onlyThisClass, selectedCls, minConf, sizeFilter, decisions, reviewItems],
  )
  const total = visibleAnnotations.length
  const current =
    visibleAnnotations.find((a) => a.id === selectedId) ?? visibleAnnotations[0] ?? reviewItems[0] ?? emptyAnnotation
  const reviewedCount = Object.keys(decisions).length
  const queueTotal = Math.max(reviewItems.length, 1)
  const queuePos = Math.min(queueTotal, reviewedCount + 1)
  const queuePct = Math.round((reviewedCount / queueTotal) * 100)
  const currentPreviewSrc = current.previewUrl ?? (useMocks ? "/street-scene.png" : "/placeholder.svg")

  const selectNext = React.useCallback(() => {
    const i = visibleAnnotations.findIndex((a) => a.id === selectedId)
    const next = visibleAnnotations[Math.min(i + 1, visibleAnnotations.length - 1)]
    if (next) setSelectedId(next.id)
  }, [selectedId, visibleAnnotations])

  const deleteBox = React.useCallback(
    (id: number) => {
      const idx = visibleAnnotations.findIndex((a) => a.id === id)
      const fallback = visibleAnnotations[idx + 1] ?? visibleAnnotations[idx - 1]
      setBoxState((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setDecisions((d) => {
        const next = { ...d }
        delete next[id]
        return next
      })
      if (id === selectedId && fallback) setSelectedId(fallback.id)
    },
    [visibleAnnotations, selectedId],
  )

  const beginDrag = React.useCallback(
    (e: React.PointerEvent, id: number, mode: "move" | Handle) => {
      e.preventDefault()
      e.stopPropagation()
      setSelectedId(id)
      const rect = canvasRef.current?.getBoundingClientRect()
      const start = boxState[id]
      if (!rect || !start) return
      const startX = e.clientX
      const startY = e.clientY
      const onMove = (ev: PointerEvent) => {
        const s = scaleRef.current
        const dx = ((ev.clientX - startX) / (rect.width * s)) * 100
        const dy = ((ev.clientY - startY) / (rect.height * s)) * 100
        setBoxState((prev) => {
          const b = { ...start }
          if (mode === "move") {
            b.x = clampPct(start.x + dx, 0, 100 - start.w)
            b.y = clampPct(start.y + dy, 0, 100 - start.h)
          } else {
            if (mode.includes("e")) b.w = clampPct(start.w + dx, 2, 100 - start.x)
            if (mode.includes("s")) b.h = clampPct(start.h + dy, 2, 100 - start.y)
            if (mode.includes("w")) {
              const nx = clampPct(start.x + dx, 0, start.x + start.w - 2)
              b.x = nx
              b.w = start.w + (start.x - nx)
            }
            if (mode.includes("n")) {
              const ny = clampPct(start.y + dy, 0, start.y + start.h - 2)
              b.y = ny
              b.h = start.h + (start.y - ny)
            }
          }
          return { ...prev, [id]: b }
        })
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [boxState],
  )

  const decide = React.useCallback(
    async (decision: Decision, correctedLabel?: string) => {
      const selected = current
      setDecisions((d) => ({ ...d, [selected.id]: decision }))
      setSyncState((state) => ({ ...state, [selected.id]: { synced: false, error: null } }))
      setLog((l) => [{ id: selected.id, decision }, ...l].slice(0, 20))
      if (selected.externalAnnotationId) {
        try {
          const response = await createReviewDecision({
            external_annotation_id: selected.externalAnnotationId,
            decision: decisionToBackend(decision),
            annotation_type: selected.annotationType,
            cvat_job_id: selected.cvatJobId,
            corrected_label: correctedLabel ?? null,
            patch_cvat: true,
            payload: {
              confidence: selected.conf,
              frame: selected.frame,
              previous_label: selected.cls,
              local_box: boxState[selected.id],
            },
          })
          setSyncState((state) => ({
            ...state,
            [selected.id]: { synced: response.cvat_synced, error: response.cvat_error },
          }))
        } catch (error) {
          setSyncState((state) => ({
            ...state,
            [selected.id]: {
              synced: false,
              error: error instanceof Error ? error.message : "Erro ao registrar decisao",
            },
          }))
        }
      }
      if (autoAdvance) selectNext()
    },
    [autoAdvance, boxState, current, selectNext],
  )

  // Aplica a classe escolhida no autocomplete e registra a decisão "corrigido".
  const applyCorrection = React.useCallback(
    (name: string) => {
      setClsOverride((prev) => ({ ...prev, [selectedId]: name }))
      setCorrecting(false)
      setClassQuery("")
      void decide("corrigido", name)
    },
    [selectedId, decide],
  )

  const undo = React.useCallback(() => {
    setLog((l) => {
      if (!l.length) return l
      const [last, ...rest] = l
      setDecisions((d) => {
        const next = { ...d }
        delete next[last.id]
        return next
      })
      setSelectedId(last.id)
      return rest
    })
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        undo()
        return
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        deleteBox(selectedId)
        return
      }
      if (e.key === "ArrowRight") {
        e.preventDefault()
        void decide("aceito")
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        void decide("rejeitado")
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        openCorrection()
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        void decide("incerto")
      } else if (/^[1-5]$/.test(e.key)) {
        void decide("corrigido")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [decide, undo, deleteBox, selectedId, openCorrection])

  const onWheelZoom = React.useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setScale((s) => Math.min(4, Math.max(0.5, s - e.deltaY * 0.0015)))
  }, [])

  // keep selection on a visible annotation when classes are toggled off
  React.useEffect(() => {
    if (visibleAnnotations.length && !visibleAnnotations.some((a) => a.id === selectedId)) {
      setSelectedId(visibleAnnotations[0].id)
    }
  }, [visibleAnnotations, selectedId])

  const alts = alternatives(current.cls, current.conf)

  return (
    <div className="flex h-[calc(100svh-4rem)] flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* ---------- LEFT: review queue ---------- */}
        <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar lg:flex">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Classes revisadas ({checkedClasses.size}/{classCatalog.length})
            </p>
            <button
              onClick={() =>
                setCheckedClasses((prev) =>
                  prev.size === classCatalog.length ? new Set() : new Set(classCatalog.map((c) => c.name)),
                )
              }
              className="text-[11px] font-medium text-brand-blue hover:underline"
            >
              {checkedClasses.size === classCatalog.length ? "Limpar" : "Todas"}
            </button>
          </div>
          <ul className="flex flex-col gap-0.5 px-2">
            {classCatalog.map((c) => {
              const checked = checkedClasses.has(c.name)
              const count = c.count ?? reviewItems.filter((item) => item.cls === c.name).length
              return (
                <li key={c.name}>
                  <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleClass(c.name)}
                        className="size-4 shrink-0 rounded border-border accent-brand-blue"
                      />
                      <span className="size-2 shrink-0 rounded-full" style={{ background: c.color }} />
                      <span className={cn("truncate", !checked && "text-muted-foreground")}>{c.name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                      {count.toLocaleString("pt-BR")}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>

          <div className="flex items-center justify-between px-4 pb-2 pt-6">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Filtros rápidos</p>
            {(onlyUnreviewed || onlyThisClass || minConf > 0 || sizeFilter !== "all") && (
              <button
                onClick={() => {
                  setOnlyUnreviewed(false)
                  setOnlyThisClass(false)
                  setMinConf(0)
                  setSizeFilter("all")
                }}
                className="text-[11px] font-medium text-brand-blue hover:underline"
              >
                Limpar
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1.5 px-3 pb-4">
            <FilterToggle
              label="Somente não revisadas"
              active={onlyUnreviewed}
              onClick={() => setOnlyUnreviewed((v) => !v)}
            />
            <FilterToggle
              label={onlyThisClass && selectedCls ? `Somente: ${selectedCls}` : "Somente desta classe"}
              active={onlyThisClass}
              onClick={() => setOnlyThisClass((v) => !v)}
            />
            <FilterSelect
              label="Confiança"
              value={confOptions.find((o) => o.value === minConf)?.label ?? "Todas"}
              active={minConf > 0}
              open={openFilter === "conf"}
              onToggle={() => setOpenFilter((o) => (o === "conf" ? null : "conf"))}
            >
              {confOptions.map((o) => (
                <FilterOption
                  key={o.label}
                  label={o.label}
                  selected={o.value === minConf}
                  onClick={() => {
                    setMinConf(o.value)
                    setOpenFilter(null)
                  }}
                />
              ))}
            </FilterSelect>
            <FilterSelect
              label="Tamanho da caixa"
              value={sizeOptions.find((o) => o.value === sizeFilter)?.label ?? "Todos"}
              active={sizeFilter !== "all"}
              open={openFilter === "size"}
              onToggle={() => setOpenFilter((o) => (o === "size" ? null : "size"))}
            >
              {sizeOptions.map((o) => (
                <FilterOption
                  key={o.label}
                  label={o.label}
                  selected={o.value === sizeFilter}
                  onClick={() => {
                    setSizeFilter(o.value)
                    setOpenFilter(null)
                  }}
                />
              ))}
            </FilterSelect>
          </div>
        </aside>

        {/* ---------- CENTER: canvas ---------- */}
        <section className="flex min-w-0 flex-1 flex-col">
          {/* playback bar */}
          <div className="flex items-center gap-1.5 border-b border-border px-4 py-2">
            {[ChevronsLeft, ChevronLeft, Play, ChevronRight, ChevronsRight].map((Icon, i) => (
              <button
                key={i}
                onClick={() => (i < 2 ? undo() : selectNext())}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Icon className="size-4" />
              </button>
            ))}
            <span className="ml-1 text-sm font-medium tabular-nums">12 / 45</span>
            <label className="ml-3 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={(e) => setAutoAdvance(e.target.checked)}
                className="size-4 rounded border-border accent-brand-blue"
              />
              Auto avançar
            </label>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Diminuir zoom"
              >
                <ZoomOut className="size-4" />
              </button>
              <button
                onClick={() => setScale(1)}
                className="min-w-14 rounded-lg px-2 py-1 text-center text-sm font-medium tabular-nums hover:bg-muted"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                onClick={() => setScale((s) => Math.min(4, s + 0.1))}
                className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Aumentar zoom"
              >
                <ZoomIn className="size-4" />
              </button>
              <button className="ml-1 inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-muted">
                Ajustar <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* canvas */}
          <div
            ref={canvasRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-black"
            onWheel={onWheelZoom}
          >
            <div
              className="absolute inset-0 origin-center transition-transform duration-75"
              style={{ transform: `scale(${scale})` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={currentPreviewSrc}
                alt="Imagem em revisão"
                draggable={false}
                className="size-full select-none object-contain"
              />
              {visibleAnnotations.map((a) => {
                const b = boxState[a.id]
                const active = a.id === selectedId
                const d = decisions[a.id]
                return (
                  <div
                    key={a.id}
                    onPointerDown={(e) => beginDrag(e, a.id, "move")}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      openCorrection(a.id)
                    }}
                    className={cn("absolute select-none transition-opacity", active ? "z-10" : "z-0")}
                    style={{
                      left: `${b.x}%`,
                      top: `${b.y}%`,
                      width: `${b.w}%`,
                      height: `${b.h}%`,
                      borderWidth: active ? 3 : 2,
                      borderStyle: "solid",
                      borderColor: clsColor(clsOf(a)),
                      opacity: active ? 1 : d ? 0.45 : 0.85,
                      boxShadow: active ? "0 0 0 2px rgba(0,0,0,0.4)" : undefined,
                      cursor: active ? "move" : "pointer",
                    }}
                  >
                    <span
                      className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: clsColor(clsOf(a)), fontSize: `${10 / scale}px` }}
                    >
                      {clsOf(a)} {a.conf.toFixed(2)}
                    </span>
                    {active &&
                      handles.map((h) => (
                        <span
                          key={h.id}
                          onPointerDown={(e) => beginDrag(e, a.id, h.id)}
                          className={cn("absolute rounded-sm border border-white bg-brand-blue", h.cls)}
                          style={{
                            width: `${8 / scale}px`,
                            height: `${8 / scale}px`,
                            cursor: h.cursor,
                          }}
                        />
                      ))}
                  </div>
                )
              })}
            </div>

            {/* Correção de classe com autocomplete (seta ↑, duplo clique ou "Corrigir classe") */}
            {correcting && (
              <div
                className="absolute left-1/2 top-4 z-20 w-72 -translate-x-1/2 rounded-xl border border-border bg-popover p-3 shadow-xl"
                role="dialog"
                aria-label="Corrigir classe da anotação"
              >
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Corrigir classe de <span className="font-semibold text-foreground">#{current.id}</span>{" "}
                  <span className="text-foreground">({clsOf(current)})</span>
                </p>
                <input
                  ref={correctInputRef}
                  value={classQuery}
                  onChange={(e) => setClassQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation()
                      setCorrecting(false)
                      return
                    }
                    if (e.key === "Enter" && classSuggestions.length > 0) {
                      e.preventDefault()
                      applyCorrection(classSuggestions[0])
                    }
                  }}
                  placeholder="Digite o nome da classe..."
                  aria-label="Nome da classe correta"
                  className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand-blue"
                />
                <ul className="mt-1.5 flex flex-col" role="listbox" aria-label="Sugestões de classe">
                  {classSuggestions.length === 0 && (
                    <li className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma classe encontrada.</li>
                  )}
                  {classSuggestions.map((name, i) => (
                    <li key={name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === 0}
                        onClick={() => applyCorrection(name)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          i === 0 && "bg-muted/60",
                        )}
                      >
                        <span className="size-2 shrink-0 rounded-full" style={{ background: clsColor(name) }} />
                        <span className="flex-1">{name}</span>
                        {i === 0 && <kbd className="rounded bg-background px-1 text-[10px] text-muted-foreground">Enter</kbd>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* info overlay */}
            <div className="pointer-events-none absolute left-0 top-0 max-w-xs bg-gradient-to-br from-black/70 to-transparent p-3 text-white">
              <p className="text-sm font-medium">
                {current.taskName ?? `Item #${current.id}`} <span className="text-white/60">CVAT</span>
              </p>
              <p className="mt-0.5 text-xs text-white/70">Gerada por: {current.origem}</p>
              <p className="text-xs text-white/70">Job: {current.cvatJobId ?? "local"}</p>
              <p className="text-xs text-white/70">Confiança: {current.conf.toFixed(2)}</p>
            </div>
          </div>

          {/* filmstrip */}
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <button className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronsLeft className="size-4" />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {Array.from({ length: 10 }, (_, i) => i + 7).map((n) => {
                const currentFrame = n === 12
                return (
                  <button
                    key={n}
                    className={cn(
                      "relative aspect-video h-12 shrink-0 overflow-hidden rounded-md border-2 transition-colors",
                      currentFrame ? "border-brand-blue" : "border-transparent hover:border-border",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={currentPreviewSrc} alt={`Frame ${n}`} className="size-full object-cover" />
                    <span className="absolute bottom-0 right-0 bg-black/60 px-1 text-[9px] text-white">{n}</span>
                  </button>
                )
              })}
            </div>
            <button className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
              <ChevronsRight className="size-4" />
            </button>
          </div>

          {/* tabs + table */}
          <div className="flex h-56 flex-col border-t border-border">
            <div className="flex items-center gap-1 border-b border-border px-3">
              {(
                [
                  ["anotacoes", `Anotações (${total})`],
                  ["tracks", "Tracks (2)"],
                  ["tags", "Tags (0)"],
                  ["comentarios", "Comentários (0)"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={cn(
                    "border-b-2 px-3 py-2.5 text-sm transition-colors",
                    tab === key
                      ? "border-brand-blue font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === "anotacoes" ? (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="w-8 px-3 py-2" />
                      <th className="px-2 py-2 text-left font-medium">ID</th>
                      <th className="px-2 py-2 text-left font-medium">Classe</th>
                      <th className="px-2 py-2 text-left font-medium">Confiança</th>
                      <th className="px-2 py-2 text-left font-medium">Origem</th>
                      <th className="px-2 py-2 text-right font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAnnotations.map((a) => {
                      const active = a.id === selectedId
                      const d = decisions[a.id]
                      return (
                        <tr
                          key={a.id}
                          onClick={() => setSelectedId(a.id)}
                          className={cn(
                            "cursor-pointer border-b border-border/60 transition-colors",
                            active ? "bg-surface-blue/60" : "hover:bg-muted/60",
                          )}
                        >
                          <td className="px-3 py-2">
                            <span className="block size-3.5 rounded border border-border" style={{ background: a.color }} />
                          </td>
                          <td className="px-2 py-2 font-medium tabular-nums">{a.id}</td>
                          <td className="px-2 py-2">
                            <span className="flex items-center gap-2">
                              <span className="size-2 rounded-full" style={{ background: clsColor(clsOf(a)) }} />
                              {clsOf(a)}
                              {d && (
                                <span className={cn("ml-1 text-xs", decisionInfo[d].text)}>· {decisionInfo[d].label}</span>
                              )}
                            </span>
                          </td>
                          <td className="px-2 py-2 tabular-nums">{a.conf.toFixed(2)}</td>
                          <td className="px-2 py-2 text-muted-foreground">{a.origem}</td>
                          <td className="px-2 py-2">
                            <span className="flex items-center justify-end gap-1.5 text-muted-foreground">
                              <button aria-label="Visualizar" className="hover:text-foreground">
                                <Eye className="size-4" />
                              </button>
                              <button aria-label="Expandir" className="hover:text-foreground">
                                <Maximize2 className="size-4" />
                              </button>
                              <button
                                aria-label="Excluir anotação"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  deleteBox(a.id)
                                }}
                                className="hover:text-destructive"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Nenhum item nesta aba.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ---------- RIGHT: decision panel ---------- */}
        <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card xl:flex">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <p className="text-sm font-semibold">Anotação selecionada</p>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              ID: {current.id} <Copy className="size-3.5" />
            </button>
          </div>

          <div className="flex items-start justify-between gap-3 px-4">
            <div>
              <p className="text-2xl font-semibold" style={{ color: clsColor(clsOf(current)) }}>
                {clsOf(current)}
              </p>
              <p className="text-sm">
                <span className="font-medium tabular-nums">{current.conf.toFixed(2)}</span>{" "}
                <span className="text-muted-foreground">Confiança</span>
              </p>
            </div>
            <div className="size-16 shrink-0 overflow-hidden rounded-lg border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={currentPreviewSrc} alt="Recorte da anotação" className="size-full object-cover" />
            </div>
          </div>

          <dl className="mt-3 flex flex-col gap-1 px-4 text-xs text-muted-foreground">
            <div>Origem: {current.origem}</div>
            <div>Job: {current.cvatJobId ?? "local"}</div>
            <div>Gerada em: {current.criada}</div>
            {syncState[current.id] && (
              <div className={syncState[current.id].error ? "text-destructive" : "text-brand-green"}>
                CVAT: {syncState[current.id].error ?? (syncState[current.id].synced ? "sincronizado" : "registrado localmente")}
              </div>
            )}
          </dl>

          {/* top alternativas */}
          <div className="mt-5 px-4">
            <p className="mb-2 text-sm font-medium">Top alternativas</p>
            <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {alts.map((alt, i) => (
                <li key={alt.cls} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    <span className="size-2 shrink-0 rounded-full" style={{ background: clsColor(alt.cls) }} />
                    <span className="truncate" style={i === 0 ? { color: current.color } : undefined}>
                      {alt.cls}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">{alt.v.toFixed(2)}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* quick actions */}
          <div className="mt-5 px-4">
            <p className="mb-2 text-sm font-medium">Ações rápidas</p>
            <div className="flex flex-col gap-2">
              <DecisionButton onClick={() => void decide("aceito")} className="bg-brand-green text-white hover:brightness-110">
                <ArrowRight className="size-4" /> <span className="flex-1 text-center">Aceitar</span>{" "}
                <ArrowRight className="size-4" />
              </DecisionButton>
              <DecisionButton
                onClick={() => void decide("rejeitado")}
                className="bg-destructive text-destructive-foreground hover:brightness-110"
              >
                <ArrowLeft className="size-4" /> <span className="flex-1 text-center">Rejeitar</span>{" "}
                <ArrowLeft className="size-4" />
              </DecisionButton>
              <DecisionButton
                onClick={() => openCorrection()}
                className="bg-warning text-white hover:brightness-110"
              >
                <ArrowUp className="size-4" /> <span className="flex-1 text-center">Corrigir classe</span>{" "}
                <ArrowUp className="size-4" />
              </DecisionButton>
              <DecisionButton
                onClick={() => void decide("incerto")}
                className="border border-brand-blue/40 bg-brand-blue/15 text-brand-blue hover:bg-brand-blue/25"
              >
                <ArrowDown className="size-4" /> <span className="flex-1 text-center">Incerto</span>{" "}
                <ArrowDown className="size-4" />
              </DecisionButton>
            </div>
          </div>

          {/* motivo */}
          <div className="mt-5 px-4">
            <label className="mb-1.5 block text-xs text-muted-foreground">Motivo (opcional)</label>
            <button className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:bg-muted">
              Selecione um motivo... <ChevronDown className="size-4" />
            </button>
          </div>

          {/* comentário */}
          <div className="mt-3 px-4">
            <label className="mb-1.5 block text-xs text-muted-foreground">Comentário (opcional)</label>
            <textarea
              rows={2}
              placeholder="Adicione um comentário..."
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-brand-blue"
            />
          </div>

          <div className="pb-4" />
        </aside>
      </div>

      {/* ---------- BOTTOM status bar ---------- */}
      <div className="flex items-center gap-6 border-t border-border bg-card px-4 py-2 text-xs">
        <span className="flex items-center gap-2 text-muted-foreground">
          Atalhos ativos
          <span className="flex items-center gap-1 text-brand-green">
            <span className="size-1.5 rounded-full bg-brand-green" /> Modo decis��o
          </span>
        </span>
        <span className="hidden items-center gap-2 text-muted-foreground md:flex">
          Progresso da fila
          <span className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-brand-green" style={{ width: `${queuePct}%` }} />
          </span>
          <span className="tabular-nums text-foreground">
            {queuePos.toLocaleString("pt-BR")} / {queueTotal.toLocaleString("pt-BR")} ({queuePct}%)
          </span>
        </span>
        <span className="hidden text-muted-foreground lg:block">
          Tempo estimado <span className="text-foreground">2h 18min restantes</span>
        </span>
        <button className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 font-medium hover:bg-muted">
          <BarChart3 className="size-3.5" /> Ver estatísticas da fila
        </button>
      </div>
    </div>
  )
}

function DecisionButton({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode
  onClick: () => void
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all",
        className,
      )}
    >
      {children}
    </button>
  )
}

function FilterToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
        active
          ? "border-brand-blue/40 bg-surface-blue font-medium text-brand-blue"
          : "border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border",
          active ? "border-brand-blue bg-brand-blue text-white" : "border-border",
        )}
      >
        {active && <Check className="size-3" />}
      </span>
    </button>
  )
}

function FilterSelect({
  label,
  value,
  active,
  open,
  onToggle,
  children,
}: {
  label: string
  value: string
  active: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
          active
            ? "border-brand-blue/40 bg-surface-blue text-brand-blue"
            : "border-border bg-card text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">
          {label}
          {active && <span className="ml-1 font-medium">· {value}</span>}
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180", !active && "text-muted-foreground")}
        />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  )
}

function FilterOption({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted",
        selected ? "font-medium text-brand-blue" : "text-foreground",
      )}
    >
      {label}
      {selected && <Check className="size-3.5" />}
    </button>
  )
}
