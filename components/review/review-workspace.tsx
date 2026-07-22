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
} from "lucide-react"
import { apiAssetUrl, createReviewDecision, fetchReviewQueue, fetchTasks } from "@/lib/api/client"
import { labelsFromTasks, type ApiClassItem } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendReviewQueueItem, BackendTask } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Decision = "aceito" | "anotacao" | "corrigido" | "excluido"

type Box = { x: number; y: number; w: number; h: number }
type EditSnapshot = { id: number; box?: Box }
type FrameDimensions = { width: number; height: number }
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
type SizeFilter = "all" | "small" | "medium" | "large" | "custom"
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
  raw?: Record<string, unknown>
  frameDimensions?: FrameDimensions | null
}

const initialBoxes: Record<number, Box> = {}

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
  anotacao: { label: "Para anotação", text: "text-destructive", dot: "bg-destructive", ring: "ring-destructive" },
  corrigido: { label: "Corrigido", text: "text-warning", dot: "bg-warning", ring: "ring-warning" },
  excluido: { label: "Excluído", text: "text-destructive", dot: "bg-destructive", ring: "ring-destructive" },
}

const confOptions: { label: string; value: number }[] = [
  { label: "Todas", value: 0 },
  { label: "≥ 0.90", value: 0.9 },
  { label: "≥ 0.70", value: 0.7 },
  { label: "≥ 0.50", value: 0.5 },
]

const sizeOptions: { label: string; value: SizeFilter }[] = [
  { label: "Todos", value: "all" },
  { label: "Pequenas (< 2%)", value: "small" },
  { label: "Médias (2-6%)", value: "medium" },
  { label: "Grandes (> 6%)", value: "large" },
]

function clsColor(name: string) {
  return colorForName(name)
}

function alternatives(cls: string, conf: number, classCatalog: ApiClassItem[]) {
  const pool = classCatalog.map((c) => c.name).filter((name) => name !== cls)
  return [{ cls, v: conf }, ...pool.slice(0, 5).map((name) => ({ cls: name, v: 0 }))]
}

function queueItemToAnnotation(item: BackendReviewQueueItem, index: number, classCatalog: ApiClassItem[]): ReviewAnnotation {
  const fallbackClass = classCatalog[0]?.name ?? "unknown"
  const cls = item.label ?? fallbackClass
  return {
    id: stableNumericId(
      item.external_annotation_id ?? item.cvat_annotation_id ?? item.cvat_job_id ?? item.task_external_id ?? `queue-${index}`,
    ),
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
    raw: objectRecord(item.payload.raw),
    frameDimensions: frameDimensionsFromPayload(item.payload.frame_dimensions),
  }
}

function generatedBoxesFor(items: ReviewAnnotation[]): Record<number, Box> {
  const boxes: Record<number, Box> = {}
  items.forEach((item) => {
    const box = boxFromAnnotation(item)
    if (box) boxes[item.id] = box
  })
  return boxes
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function boxFromAnnotation(item: ReviewAnnotation): Box | null {
  const rawBox = objectRecord(item.raw?.bbox_norm)
  const normalizedBox = boxFromNormalizedRecord(rawBox)
  if (normalizedBox) return normalizedBox

  const rawShape = objectRecord(item.raw?.shape)
  const shapeBox = boxFromNormalizedRecord(objectRecord(rawShape.bbox_norm))
  if (shapeBox) return shapeBox

  const points = item.points?.map(Number).filter(Number.isFinite) ?? []
  const normalizedPoints = normalizedPointsForReview(points, item)
  if (normalizedPoints.length < 4) return null

  const xs = normalizedPoints.filter((_, index) => index % 2 === 0)
  const ys = normalizedPoints.filter((_, index) => index % 2 === 1)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    x: clampPct(minX * 100),
    y: clampPct(minY * 100),
    w: clampPct((maxX - minX) * 100, 0, 100),
    h: clampPct((maxY - minY) * 100, 0, 100),
  }
}

function normalizedPointsForReview(points: number[], item: ReviewAnnotation) {
  const rawPointsNorm = Array.isArray(item.raw?.points_norm)
    ? item.raw.points_norm.map(Number).filter(Number.isFinite)
    : []
  const source = rawPointsNorm.length >= 4 ? rawPointsNorm : points
  if (source.length < 4) return []
  if (source.every((value) => value >= 0 && value <= 1)) return source.map((value) => clampPct(value, 0, 1))
  const dimensions = item.frameDimensions
  if (!dimensions) return []
  return source.map((value, index) => {
    const axisSize = index % 2 === 0 ? dimensions.width : dimensions.height
    return clampPct(value / axisSize, 0, 1)
  })
}

function frameDimensionsFromPayload(value: unknown): FrameDimensions | null {
  const record = objectRecord(value)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![width, height].every((number) => Number.isFinite(number) && number > 0)) return null
  return { width, height }
}

function boxFromNormalizedRecord(value: Record<string, unknown>): Box | null {
  const x = Number(value.x)
  const y = Number(value.y)
  const w = Number(value.w)
  const h = Number(value.h)
  if (![x, y, w, h].every((number) => Number.isFinite(number) && number >= 0 && number <= 1)) return null
  return {
    x: clampPct(x * 100),
    y: clampPct(y * 100),
    w: clampPct(w * 100, 0, 100),
    h: clampPct(h * 100, 0, 100),
  }
}

function sameReviewFrame(annotation: ReviewAnnotation, current: ReviewAnnotation) {
  if (current.id === emptyAnnotation.id) return false
  if (annotation.id === current.id) return true
  if (annotation.previewUrl && current.previewUrl) return annotation.previewUrl === current.previewUrl
  return annotation.cvatJobId === current.cvatJobId && annotation.frame === current.frame
}

function stableNumericId(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return 100000 + (hash % 800000)
}

function colorForName(name: string) {
  const palette = [
    "var(--brand-blue)",
    "var(--brand-green)",
    "var(--brand-lavender)",
    "var(--warning)",
    "var(--brand-indigo)",
    "var(--brand-sky)",
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return palette[hash % palette.length] ?? "var(--muted-foreground)"
}

function decisionToBackend(decision: Decision) {
  if (decision === "aceito") return "accepted"
  if (decision === "anotacao") return "needs_annotation"
  if (decision === "corrigido") return "corrected"
  return "deleted_by_reviewer"
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
  const { currentUser } = useCurrentUser()
  const classCatalog = React.useMemo<ApiClassItem[]>(() => {
    const cvatClasses = labelsFromTasks(tasks)
    return cvatClasses.length > 0 ? cvatClasses : []
  }, [tasks])
  const reviewItems = React.useMemo(
    () =>
      reviewQueue && reviewQueue.length > 0
        ? reviewQueue.map((item, index) => queueItemToAnnotation(item, index, classCatalog))
        : [],
    [classCatalog, reviewQueue],
  )
  const [selectedId, setSelectedId] = React.useState<number>(0)
  const [decisions, setDecisions] = React.useState<Record<number, Decision>>({})
  const [syncState, setSyncState] = React.useState<Record<number, { synced: boolean; error?: string | null }>>({})
  const [log, setLog] = React.useState<{ id: number; decision: Decision }[]>([])
  const [autoAdvance, setAutoAdvance] = React.useState(true)
  const [scale, setScale] = React.useState(1)
  const [tab, setTab] = React.useState<"anotacoes" | "tracks" | "tags" | "comentarios">("anotacoes")
  const [checkedClasses, setCheckedClasses] = React.useState<Set<string>>(() => new Set())
  const [boxState, setBoxState] = React.useState<Record<number, Box>>(initialBoxes)
  const [onlyUnreviewed, setOnlyUnreviewed] = React.useState(false)
  const [onlyThisClass, setOnlyThisClass] = React.useState(false)
  const [minConf, setMinConf] = React.useState(0)
  const [confidenceInput, setConfidenceInput] = React.useState("")
  const [sizeFilter, setSizeFilter] = React.useState<SizeFilter>("all")
  const [boxAreaMinInput, setBoxAreaMinInput] = React.useState("")
  const [boxAreaMaxInput, setBoxAreaMaxInput] = React.useState("")
  const [openFilter, setOpenFilter] = React.useState<"conf" | "size" | null>(null)
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const scaleRef = React.useRef(scale)
  scaleRef.current = scale

  // ---- Correcao de objeto ----
  const [clsOverride, setClsOverride] = React.useState<Record<number, string>>({})
  const [correcting, setCorrecting] = React.useState(false)
  const [classEditorOpen, setClassEditorOpen] = React.useState(false)
  const [editSnapshot, setEditSnapshot] = React.useState<EditSnapshot | null>(null)
  const [classQuery, setClassQuery] = React.useState("")
  const correctInputRef = React.useRef<HTMLInputElement>(null)
  const clsColor = React.useCallback(
    (name: string) =>
      classCatalog.find((c) => c.name === name)?.color ??
      colorForName(name),
    [classCatalog],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    fetchReviewQueue(controller.signal).then(setReviewQueue).catch(() => setReviewQueue(null))
    return () => controller.abort()
  }, [])

  React.useEffect(() => {
    if (classCatalog.length > 0) {
      setCheckedClasses(new Set(classCatalog.map((c) => c.name)))
    }
  }, [classCatalog])

  React.useEffect(() => {
    if (!reviewQueue?.length) return
    const nextBoxes = generatedBoxesFor(reviewItems)
    const ids = new Set(reviewItems.map((item) => item.id))
    setBoxState((prev) => {
      const kept = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(Number(id))))
      return { ...nextBoxes, ...kept }
    })
    if (!reviewItems.some((item) => item.id === selectedId)) {
      setSelectedId(reviewItems[0]?.id ?? selectedId)
    }
  }, [reviewItems, reviewQueue?.length, selectedId])

  const clsOf = React.useCallback(
    (a: { id: number; cls: string }) => clsOverride[a.id] ?? a.cls,
    [clsOverride],
  )

  const startCorrection = React.useCallback(
    (id?: number, options: { openClassEditor?: boolean } = {}) => {
      const targetId = id ?? selectedId
      const target = reviewItems.find((item) => item.id === targetId) ?? reviewItems[0]
      if (!target || target.id === emptyAnnotation.id) return
      setSelectedId(target.id)
      setClassQuery(clsOf(target))
      setEditSnapshot({ id: target.id, box: boxState[target.id] })
      setCorrecting(true)
      setClassEditorOpen(Boolean(options.openClassEditor))
      if (options.openClassEditor) {
        requestAnimationFrame(() => correctInputRef.current?.focus())
      }
    },
    [boxState, clsOf, reviewItems, selectedId],
  )

  const openClassEditor = React.useCallback(
    (id?: number) => {
      startCorrection(id, { openClassEditor: true })
    },
    [startCorrection],
  )

  const classSuggestions = React.useMemo(() => {
    const q = classQuery.trim().toLowerCase()
    const names = classCatalog.map((c) => c.name)
    if (!q) return names.slice(0, 6)
    return names.filter((n) => n.toLowerCase().includes(q)).slice(0, 6)
  }, [classCatalog, classQuery])

  const selectedCls = reviewItems.find((a) => a.id === selectedId)?.cls
  const boxAreaMin = parseOptionalDecimal(boxAreaMinInput)
  const boxAreaMax = parseOptionalDecimal(boxAreaMaxInput)
  const hasCustomBoxArea = boxAreaMin !== null || boxAreaMax !== null
  const hasBoxSizeFilter = sizeFilter !== "all" && (sizeFilter !== "custom" || hasCustomBoxArea)

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
        if (hasBoxSizeFilter) {
          const areaPct = boxAreaPct(b)
          if (sizeFilter === "custom") {
            if (boxAreaMin !== null && areaPct < boxAreaMin) return false
            if (boxAreaMax !== null && areaPct > boxAreaMax) return false
          } else {
            const bucket = boxAreaBucket(areaPct)
            if (bucket !== sizeFilter) return false
          }
        }
        return true
      }),
    [
      boxAreaMax,
      boxAreaMin,
      boxState,
      checkedClasses,
      decisions,
      hasBoxSizeFilter,
      minConf,
      onlyThisClass,
      onlyUnreviewed,
      reviewItems,
      selectedCls,
      sizeFilter,
    ],
  )
  const total = visibleAnnotations.length
  const hasVisibleAnnotations = total > 0
  const current = hasVisibleAnnotations
    ? visibleAnnotations.find((a) => a.id === selectedId) ?? visibleAnnotations[0] ?? emptyAnnotation
    : emptyAnnotation
  const currentFrameAnnotations = hasVisibleAnnotations
    ? visibleAnnotations.filter((annotation) => sameReviewFrame(annotation, current))
    : []
  const frameAnnotationTotal = currentFrameAnnotations.length
  const reviewedCount = Object.keys(decisions).length
  const queueTotal = reviewItems.length
  const currentQueueIndex = reviewItems.findIndex((item) => item.id === current.id)
  const queuePos = queueTotal === 0 ? 0 : Math.max(1, currentQueueIndex + 1)
  const queuePct = queueTotal === 0 ? 0 : Math.round((reviewedCount / queueTotal) * 100)
  const currentPreviewSrc = current.previewUrl ?? "/placeholder.svg"

  const selectNext = React.useCallback(() => {
    const i = visibleAnnotations.findIndex((a) => a.id === selectedId)
    const next = visibleAnnotations[Math.min(i + 1, visibleAnnotations.length - 1)]
    if (next) setSelectedId(next.id)
  }, [selectedId, visibleAnnotations])

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
      if (selected.id === emptyAnnotation.id) return
      const backendDecision = decisionToBackend(decision)
      setDecisions((d) => ({ ...d, [selected.id]: decision }))
      setSyncState((state) => ({ ...state, [selected.id]: { synced: false, error: null } }))
      setLog((l) => [{ id: selected.id, decision }, ...l].slice(0, 20))
      if (selected.externalAnnotationId) {
        try {
          const response = await createReviewDecision({
            external_annotation_id: selected.externalAnnotationId,
            decision: backendDecision,
            annotation_type: selected.annotationType,
            cvat_job_id: selected.cvatJobId,
            corrected_label: backendDecision === "corrected" ? correctedLabel ?? clsOf(selected) : null,
            actor: currentUser.email || currentUser.id,
            patch_cvat: backendDecision === "corrected" || backendDecision === "deleted_by_reviewer",
            payload: {
              confidence: selected.conf,
              frame: selected.frame,
              previous_label: selected.cls,
              local_box: boxState[selected.id],
              frame_dimensions: selected.frameDimensions,
            },
          })
          setSyncState((state) => ({
            ...state,
            [selected.id]: { synced: response.cvat_synced, error: response.cvat_error },
          }))
          window.dispatchEvent(new Event("review-queue-updated"))
          if (decision === "excluido") {
            setBoxState((prev) => {
              const next = { ...prev }
              delete next[selected.id]
              return next
            })
          }
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
    [autoAdvance, boxState, clsOf, current, currentUser.email, currentUser.id, selectNext],
  )

  // Escolha de classe e acoes do modo de correcao.
  const chooseCorrectionClass = React.useCallback((name: string) => {
    setClassQuery(name)
    requestAnimationFrame(() => correctInputRef.current?.focus())
  }, [])

  const cancelCorrection = React.useCallback(() => {
    if (editSnapshot?.box) {
      setBoxState((prev) => ({ ...prev, [editSnapshot.id]: editSnapshot.box as Box }))
    }
    setCorrecting(false)
    setClassEditorOpen(false)
    setEditSnapshot(null)
    setClassQuery("")
  }, [editSnapshot])

  const saveCorrection = React.useCallback(() => {
    const name = classQuery.trim() || clsOf(current)
    setClsOverride((prev) => ({ ...prev, [current.id]: name }))
    setCorrecting(false)
    setClassEditorOpen(false)
    setEditSnapshot(null)
    setClassQuery("")
    void decide("corrigido", name)
  }, [classQuery, clsOf, current, decide])

  const deleteSelectedAnnotation = React.useCallback(() => {
    setCorrecting(false)
    setClassEditorOpen(false)
    setEditSnapshot(null)
    setClassQuery("")
    void decide("excluido")
  }, [decide])

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
        if (correcting) {
          deleteSelectedAnnotation()
        } else {
          startCorrection(selectedId)
        }
        return
      }
      if (e.key === "ArrowRight") {
        e.preventDefault()
        void decide("aceito")
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        void decide("anotacao")
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        startCorrection()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [correcting, decide, deleteSelectedAnnotation, selectedId, startCorrection, undo])

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

  const alts = alternatives(current.cls, current.conf, classCatalog)

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
            {(onlyUnreviewed || onlyThisClass || minConf > 0 || hasBoxSizeFilter) && (
              <button
                onClick={() => {
                  setOnlyUnreviewed(false)
                  setOnlyThisClass(false)
                  setMinConf(0)
                  setConfidenceInput("")
                  setSizeFilter("all")
                  setBoxAreaMinInput("")
                  setBoxAreaMaxInput("")
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
              value={confidenceFilterLabel(minConf)}
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
                    setConfidenceInput(o.value ? formatConfidenceInput(o.value) : "")
                    setOpenFilter(null)
                  }}
                />
              ))}
              <div className="mt-1 border-t border-border px-3 py-2">
                <label className="text-[11px] font-medium text-muted-foreground">Mínimo personalizado</label>
                <input
                  value={confidenceInput}
                  inputMode="decimal"
                  placeholder="Ex.: 0,85"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const value = event.target.value
                    setConfidenceInput(value)
                    const parsed = parseOptionalDecimal(value)
                    setMinConf(parsed === null ? 0 : clampNumber(parsed, 0, 1))
                  }}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-brand-blue"
                />
              </div>
            </FilterSelect>
            <FilterSelect
              label="Tamanho da caixa"
              value={boxSizeFilterLabel(sizeFilter, boxAreaMin, boxAreaMax)}
              active={hasBoxSizeFilter}
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
                    if (o.value !== "custom") {
                      setBoxAreaMinInput("")
                      setBoxAreaMaxInput("")
                    }
                    setOpenFilter(null)
                  }}
                />
              ))}
              <div className="mt-1 border-t border-border px-3 py-2">
                <p className="text-[11px] font-medium text-muted-foreground">Área personalizada da imagem</p>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
                    Mín. %
                    <input
                      value={boxAreaMinInput}
                      inputMode="decimal"
                      placeholder="Ex.: 1"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        setBoxAreaMinInput(event.target.value)
                        setSizeFilter("custom")
                      }}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-brand-blue"
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground">
                    Máx. %
                    <input
                      value={boxAreaMaxInput}
                      inputMode="decimal"
                      placeholder="Ex.: 8"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        setBoxAreaMaxInput(event.target.value)
                        setSizeFilter("custom")
                      }}
                      className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-brand-blue"
                    />
                  </label>
                </div>
              </div>
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
            <span className="ml-1 text-sm font-medium tabular-nums">
              {queuePos.toLocaleString("pt-BR")} / {queueTotal.toLocaleString("pt-BR")}
            </span>
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
              {currentFrameAnnotations.map((a) => {
                const b = boxState[a.id]
                const active = a.id === selectedId
                const d = decisions[a.id]
                return (
                  <div
                    key={a.id}
                    onPointerDown={(e) => {
                      if (correcting && active) {
                        beginDrag(e, a.id, "move")
                        return
                      }
                      setSelectedId(a.id)
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      openClassEditor(a.id)
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
                      cursor: correcting && active ? "move" : "pointer",
                    }}
                  >
                    <span
                      className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: clsColor(clsOf(a)), fontSize: `${10 / scale}px` }}
                    >
                      {clsOf(a)} {a.conf.toFixed(2)}
                    </span>
                    {active &&
                      correcting &&
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
              {frameAnnotationTotal === 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white/80">
                    Nenhuma anotação com bounding box para revisar.
                  </div>
                </div>
              )}
            </div>

            {/* Correção de objeto */}
            {classEditorOpen && (
              <div
                className="absolute left-1/2 top-4 z-20 w-[22rem] -translate-x-1/2 rounded-xl border border-border bg-popover p-3 shadow-xl"
                role="dialog"
                aria-label="Trocar classe da anotação"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Trocar classe #{current.id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Troque a classe, ajuste a caixa se precisar, salve ou exclua.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={cancelCorrection}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Cancelar correção"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <label className="mt-3 block text-xs font-medium text-muted-foreground">Classe</label>
                <input
                  ref={correctInputRef}
                  value={classQuery}
                  onChange={(e) => setClassQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation()
                      cancelCorrection()
                      return
                    }
                    if (e.key === "Enter") {
                      e.preventDefault()
                      saveCorrection()
                    }
                  }}
                  placeholder="Digite a classe correta..."
                  aria-label="Classe correta"
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand-blue"
                />
                <ul className="mt-1.5 flex max-h-36 flex-col overflow-y-auto" role="listbox" aria-label="Sugestões de classe">
                  {classSuggestions.length === 0 && (
                    <li className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma classe encontrada.</li>
                  )}
                  {classSuggestions.map((name, i) => (
                    <li key={name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={name === classQuery || i === 0}
                        onClick={() => chooseCorrectionClass(name)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          (name === classQuery || i === 0) && "bg-muted/60",
                        )}
                      >
                        <span className="size-2 shrink-0 rounded-full" style={{ background: clsColor(name) }} />
                        <span className="flex-1 truncate">{name}</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={deleteSelectedAnnotation}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-destructive/40 px-3 text-sm font-medium text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-4" /> Excluir
                  </button>
                  <button
                    type="button"
                    onClick={cancelCorrection}
                    className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={saveCorrection}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-warning px-3 text-sm font-semibold text-white hover:brightness-110"
                  >
                    <Check className="size-4" /> Salvar
                  </button>
                </div>
              </div>
            )}

            {correcting && !classEditorOpen && (
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/75 px-2 py-2 text-xs text-white shadow-lg backdrop-blur">
                <button
                  type="button"
                  onClick={deleteSelectedAnnotation}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-red-200 hover:bg-red-500/20"
                >
                  <Trash2 className="size-3.5" /> Excluir
                </button>
                <button
                  type="button"
                  onClick={cancelCorrection}
                  className="inline-flex h-8 items-center rounded-full px-3 font-medium text-white/85 hover:bg-white/10"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveCorrection}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-warning px-3 font-semibold text-white hover:brightness-110"
                >
                  <Check className="size-3.5" /> Salvar
                </button>
              </div>
            )}

            {/* info overlay */}
            <div className="pointer-events-none absolute left-0 top-0 max-w-xs bg-gradient-to-br from-black/70 to-transparent p-3 text-white">
              <p className="text-sm font-medium">
                {current.taskName ?? `Item #${current.id}`} <span className="text-white/60">CVAT</span>
              </p>
              <p className="mt-0.5 text-xs text-white/70">Gerada por: {current.origem}</p>
              <p className="text-xs text-white/70">Job: {current.cvatJobId ?? "--"}</p>
              <p className="text-xs text-white/70">Confiança: {current.conf.toFixed(2)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              Frame: {current.frame == null ? "--" : current.frame.toLocaleString("pt-BR")}
            </span>
            <span className="truncate">
              {current.previewUrl ? "Preview sincronizado pelo backend" : "Sem preview sincronizado"}
            </span>
          </div>

          {/* tabs + table */}
          <div className="flex h-56 flex-col border-t border-border">
            <div className="flex items-center gap-1 border-b border-border px-3">
              {(
                [
                  ["anotacoes", `Anotações (${frameAnnotationTotal})`],
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
                    {currentFrameAnnotations.map((a) => {
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
                                  startCorrection(a.id)
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
            <div>Job: {current.cvatJobId ?? "--"}</div>
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
                onClick={() => startCorrection()}
                className="bg-warning text-white hover:brightness-110"
              >
                <ArrowUp className="size-4" /> <span className="flex-1 text-center">Corrigir objeto</span>{" "}
                <ArrowUp className="size-4" />
              </DecisionButton>
              <DecisionButton
                onClick={() => void decide("anotacao")}
                className="bg-destructive text-destructive-foreground hover:brightness-110"
              >
                <ArrowLeft className="size-4" /> <span className="flex-1 text-center">Enviar para anotação</span>{" "}
                <ArrowLeft className="size-4" />
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
          Tempo estimado <span className="text-foreground">--</span>
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

function parseOptionalDecimal(value: string) {
  const normalized = value.trim().replace(",", ".")
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function formatConfidenceInput(value: number) {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })
}

function confidenceFilterLabel(value: number) {
  const preset = confOptions.find((option) => option.value === value)
  if (preset) return preset.label
  return `≥ ${formatConfidenceInput(value)}`
}

function boxAreaPct(box: Box) {
  return (box.w * box.h) / 100
}

function boxAreaBucket(areaPct: number): Exclude<SizeFilter, "all" | "custom"> {
  if (areaPct < 2) return "small"
  if (areaPct <= 6) return "medium"
  return "large"
}

function boxSizeFilterLabel(sizeFilter: SizeFilter, min: number | null, max: number | null) {
  if (sizeFilter !== "custom") {
    return sizeOptions.find((option) => option.value === sizeFilter)?.label ?? "Todos"
  }
  if (min !== null && max !== null) return `${formatAreaPct(min)}-${formatAreaPct(max)}`
  if (min !== null) return `≥ ${formatAreaPct(min)}`
  if (max !== null) return `≤ ${formatAreaPct(max)}`
  return "Personalizado"
}

function formatAreaPct(value: number) {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`
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
