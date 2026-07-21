"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  MousePointer2,
  Square,
  Spline,
  Circle,
  Tag,
  Hand,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  Save,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Trash2,
  Check,
  Plus,
} from "lucide-react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import {
  createInferenceRun,
  deleteInferenceSuggestions,
  fetchModelVersions,
  fetchInferenceSuggestions,
  fetchReviewAnnotations,
  fetchTasks,
  jobsEventsUrl,
  saveManualAnnotations,
  taskFrameAssetUrl,
} from "@/lib/api/client"
import { labelsFromTasks } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type {
  BackendAnnotationRecord,
  BackendInferenceSuggestion,
  BackendManualAnnotationShape,
  BackendModelVersion,
  BackendTask,
} from "@/lib/api/types"
import { cn } from "@/lib/utils"
import {
  AutoAnnotationCard,
  type ModelInfo,
  type PredictionLayer,
  type Suggestion,
} from "@/components/annotate/auto-annotation-card"

type ToolKey = "select" | "pan" | "box" | "polygon" | "point" | "tag"

const tools: { icon: typeof MousePointer2; label: string; tool: ToolKey; key: string }[] = [
  { icon: MousePointer2, label: "Selecionar", tool: "select", key: "V" },
  { icon: Hand, label: "Mover", tool: "pan", key: "H" },
  { icon: Square, label: "Caixa", tool: "box", key: "B" },
  { icon: Spline, label: "Polígono", tool: "polygon", key: "P" },
  { icon: Circle, label: "Ponto", tool: "point", key: "K" },
  { icon: Tag, label: "Rótulo", tool: "tag", key: "T" },
]

type ClassItem = { name: string; color: string; parent?: string }

const initialClassList: ClassItem[] = []

const newClassPalette = [
  "oklch(0.65 0.18 25)",
  "oklch(0.6 0.15 300)",
  "oklch(0.7 0.14 160)",
  "oklch(0.68 0.16 70)",
  "oklch(0.62 0.17 220)",
]

type Shape =
  | { id: number; type: "box"; cls: string; conf?: number; x: number; y: number; w: number; h: number }
  | { id: number; type: "polygon"; cls: string; points: { x: number; y: number }[] }
  | { id: number; type: "point"; cls: string; x: number; y: number }

const initialShapes: Shape[] = []

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v))
const MIN_SCALE = 0.4
const MAX_SCALE = 8
const MIN_BOX = 0.01

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

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

const POLY_CLOSE_DIST = 0.02

export function AnnotateView() {
  const [tasks, setTasks] = useState<BackendTask[] | null>(null)
  const [modelVersions, setModelVersions] = useState<BackendModelVersion[]>([])
  const { currentUser } = useCurrentUser()
  const currentTask = tasks?.[0] ?? null
  const annotationModels = modelVersions
    .filter((model) => model.status !== "archived")
    .map(modelInfoFromBackend)
  const totalImages = Math.max(1, currentTask?.size ?? 1)
  const [tool, setTool] = useState<ToolKey>("box")
  const [classList, setClassList] = useState<ClassItem[]>(() => initialClassList)
  // Nenhuma classe ativa por padrão: o usuário desenha primeiro e escolhe a classe depois.
  const [activeClass, setActiveClass] = useState<string | null>(null)
  const colorFor = useCallback(
    (cls: string) => {
      const item = classList.find((c) => c.name === cls)
      if (item) return item.color
      // Subclasse herda a cor do pai se não encontrada diretamente
      return "var(--brand-blue)"
    },
    [classList],
  )
  // Ferramenta temporária (ex.: mover durante um arrasto com a ferramenta de caixa ativa)
  const [tempTool, setTempTool] = useState<ToolKey | null>(null)
  const [returnToolAfterSelect, setReturnToolAfterSelect] = useState<ToolKey | null>(null)
  // Picker de classe com autocomplete: aberto após desenhar (isNew) ou por duplo clique.
  // filterParent restringe as sugestões às subclasses de uma classe.
  const [classPicker, setClassPicker] = useState<{
    id: number
    x: number
    y: number
    isNew?: boolean
    filterParent?: string
  } | null>(null)
  const [classQuery, setClassQuery] = useState("")
  // Adição de classe/subclasse
  const [addingClass, setAddingClass] = useState<{ parent: string | null } | null>(null)
  const [newClassName, setNewClassName] = useState("")
  const [shapesByFrame, setShapesByFrame] = useState<Record<string, Shape[]>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 })
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [polyDraft, setPolyDraft] = useState<{ x: number; y: number }[] | null>(null)
  const polyDraftRef = useRef(polyDraft)
  polyDraftRef.current = polyDraft
  const [cursorNorm, setCursorNorm] = useState<{ x: number; y: number } | null>(null)
  const lastPolyClick = useRef(0)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ---- Navegação de imagens ----
  const [imageIndex, setImageIndex] = useState(0)
  const loadedAnnotationKeys = useRef(new Set<string>())
  const dirtyFrameSignatures = useRef(new Map<string, string>())

  useEffect(() => {
    const controller = new AbortController()
    fetchTasks(controller.signal).then(setTasks).catch(() => setTasks(null))
    fetchModelVersions(controller.signal).then(setModelVersions).catch(() => setModelVersions([]))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const labels = labelsFromTasks(tasks)
    if (labels.length > 0) {
      setClassList(labels.map((label) => ({ name: label.name, color: label.color })))
      setActiveClass(null)
    }
  }, [tasks])

  useEffect(() => {
    setImageIndex((index) => Math.min(Math.max(index, 1), totalImages))
  }, [totalImages])

  // ---- Autoanotação: sugestões e camadas de predição ----
  const [backendSuggestions, setBackendSuggestions] = useState<BackendInferenceSuggestion[]>([])
  const [hiddenLayers, setHiddenLayers] = useState<string[]>([])
  const currentFrame = Math.max(0, imageIndex - 1)
  const currentTaskId = currentTask?.external_id ?? currentTask?.id
  const currentFrameKey = `${currentTaskId ?? "no-task"}:${currentFrame}`
  const previewSrc = taskFrameAssetUrl(currentTaskId, currentFrame) ?? "/placeholder.svg"
  const shapes = shapesByFrame[currentFrameKey] ?? initialShapes
  const currentFrameKeyRef = useRef(currentFrameKey)
  currentFrameKeyRef.current = currentFrameKey
  const setShapes = useCallback((updater: Shape[] | ((prev: Shape[]) => Shape[])) => {
    setShapesByFrame((prevByFrame) => {
      const frameKey = currentFrameKeyRef.current
      const previousShapes = prevByFrame[frameKey] ?? initialShapes
      const nextShapes =
        typeof updater === "function" ? (updater as (prev: Shape[]) => Shape[])(previousShapes) : updater
      if (nextShapes === previousShapes) return prevByFrame
      dirtyFrameSignatures.current.set(frameKey, frameShapesSignature(nextShapes))
      return { ...prevByFrame, [frameKey]: nextShapes }
    })
  }, [])

  useEffect(() => {
    const taskExternalId = currentTask?.external_id
    if (!taskExternalId || loadedAnnotationKeys.current.has(currentFrameKey)) return
    const controller = new AbortController()
    fetchReviewAnnotations({ taskExternalId, frame: currentFrame }, controller.signal)
      .then((records) => {
        loadedAnnotationKeys.current.add(currentFrameKey)
        const loadedShapes = records
          .filter((record) => record.review_state !== "rejected")
          .map(shapeFromAnnotationRecord)
          .filter((shape): shape is Shape => Boolean(shape))
        if (loadedShapes.length > 0) {
          nextId.current = Math.max(nextId.current, Math.max(...loadedShapes.map((shape) => shape.id)) + 1)
        }
        setClassList((prev) => mergeAnnotationClasses(prev, records))
        setShapesByFrame((prev) => {
          if ((prev[currentFrameKey]?.length ?? 0) > 0) return prev
          return { ...prev, [currentFrameKey]: loadedShapes }
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) loadedAnnotationKeys.current.add(currentFrameKey)
      })
    return () => controller.abort()
  }, [currentFrame, currentFrameKey, currentTask?.external_id])

  const suggestions = backendSuggestions
    .filter((suggestion) => suggestion.frame === currentFrame)
    .map(mapBackendSuggestion)

  const layerUnit = (m: ModelInfo) =>
    m.task === "Segmentação" ? "máscaras" : m.task === "Classificação" ? "labels" : "sugestões"

  const predictionLayers: PredictionLayer[] = annotationModels
    .map((m) => ({
      modelId: m.id,
      label: `${m.name} ${m.version}`,
      unit: layerUnit(m),
      count: suggestions.filter((s) => s.origin.model_id === m.id).length,
      visible: !hiddenLayers.includes(m.id),
    }))
    .filter((l) => l.count > 0)

  const loadSuggestions = useCallback(
    async (signal?: AbortSignal) => {
      if (!currentTask) {
        setBackendSuggestions([])
        return
      }
      const rows = await fetchInferenceSuggestions({ taskExternalId: currentTask.external_id }, signal)
      setBackendSuggestions(rows)
    },
    [currentTask],
  )

  useEffect(() => {
    const controller = new AbortController()
    loadSuggestions(controller.signal).catch(() => setBackendSuggestions([]))
    return () => controller.abort()
  }, [loadSuggestions])

  useEffect(() => {
    const source = new EventSource(jobsEventsUrl())
    const onJobs = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { jobs?: { kind?: string; status?: string; task_external_id?: string | null }[] }
        const hasFinishedInference = payload.jobs?.some(
          (job) =>
            job.kind === "inference" &&
            ["succeeded", "failed", "canceled"].includes(String(job.status)) &&
            job.task_external_id === currentTask?.external_id,
        )
        if (hasFinishedInference) void loadSuggestions()
      } catch {
        // Ignore malformed SSE snapshots.
      }
    }
    source.addEventListener("jobs", onJobs as EventListener)
    source.onerror = () => source.close()
    return () => source.close()
  }, [currentTask?.external_id, loadSuggestions])

  const generateSuggestions = async (params: {
    models: ModelInfo[]
    threshold: number
    nmsIou: number
    classes: string[]
    scope: string
    applyMode: string
    replaceModels: string[]
    frameStart: number
    frameEnd: number
  }) => {
    if (!currentTask) throw new Error("Nenhuma task CVAT sincronizada para inferencia.")
    const jobs = await Promise.all(
      params.models.map((model) =>
        createInferenceRun({
          task_external_id: currentTask.external_id,
          model_id: model.id,
          model_version: model.version,
          model_family: modelFamilyFor(model),
          base_model: baseModelFor(model),
          frame_start: params.frameStart,
          frame_end: params.frameEnd,
          threshold: params.threshold,
          nms_iou: params.nmsIou,
          classes: params.classes,
          apply_mode: params.replaceModels.includes(model.id) || params.applyMode === "substituir" ? "replace" : "append",
          confirm_replace: params.replaceModels.includes(model.id) || params.applyMode === "substituir",
          user_id: currentUser.email || currentUser.id,
          write_to_cvat: params.applyMode === "aceitas",
        }),
      ),
    )
    setHiddenLayers((prev) => prev.filter((id) => !params.models.some((m) => m.id === id)))

    return {
      created: 0,
      ignored: 0,
      conflicts: 0,
      jobId: jobs.map((job) => job.id).join(", "),
    }
  }

  const modelLabelFor = (modelId: string, version: string) => {
    const m = annotationModels.find((x) => x.id === modelId)
    return m ? `${m.name} ${version}` : modelId
  }

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const toolRef = useRef(tool)
  toolRef.current = tool
  const nextId = useRef(90000)

  const past = useRef<Shape[][]>([])
  const future = useRef<Shape[][]>([])
  const [, forceRender] = useState(0)

  useEffect(() => {
    setSelectedId(null)
    setClassPicker(null)
    setClassQuery("")
    setDraft(null)
    setPolyDraft(null)
    setCursorNorm(null)
    past.current = []
    future.current = []
    setView({ s: 1, tx: 0, ty: 0 })
    forceRender((n) => n + 1)
  }, [currentFrameKey])

  const commit = useCallback((updater: (prev: Shape[]) => Shape[]) => {
    setShapes((prev) => {
      past.current.push(prev)
      if (past.current.length > 50) past.current.shift()
      future.current = []
      return updater(prev)
    })
    forceRender((n) => n + 1)
  }, [])

  const undo = useCallback(() => {
    setShapes((prev) => {
      const last = past.current.pop()
      if (!last) return prev
      future.current.push(prev)
      return last
    })
    forceRender((n) => n + 1)
  }, [])

  const redo = useCallback(() => {
    setShapes((prev) => {
      const next = future.current.pop()
      if (!next) return prev
      past.current.push(prev)
      return next
    })
    forceRender((n) => n + 1)
  }, [])

  // Convert a client point to normalized [0..1] stage coordinates.
  const clientToNorm = useCallback((clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
  }, [])

  // Wheel zoom toward cursor (native, non-passive so we can preventDefault).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const mx = e.clientX - cx
      const my = e.clientY - cy
      const { s, tx, ty } = viewRef.current
      const factor = Math.exp(-e.deltaY * 0.0015)
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const k = ns / s
      setView({ s: ns, tx: mx - k * (mx - tx), ty: my - k * (my - ty) })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setView((v) => ({ ...v, s: clamp(v.s * factor, MIN_SCALE, MAX_SCALE) }))
  }, [])
  const resetView = useCallback(() => setView({ s: 1, tx: 0, ty: 0 }), [])

  const dragWindow = (onMove: (e: PointerEvent) => void, onUp?: (e: PointerEvent) => void) => {
    const move = (e: PointerEvent) => onMove(e)
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      onUp?.(e)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // Resolve a classe a usar ao desenhar:
  // - sem classe ativa → desenha sem classe e abre o autocomplete
  // - classe ativa com subclasses (e nenhuma subclasse ativa) → aplica a classe pai
  //   provisoriamente e abre o autocomplete filtrado nas subclasses
  // - classe ativa sem subclasses, ou subclasse ativa → aplica direto
  const resolveDrawClass = () => {
    if (!activeClass) return { cls: "", filterParent: undefined as string | undefined, needsPicker: true }
    const item = classList.find((c) => c.name === activeClass)
    if (item && !item.parent && classList.some((c) => c.parent === item.name)) {
      return { cls: item.name, filterParent: item.name, needsPicker: true }
    }
    return { cls: activeClass, filterParent: undefined, needsPicker: false }
  }

  // Abre o picker de classe ancorado ao lado do shape.
  const openPickerForShape = (shape: Shape, opts: { isNew?: boolean; filterParent?: string } = {}) => {
    const r = containerRef.current?.getBoundingClientRect()
    const sr = stageRef.current?.getBoundingClientRect()
    if (!r || !sr) return
    let ax = sr.left
    let ay = sr.top
    if (shape.type === "box") {
      ax = sr.left + (shape.x + shape.w) * sr.width + 8
      ay = sr.top + shape.y * sr.height
    } else if (shape.type === "point") {
      ax = sr.left + shape.x * sr.width + 10
      ay = sr.top + shape.y * sr.height
    } else {
      const p = shape.points[0]
      ax = sr.left + p.x * sr.width + 8
      ay = sr.top + p.y * sr.height
    }
    setClassQuery("")
    setClassPicker({ id: shape.id, x: ax - r.left, y: ay - r.top, ...opts })
  }

  // Cancela o picker. Se o shape acabou de ser criado e ficou sem classe, remove-o.
  const cancelPicker = () => {
    setClassPicker((picker) => {
      if (picker?.isNew) {
        const shape = shapes.find((s) => s.id === picker.id)
        if (shape && !shape.cls) {
          commit((prev) => prev.filter((s) => s.id !== picker.id))
          setSelectedId(null)
        }
      }
      return null
    })
    setClassQuery("")
  }
  const cancelPickerRef = useRef(cancelPicker)
  cancelPickerRef.current = cancelPicker

  const createClassItem = (rawName: string, parent: string | null = null) => {
    const name = rawName.trim()
    if (!name) return null
    const existing = classList.find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing.name

    setClassList((prev) => {
      if (prev.some((item) => item.name.toLowerCase() === name.toLowerCase())) return prev

      if (parent) {
        const parentIndex = prev.findIndex((item) => item.name === parent)
        const parentItem = parentIndex >= 0 ? prev[parentIndex] : null
        const color = parentItem?.color ?? newClassPalette[prev.length % newClassPalette.length]
        if (parentIndex < 0) return [...prev, { name, color }]

        let insertAt = parentIndex + 1
        while (insertAt < prev.length && prev[insertAt].parent === parent) insertAt++
        const next = [...prev]
        next.splice(insertAt, 0, { name, color, parent })
        return next
      }

      const color = newClassPalette[prev.length % newClassPalette.length]
      return [...prev, { name, color }]
    })

    return name
  }

  const createAndApplyPickerClass = () => {
    if (!classPicker) return
    const name = createClassItem(classQuery, classPicker.filterParent ?? null)
    if (!name) return
    commit((prev) => prev.map((s) => (s.id === classPicker.id ? { ...s, cls: name } : s)))
    setClassPicker(null)
    setClassQuery("")
  }

  // Aplica a classe escolhida no autocomplete.
  const applyPickerClass = (name: string) => {
    if (!classPicker) return
    commit((prev) => prev.map((s) => (s.id === classPicker.id ? { ...s, cls: name } : s)))
    setClassPicker(null)
    setClassQuery("")
  }

  // Sugestões do autocomplete: filtradas pela query e, se aplicável, pelas subclasses do pai.
  const pickerPool = classPicker?.filterParent
    ? classList.filter((c) => c.name === classPicker.filterParent || c.parent === classPicker.filterParent)
    : classList
  const pickerQuery = classQuery.trim().toLowerCase()
  const pickerSuggestions = (
    pickerQuery ? pickerPool.filter((c) => c.name.toLowerCase().includes(pickerQuery)) : pickerPool
  ).slice(0, 8)

  // Pan por arrasto — usado pela ferramenta mão e pelo botão do meio do mouse.
  const startPan = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const start = { x: e.clientX, y: e.clientY }
      const base = { ...viewRef.current }
      dragWindow((ev) => {
        setView({ s: base.s, tx: base.tx + (ev.clientX - start.x), ty: base.ty + (ev.clientY - start.y) })
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Pointer down on the empty stage.
  const onStagePointerDown = (e: React.PointerEvent) => {
    // Botão do meio (scroll pressionado): sempre move a imagem, em qualquer ferramenta.
    if (e.button === 1) {
      e.preventDefault()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    cancelPicker()
    const t = toolRef.current

    if (t === "pan") {
      startPan(e)
      return
    }

    if (t === "select") {
      setSelectedId(null)
      if (returnToolAfterSelect) {
        setTool(returnToolAfterSelect)
        setTempTool(null)
        setReturnToolAfterSelect(null)
      }
      return
    }

    if (t === "point") {
      const p = clientToNorm(e.clientX, e.clientY)
      const id = nextId.current++
      const resolved = resolveDrawClass()
      const shape: Shape = { id, type: "point", cls: resolved.cls, x: clamp(p.x), y: clamp(p.y) }
      commit((prev) => [...prev, shape])
      setSelectedId(id)
      if (resolved.needsPicker) openPickerForShape(shape, { isNew: true, filterParent: resolved.filterParent })
      return
    }

    if (t === "polygon") {
      const p = { x: clamp(clientToNorm(e.clientX, e.clientY).x), y: clamp(clientToNorm(e.clientX, e.clientY).y) }
      const pts = polyDraftRef.current ?? []
      const now = Date.now()
      const isDouble = now - lastPolyClick.current < 260
      lastPolyClick.current = now
      if (pts.length >= 3) {
        const first = pts[0]
        if (Math.hypot(p.x - first.x, p.y - first.y) < POLY_CLOSE_DIST || isDouble) {
          finishPolygon()
          return
        }
      }
      setPolyDraft([...pts, p])
      return
    }

    if (t === "box") {
      const start = clientToNorm(e.clientX, e.clientY)
      setSelectedId(null)
      let last: { x: number; y: number; w: number; h: number } | null = null
      dragWindow(
        (ev) => {
          const cur = clientToNorm(ev.clientX, ev.clientY)
          last = {
            x: Math.min(start.x, cur.x),
            y: Math.min(start.y, cur.y),
            w: Math.abs(cur.x - start.x),
            h: Math.abs(cur.y - start.y),
          }
          setDraft(last)
        },
        () => {
          setDraft(null)
          if (last && last.w > 0.01 && last.h > 0.01) {
            const id = nextId.current++
            const d = last
            const resolved = resolveDrawClass()
            const shape: Shape = { id, type: "box", cls: resolved.cls, x: clamp(d.x), y: clamp(d.y), w: d.w, h: d.h }
            commit((prev) => [...prev, shape])
            setSelectedId(id)
            if (resolved.needsPicker) openPickerForShape(shape, { isNew: true, filterParent: resolved.filterParent })
          }
        },
      )
    }
  }

  const finishPolygon = useCallback(() => {
    const pts = polyDraftRef.current
    if (pts && pts.length >= 3) {
      const id = nextId.current++
      const resolved = resolveDrawClass()
      const shape: Shape = { id, type: "polygon", cls: resolved.cls, points: pts }
      commit((prev) => [...prev, shape])
      setSelectedId(id)
      if (resolved.needsPicker) openPickerForShape(shape, { isNew: true, filterParent: resolved.filterParent })
    }
    setPolyDraft(null)
    setCursorNorm(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClass, commit, classList])

  // Move a shape (box/point/polygon). Boxes and polygons clicked from drawing
  // tools switch to selection so edit affordances stay available after the click.
  const startMove = (e: React.PointerEvent, shape: Shape) => {
    // Botão do meio: pan da imagem mesmo sobre um objeto.
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    e.stopPropagation()
    if (classPicker?.id === shape.id) {
      setClassPicker(null)
      setClassQuery("")
    } else {
      cancelPicker()
    }
    const currentTool = toolRef.current
    if (currentTool === "tag") {
      setSelectedId(shape.id)
      if (activeClass) {
        commit((prev) => prev.map((s) => (s.id === shape.id ? { ...s, cls: activeClass } : s)))
      } else {
        // Sem classe ativa: abre o autocomplete para escolher a classe deste objeto.
        openPickerForShape(shape)
      }
      return
    }
    // Polígono em desenho: cliques sobre objetos continuam adicionando vértices.
    if (currentTool === "polygon" && polyDraftRef.current?.length) return
    if (currentTool === "pan") return
    const shouldSwitchToSelect = currentTool !== "select" && (shape.type === "box" || shape.type === "polygon")
    const isTemporary = currentTool !== "select" && !shouldSwitchToSelect
    if (shouldSwitchToSelect) {
      setTool("select")
      setTempTool(null)
      setReturnToolAfterSelect(currentTool)
    }
    if (isTemporary) setTempTool("select")
    setSelectedId(shape.id)
    const start = clientToNorm(e.clientX, e.clientY)
    let moved = false
    const before = shape
    const beforeShapes = shapes
    dragWindow(
      (ev) => {
        const cur = clientToNorm(ev.clientX, ev.clientY)
        const dx = cur.x - start.x
        const dy = cur.y - start.y
        if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) moved = true
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== before.id) return s
            if (before.type === "box" && s.type === "box")
              return { ...s, x: clamp(before.x + dx, 0, 1 - s.w), y: clamp(before.y + dy, 0, 1 - s.h) }
            if (before.type === "point" && s.type === "point")
              return { ...s, x: clamp(before.x + dx), y: clamp(before.y + dy) }
            if (before.type === "polygon" && s.type === "polygon")
              return { ...s, points: before.points.map((pt) => ({ x: clamp(pt.x + dx), y: clamp(pt.y + dy) })) }
            return s
          }),
        )
      },
      () => {
        // Volta para a ferramenta original após o arrasto temporário.
        if (isTemporary) setTempTool(null)
        if (moved) {
          past.current.push(beforeShapes)
          future.current = []
        }
      },
    )
  }

  // Resize a box from any of the 8 handles (delta-based, matches the review workspace).
  const startResize = (e: React.PointerEvent, box: Extract<Shape, { type: "box" }>, mode: Handle) => {
    e.stopPropagation()
    setSelectedId(box.id)
    const start = { x: box.x, y: box.y, w: box.w, h: box.h }
    const p0 = clientToNorm(e.clientX, e.clientY)
    const before = shapes
    dragWindow(
      (ev) => {
        const cur = clientToNorm(ev.clientX, ev.clientY)
        const dx = cur.x - p0.x
        const dy = cur.y - p0.y
        const b = { ...start }
        if (mode.includes("e")) b.w = clamp(start.w + dx, MIN_BOX, 1 - start.x)
        if (mode.includes("s")) b.h = clamp(start.h + dy, MIN_BOX, 1 - start.y)
        if (mode.includes("w")) {
          const nx = clamp(start.x + dx, 0, start.x + start.w - MIN_BOX)
          b.x = nx
          b.w = start.w + (start.x - nx)
        }
        if (mode.includes("n")) {
          const ny = clamp(start.y + dy, 0, start.y + start.h - MIN_BOX)
          b.y = ny
          b.h = start.h + (start.y - ny)
        }
        setShapes((prev) => prev.map((s) => (s.id === box.id ? { ...s, ...b } : s)))
      },
      () => {
        past.current.push(before)
        future.current = []
      },
    )
  }

  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current
    if (id != null) {
      commit((prev) => prev.filter((s) => s.id !== id))
      setSelectedId(null)
    }
  }, [commit])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        deleteSelected()
        return
      }
      if (e.key === "Enter" && polyDraft) {
        finishPolygon()
        return
      }
      if (e.key === "Escape") {
        setPolyDraft(null)
        setCursorNorm(null)
        setDraft(null)
        cancelPickerRef.current()
        return
      }
      const match = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase())
      if (match) {
        setReturnToolAfterSelect(null)
        setTempTool(null)
        setTool(match.tool)
        return
      }
      const rootClasses = classList.filter((c) => !c.parent)
      const n = Number.parseInt(e.key, 10)
      if (!Number.isNaN(n) && n >= 1 && n <= Math.min(9, rootClasses.length)) {
        // Pressionar o mesmo número novamente desmarca a classe ativa.
        setActiveClass((prev) => (prev === rootClasses[n - 1].name ? null : rootClasses[n - 1].name))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, deleteSelected, finishPolygon, polyDraft, classList])

  const persistCurrentFrame = useCallback(async (mode: "manual" | "auto" = "manual") => {
    if (!currentTask?.external_id) {
      if (mode === "manual") setSaveError("Nenhuma task CVAT sincronizada para salvar.")
      return
    }
    if (shapes.some((shape) => !shape.cls.trim())) {
      if (mode === "manual") setSaveError("Defina a classe de todos os objetos antes de salvar.")
      return
    }
    const signature = frameShapesSignature(shapes)
    setSaving(true)
    setSaveError(null)
    try {
      const records = await saveManualAnnotations({
        task_external_id: currentTask.external_id,
        frame: currentFrame,
        shapes: shapes.map(shapeToManualAnnotation),
        actor: currentUser.email || currentUser.id,
        sync_cvat: true,
        replace_existing: true,
      })
      loadedAnnotationKeys.current.add(currentFrameKey)
      setClassList((prev) => mergeAnnotationClasses(prev, records))
      if (dirtyFrameSignatures.current.get(currentFrameKey) === signature) {
        dirtyFrameSignatures.current.delete(currentFrameKey)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (error) {
      if (mode === "manual") {
        setSaveError(error instanceof Error ? error.message : "Erro ao salvar anotacoes.")
      }
    } finally {
      setSaving(false)
    }
  }, [currentFrame, currentFrameKey, currentTask?.external_id, currentUser.email, currentUser.id, shapes])

  const handleSave = () => {
    void persistCurrentFrame("manual")
  }

  useEffect(() => {
    if (!dirtyFrameSignatures.current.has(currentFrameKey)) return
    if (classPicker) return
    if (shapes.some((shape) => !shape.cls.trim())) return
    const timeout = window.setTimeout(() => {
      void persistCurrentFrame("auto")
    }, 350)
    return () => window.clearTimeout(timeout)
  }, [classPicker, currentFrameKey, persistCurrentFrame, shapes])

  const cursor =
    tool === "pan" ? "grab" : tool === "box" || tool === "polygon" || tool === "point" ? "crosshair" : "default"

  const pct = (v: number) => `${v * 100}%`

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:flex-row">
      {/* Tool rail */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2 lg:flex-col lg:border-b-0 lg:border-r lg:py-4">
        {tools.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => {
              setReturnToolAfterSelect(null)
              setTempTool(null)
              setTool(t.tool)
            }}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            aria-pressed={(tempTool ?? tool) === t.tool}
            className={cn(
              "flex size-10 items-center justify-center rounded-lg transition-colors",
              (tempTool ?? tool) === t.tool
                ? "bg-brand-blue text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <t.icon className="size-5" />
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Imagem anterior"
              onClick={() => setImageIndex((i) => Math.max(1, i - 1))}
              disabled={imageIndex <= 1}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular-nums text-muted-foreground">
              {imageIndex.toLocaleString("pt-BR")} / {totalImages.toLocaleString("pt-BR")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Próxima imagem"
              onClick={() => setImageIndex((i) => Math.min(totalImages, i + 1))}
              disabled={imageIndex >= totalImages}
            >
              <ChevronRight className="size-4" />
            </Button>
            <span className="ml-2 font-medium text-foreground">
              {currentTask ? currentTask.name : `Imagem ${String(imageIndex).padStart(6, "0")}.jpg`}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Desfazer" onClick={undo} disabled={past.current.length === 0}>
              <Undo2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refazer"
              onClick={redo}
              disabled={future.current.length === 0}
            >
              <Redo2 className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Diminuir zoom" onClick={() => zoomBy(1 / 1.2)}>
              <ZoomOut className="size-4" />
            </Button>
            <button
              type="button"
              onClick={resetView}
              title="Redefinir zoom"
              className="min-w-12 rounded px-1 text-xs tabular-nums text-muted-foreground hover:text-foreground"
            >
              {Math.round(view.s * 100)}%
            </button>
            <Button variant="ghost" size="icon" aria-label="Aumentar zoom" onClick={() => zoomBy(1.2)}>
              <ZoomIn className="size-4" />
            </Button>
            <Button size="sm" className="ml-1" onClick={handleSave} disabled={saving}>
              {saved ? <Check className="size-4" /> : <Save className="size-4" />}
              {saving ? "Salvando" : saved ? "Salvo" : "Salvar"}
            </Button>
          </div>
        </div>
        {saveError && (
          <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {saveError}
          </div>
        )}

        <div
          ref={containerRef}
          className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#0b0d10] p-6 touch-none select-none"
        >
          <div
            ref={stageRef}
            className="relative aspect-[16/9] w-full max-w-4xl overflow-hidden rounded-lg shadow-2xl"
            style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`, cursor }}
            onPointerDown={onStagePointerDown}
            onPointerMove={(e) => {
              if (toolRef.current === "polygon" && polyDraftRef.current?.length) {
                const p = clientToNorm(e.clientX, e.clientY)
                setCursorNorm({ x: clamp(p.x), y: clamp(p.y) })
              }
            }}
            onPointerLeave={() => setCursorNorm(null)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewSrc}
              alt="Cena de rua para anotação"
              className="pointer-events-none size-full object-cover"
              draggable={false}
            />

            {/* Committed shapes */}
            {shapes.map((s) => {
              const color = colorFor(s.cls)
              const selected = s.id === selectedId
              if (s.type === "box") {
                return (
                  <div
                    key={s.id}
                    onPointerDown={(e) => startMove(e, s)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      const r = containerRef.current?.getBoundingClientRect()
                      if (!r) return
                      setSelectedId(s.id)
                      setClassQuery("")
                      setClassPicker({ id: s.id, x: e.clientX - r.left, y: e.clientY - r.top })
                    }}
                    className={cn("absolute rounded-[3px] border-2", tool !== "pan" && tool !== "tag" && "cursor-move")}
                    style={{
                      left: pct(s.x),
                      top: pct(s.y),
                      width: pct(s.w),
                      height: pct(s.h),
                      borderColor: color,
                      boxShadow: selected ? `0 0 0 2px var(--background), 0 0 0 4px ${color}` : undefined,
                    }}
                  >
                    <span
                      className="pointer-events-none absolute -top-[22px] left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-white"
                      style={{ backgroundColor: color, transform: `scale(${1 / view.s})`, transformOrigin: "bottom left" }}
                    >
                      {s.cls || "definir classe..."}
                      {s.conf ? ` ${s.conf}` : ""}
                    </span>
                    {selected &&
                      tool === "select" &&
                      handles.map((h) => (
                        <span
                          key={h.id}
                          onPointerDown={(e) => startResize(e, s, h.id)}
                          className={cn("absolute rounded-sm border border-white bg-brand-blue", h.cls)}
                          style={{
                            width: `${9 / view.s}px`,
                            height: `${9 / view.s}px`,
                            cursor: h.cursor,
                          }}
                        />
                      ))}
                  </div>
                )
              }
              if (s.type === "point") {
                return (
                  <button
                    key={s.id}
                    type="button"
                    onPointerDown={(e) => startMove(e, s)}
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                    style={{
                      left: pct(s.x),
                      top: pct(s.y),
                      width: 14 / view.s,
                      height: 14 / view.s,
                      backgroundColor: color,
                      boxShadow: selected ? `0 0 0 ${3 / view.s}px ${color}` : undefined,
                    }}
                    aria-label={`Ponto ${s.cls}`}
                  />
                )
              }
              // polygon
              const pointsAttr = s.points.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")
              return (
                <svg
                  key={s.id}
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 size-full"
                >
                  <polygon
                    points={pointsAttr}
                    fill={color}
                    fillOpacity={selected ? 0.28 : 0.16}
                    stroke={color}
                    strokeWidth={selected ? 2.5 : 1.75}
                    vectorEffect="non-scaling-stroke"
                    className="pointer-events-auto cursor-move"
                    onPointerDown={(e) => startMove(e as unknown as React.PointerEvent, s)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (toolRef.current === "polygon" && polyDraftRef.current?.length) return
                      const r = containerRef.current?.getBoundingClientRect()
                      if (!r) return
                      setSelectedId(s.id)
                      setClassQuery("")
                      setClassPicker({ id: s.id, x: e.clientX - r.left, y: e.clientY - r.top })
                    }}
                  />
                </svg>
              )
            })}

            {/* Sugestões de autoanotação (status: proposed) — visual diferenciado das anotações manuais */}
            {suggestions
              .filter((s) => !hiddenLayers.includes(s.origin.model_id))
              .map((s) => {
                const color = colorFor(s.cls)
                return (
                  <div
                    key={`sug-${s.id}`}
                    className="pointer-events-none absolute rounded-[3px] border-2 border-dashed"
                    style={{
                      left: pct(s.x),
                      top: pct(s.y),
                      width: pct(s.w),
                      height: pct(s.h),
                      borderColor: color,
                      backgroundColor: `color-mix(in oklch, ${color} 10%, transparent)`,
                    }}
                  >
                    <span
                      className="pointer-events-none absolute -top-[22px] left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-white/95"
                      style={{
                        backgroundColor: `color-mix(in oklch, ${color} 75%, black)`,
                        transform: `scale(${1 / view.s})`,
                        transformOrigin: "bottom left",
                      }}
                    >
                      {s.cls} {s.conf.toFixed(2)} · {modelLabelFor(s.origin.model_id, s.origin.model_version)}
                    </span>
                  </div>
                )
              })}

            {/* Box draft */}
            {draft && (
              <div
                className="pointer-events-none absolute rounded-[3px] border-2 border-dashed"
                style={{
                  left: pct(draft.x),
                  top: pct(draft.y),
                  width: pct(draft.w),
                  height: pct(draft.h),
                  borderColor: colorFor(activeClass ?? ""),
                  backgroundColor: "color-mix(in oklch, " + colorFor(activeClass ?? "") + " 18%, transparent)",
                }}
              />
            )}

            {/* Polygon draft */}
            {polyDraft &&
              polyDraft.length > 0 &&
              (() => {
                const color = colorFor(activeClass ?? "")
                const last = polyDraft[polyDraft.length - 1]
                const first = polyDraft[0]
                const nearFirst =
                  polyDraft.length >= 3 &&
                  !!cursorNorm &&
                  Math.hypot(cursorNorm.x - first.x, cursorNorm.y - first.y) < POLY_CLOSE_DIST
                const previewPts = cursorNorm ? [...polyDraft, cursorNorm] : polyDraft
                return (
                  <>
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      className="pointer-events-none absolute inset-0 size-full"
                    >
                      {previewPts.length >= 3 && (
                        <polygon
                          points={previewPts.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
                          fill={color}
                          fillOpacity={0.15}
                          stroke="none"
                        />
                      )}
                      {/* placed segments */}
                      <polyline
                        points={polyDraft.map((p) => `${p.x * 100},${p.y * 100}`).join(" ")}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* rubber-band segment to cursor */}
                      {cursorNorm && (
                        <line
                          x1={last.x * 100}
                          y1={last.y * 100}
                          x2={cursorNorm.x * 100}
                          y2={cursorNorm.y * 100}
                          stroke={color}
                          strokeWidth={1.75}
                          strokeDasharray="3 2"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {/* closing hint back to the first vertex */}
                      {polyDraft.length >= 2 && cursorNorm && (
                        <line
                          x1={cursorNorm.x * 100}
                          y1={cursorNorm.y * 100}
                          x2={first.x * 100}
                          y2={first.y * 100}
                          stroke={color}
                          strokeWidth={1.25}
                          strokeDasharray="2 3"
                          strokeOpacity={nearFirst ? 0.9 : 0.4}
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </svg>
                    {polyDraft.map((p, i) => {
                      const isFirst = i === 0
                      const highlight = isFirst && nearFirst
                      const size = (isFirst ? 13 : 9) / view.s
                      return (
                        <span
                          key={i}
                          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                          style={{
                            left: pct(p.x),
                            top: pct(p.y),
                            width: size,
                            height: size,
                            backgroundColor: highlight ? "#fff" : color,
                            boxShadow: highlight ? `0 0 0 ${3 / view.s}px ${color}` : undefined,
                          }}
                        />
                      )
                    })}
                  </>
                )
              })()}
          </div>

          {/* Picker de classe com autocomplete: após desenhar ou por duplo clique */}
          {classPicker && (
            <div
              role="dialog"
              aria-label={classPicker.isNew ? "Definir classe do novo objeto" : "Trocar classe do objeto"}
              className="absolute z-20 w-56 rounded-lg border border-border bg-popover p-2 shadow-xl"
              style={{
                left: clamp(classPicker.x, 8, (containerRef.current?.clientWidth ?? 400) - 232),
                top: clamp(classPicker.y, 8, (containerRef.current?.clientHeight ?? 300) - 300),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {classPicker.filterParent
                  ? `Subclasse de ${classPicker.filterParent}`
                  : classPicker.isNew
                    ? "Definir classe"
                    : "Trocar classe"}
              </p>
              <input
                autoFocus
                value={classQuery}
                onChange={(e) => setClassQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation()
                    cancelPicker()
                    return
                  }
                  if (e.key === "Enter" && pickerSuggestions.length > 0) {
                    e.preventDefault()
                    applyPickerClass(pickerSuggestions[0].name)
                    return
                  }
                  if (e.key === "Enter") {
                    e.preventDefault()
                    createAndApplyPickerClass()
                  }
                }}
                placeholder="Digite o nome da classe..."
                aria-label="Nome da classe"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-brand-blue"
              />
              <ul className="mt-1 flex max-h-52 flex-col overflow-y-auto" role="listbox" aria-label="Sugestões de classe">
                {pickerSuggestions.length === 0 && (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma classe encontrada.</li>
                )}
                {pickerSuggestions.map((c, i) => {
                  const currentCls = shapes.find((s) => s.id === classPicker.id)?.cls
                  return (
                    <li key={c.name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === 0}
                        onClick={() => applyPickerClass(c.name)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          i === 0 && "bg-muted/60",
                          c.parent && !classPicker.filterParent && "pl-6",
                        )}
                      >
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {currentCls === c.name && <Check className="size-3.5 shrink-0 text-brand-blue" />}
                        {i === 0 && currentCls !== c.name && (
                          <kbd className="shrink-0 rounded bg-background px-1 text-[10px] text-muted-foreground">
                            Enter
                          </kbd>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* Hint */}
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80 backdrop-blur">
            {tool === "box" &&
              (activeClass
                ? `Arraste para desenhar como "${activeClass}" · duplo clique troca a classe`
                : "Arraste para desenhar · escolha a classe depois no autocomplete")}
            {tool === "polygon" &&
              (polyDraft?.length
                ? "Clique no primeiro ponto para fechar · Enter ou duplo-clique finaliza · Esc cancela"
                : "Clique para adicionar o primeiro vértice do polígono")}
            {tool === "point" && "Clique para adicionar um ponto"}
            {tool === "pan" && "Arraste para mover · scroll para zoom"}
            {tool === "select" && "Clique para selecionar · arraste para mover · Delete remove"}
            {tool === "tag" &&
              (activeClass
                ? `Clique em um objeto para aplicar "${activeClass}"`
                : "Clique em um objeto para escolher a classe")}
          </div>
        </div>

        {/* Filmstrip: preview das imagens vizinhas do lote */}
        <div className="flex items-center gap-2 border-t border-border bg-card px-3 py-2">
          <button
            type="button"
            aria-label="Retroceder 10 imagens"
            onClick={() => setImageIndex((i) => Math.max(1, i - 10))}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronsLeft className="size-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {(() => {
              const windowSize = Math.min(10, totalImages)
              const windowStart = Math.max(1, Math.min(imageIndex - 4, totalImages - windowSize + 1))
              return Array.from({ length: windowSize }, (_, i) => windowStart + i).map((n) => {
                const isCurrent = n === imageIndex
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setImageIndex(n)}
                    aria-label={`Ir para a imagem ${n}`}
                    aria-current={isCurrent ? "true" : undefined}
                    className={cn(
                      "relative aspect-video h-12 shrink-0 overflow-hidden rounded-md border-2 transition-colors",
                      isCurrent ? "border-brand-blue" : "border-transparent hover:border-border",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={taskFrameAssetUrl(currentTaskId, n - 1) ?? "/placeholder.svg"}
                      alt={`Imagem ${n}`}
                      className="size-full object-cover"
                    />
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[9px] tabular-nums text-white">
                      {n}
                    </span>
                  </button>
                )
              })
            })()}
          </div>
          <button
            type="button"
            aria-label="Avançar 10 imagens"
            onClick={() => setImageIndex((i) => Math.min(totalImages, i + 10))}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Right panel */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border bg-card p-4 lg:w-80 lg:border-l lg:border-t-0">
        <Card>
          <CardHeader>
            <CardTitle>Classes</CardTitle>
            <span className="text-xs text-muted-foreground">Atalhos 1-9</span>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {classList.map((c, i) => {
              const isActive = activeClass === c.name
              const shortcutIndex = classList.filter((x) => !x.parent).findIndex((x) => x.name === c.name)
              return (
                <div key={c.name} className="flex flex-col">
                  <div
                    className={cn(
                      "group flex items-center justify-between rounded-lg transition-colors",
                      isActive ? "bg-muted ring-1 ring-brand-blue/40" : "hover:bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveClass((prev) => (prev === c.name ? null : c.name))}
                      aria-pressed={isActive}
                      title={isActive ? "Clique para desmarcar" : undefined}
                      className={cn("flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm", c.parent && "pl-6")}
                    >
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                      <span className="truncate text-foreground">{c.name}</span>
                    </button>
                    <span className="flex shrink-0 items-center gap-1 pr-2">
                      {isActive && !c.parent && (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingClass({ parent: c.name })
                            setNewClassName("")
                          }}
                          title={`Adicionar subclasse em ${c.name}`}
                          aria-label={`Adicionar subclasse em ${c.name}`}
                          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      )}
                      {!c.parent && shortcutIndex >= 0 && shortcutIndex < 9 && (
                        <kbd className="rounded bg-background px-1.5 text-xs text-muted-foreground">
                          {shortcutIndex + 1}
                        </kbd>
                      )}
                    </span>
                  </div>
                  {/* Input inline para nova subclasse desta classe */}
                  {addingClass?.parent === c.name && (
                    <form
                      className="mt-1 flex items-center gap-1.5 pl-6"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const name = createClassItem(newClassName, c.name)
                        if (!name) return
                        setAddingClass(null)
                        setNewClassName("")
                      }}
                    >
                      <input
                        autoFocus
                        value={newClassName}
                        onChange={(e) => setNewClassName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setAddingClass(null)
                        }}
                        placeholder={`Subclasse de ${c.name}...`}
                        aria-label={`Nome da subclasse de ${c.name}`}
                        className="h-7 min-w-0 flex-1 rounded-md bg-muted px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                      />
                      <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-xs">
                        OK
                      </Button>
                    </form>
                  )}
                </div>
              )
            })}

            {/* Nova classe raiz */}
            {addingClass && addingClass.parent === null ? (
              <form
                className="mt-1 flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = createClassItem(newClassName)
                  if (!name) return
                  setActiveClass(name)
                  setAddingClass(null)
                  setNewClassName("")
                }}
              >
                <input
                  autoFocus
                  value={newClassName}
                  onChange={(e) => setNewClassName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddingClass(null)
                  }}
                  placeholder="Nome da nova classe..."
                  aria-label="Nome da nova classe"
                  className="h-8 min-w-0 flex-1 rounded-md bg-muted px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                />
                <Button type="submit" size="sm" variant="outline" className="h-8 px-2 text-xs">
                  OK
                </Button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAddingClass({ parent: null })
                  setNewClassName("")
                }}
                className="mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-brand-blue hover:bg-muted"
              >
                <Plus className="size-4" />
                Nova classe
              </button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Objetos ({shapes.length})</CardTitle>
            {selectedId != null && (
              <button
                type="button"
                onClick={deleteSelected}
                className="flex items-center gap-1 text-xs text-destructive hover:underline"
              >
                <Trash2 className="size-3.5" />
                Remover
              </button>
            )}
          </CardHeader>
          <CardContent className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {shapes.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">Nenhum objeto ainda.</p>}
            {shapes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                aria-pressed={selectedId === s.id}
                className={cn(
                  "flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors",
                  selectedId === s.id ? "bg-muted ring-1 ring-brand-blue/40" : "hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-2 text-foreground">
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: colorFor(s.cls) }} />
                  {s.cls}
                  <span className="text-xs text-muted-foreground">
                    {s.type === "box" ? "caixa" : s.type === "polygon" ? "polígono" : "ponto"}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">#{s.id}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        <AutoAnnotationCard
          models={annotationModels}
          classNames={classList.map((c) => c.name)}
          imageIndex={imageIndex}
          totalImages={totalImages}
          layers={predictionLayers}
          suggestionModelIds={[...new Set(suggestions.map((s) => s.origin.model_id))]}
          onGenerate={generateSuggestions}
          onClearSuggestions={() => {
            if (!currentTask) return
            deleteInferenceSuggestions({ taskExternalId: currentTask.external_id })
              .then(() => loadSuggestions())
              .catch(() => setBackendSuggestions([]))
            setHiddenLayers([])
          }}
          onToggleLayer={(modelId) =>
            setHiddenLayers((prev) =>
              prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId],
            )
          }
          onRemoveLayer={(modelId) => {
            if (currentTask) {
              deleteInferenceSuggestions({ taskExternalId: currentTask.external_id, modelId })
                .then(() => loadSuggestions())
                .catch(() =>
                  setBackendSuggestions((prev) =>
                    prev.filter((suggestion) => suggestion.model_id !== modelId),
                  ),
                )
            }
            setHiddenLayers((prev) => prev.filter((id) => id !== modelId))
          }}
        />
      </aside>
    </div>
  )
}

function modelFamilyFor(model: ModelInfo): "detection" | "segmentation" | "classification" | "tracking" {
  return model.family
}

function baseModelFor(model: ModelInfo) {
  return model.baseModel
}

function modelInfoFromBackend(model: BackendModelVersion): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    version: model.version,
    task: modelTaskLabel(model.family),
    status: modelStatusLabel(model.status),
    family: modelFamilyValue(model.family),
    baseModel: model.base_model,
  }
}

function modelTaskLabel(family: string): ModelInfo["task"] {
  if (family === "segmentation") return "Segmentação"
  if (family === "classification") return "Classificação"
  if (family === "tracking") return "Detecção"
  return "Detecção"
}

function modelStatusLabel(status: string): ModelInfo["status"] {
  if (status === "archived") return "Indisponível"
  if (["training", "building", "importing"].includes(status)) return "Carregando"
  return "Disponível"
}

function modelFamilyValue(family: string): ModelInfo["family"] {
  if (family === "segmentation" || family === "classification" || family === "tracking") return family
  return "detection"
}

function mapBackendSuggestion(suggestion: BackendInferenceSuggestion): Suggestion {
  const rawBox = suggestion.raw.bbox_norm
  const box =
    rawBox && typeof rawBox === "object"
      ? (rawBox as { x?: number; y?: number; w?: number; h?: number })
      : pointsToBox(suggestion.points)
  return {
    id: numericIdFromString(suggestion.id),
    cls: suggestion.label_name ?? "unknown",
    conf: suggestion.score ?? 0,
    x: clamp(Number(box.x ?? 0)),
    y: clamp(Number(box.y ?? 0)),
    w: clamp(Number(box.w ?? 0.05)),
    h: clamp(Number(box.h ?? 0.05)),
    status: "proposed",
    origin: {
      model_id: suggestion.model_id,
      model_version: suggestion.model_version,
      confidence: suggestion.score ?? 0,
      threshold_used: suggestion.threshold ?? 0,
      nms_iou: suggestion.nms_iou ?? 0,
      timestamp: String(suggestion.origin.timestamp ?? suggestion.created_at),
      scope: `frame ${suggestion.frame}`,
      user_id: String(suggestion.origin.user_id ?? "model"),
    },
  }
}

function shapeToManualAnnotation(shape: Shape): BackendManualAnnotationShape {
  if (shape.type === "box") {
    return {
      client_id: String(shape.id),
      shape_type: "rectangle",
      label_name: shape.cls,
      points: [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h],
      bbox_norm: { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
    }
  }
  if (shape.type === "polygon") {
    const points = shape.points.flatMap((point) => [point.x, point.y])
    return {
      client_id: String(shape.id),
      shape_type: "polygon",
      label_name: shape.cls,
      points,
      bbox_norm: bboxFromNormalizedPoints(points),
    }
  }
  return {
    client_id: String(shape.id),
    shape_type: "points",
    label_name: shape.cls,
    points: [shape.x, shape.y],
    bbox_norm: { x: shape.x, y: shape.y, w: 0, h: 0 },
  }
}

function frameShapesSignature(shapes: Shape[]) {
  return JSON.stringify(
    shapes.map((shape) => {
      if (shape.type === "box") {
        return [shape.id, shape.type, shape.cls, shape.x, shape.y, shape.w, shape.h]
      }
      if (shape.type === "polygon") {
        return [shape.id, shape.type, shape.cls, ...shape.points.flatMap((point) => [point.x, point.y])]
      }
      return [shape.id, shape.type, shape.cls, shape.x, shape.y]
    }),
  )
}

function shapeFromAnnotationRecord(record: BackendAnnotationRecord): Shape | null {
  const label = record.label_name ?? stringFromRecord(record.raw, "label_name") ?? "unknown"
  const id = numericIdFromString(record.external_id)
  const shapeType = record.shape_type ?? stringFromRecord(record.raw, "type")
  const pointsNorm = numberArrayFromUnknown(record.raw.points_norm)

  if (shapeType === "polygon" && pointsNorm.length >= 6) {
    return {
      id,
      type: "polygon",
      cls: label,
      points: pairsFromNormalizedPoints(pointsNorm),
    }
  }

  if ((shapeType === "points" || shapeType === "point") && pointsNorm.length >= 2) {
    return { id, type: "point", cls: label, x: clamp(pointsNorm[0]), y: clamp(pointsNorm[1]) }
  }

  const bbox = normalizedBoxFromRecord(record.raw.bbox_norm)
  if (bbox) return { id, type: "box", cls: label, ...bbox }

  const points = numberArrayFromUnknown(record.points)
  if (points.length >= 4 && points.every((value) => value >= 0 && value <= 1)) {
    const box = bboxFromNormalizedPoints(points)
    if (box) return { id, type: "box", cls: label, ...box }
  }

  return null
}

function mergeAnnotationClasses(classList: ClassItem[], records: BackendAnnotationRecord[]) {
  const next = [...classList]
  for (const record of records) {
    const name = record.label_name ?? stringFromRecord(record.raw, "label_name")
    if (!name) continue
    if (next.some((item) => item.name.toLowerCase() === name.toLowerCase())) continue
    next.push({ name, color: newClassPalette[next.length % newClassPalette.length] })
  }
  return next
}

function normalizedBoxFromRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const w = Number(record.w)
  const h = Number(record.h)
  if (![x, y, w, h].every((number) => Number.isFinite(number))) return null
  return { x: clamp(x), y: clamp(y), w: clamp(w), h: clamp(h) }
}

function bboxFromNormalizedPoints(points: number[]) {
  if (points.length < 4) return null
  const xs = points.filter((_, index) => index % 2 === 0)
  const ys = points.filter((_, index) => index % 2 === 1)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null
  return {
    x: clamp(minX),
    y: clamp(minY),
    w: clamp(maxX - minX),
    h: clamp(maxY - minY),
  }
}

function pairsFromNormalizedPoints(points: number[]) {
  const pairs: { x: number; y: number }[] = []
  for (let index = 0; index + 1 < points.length; index += 2) {
    pairs.push({ x: clamp(points[index]), y: clamp(points[index + 1]) })
  }
  return pairs
}

function numberArrayFromUnknown(value: unknown) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []
}

function stringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : null
}

function pointsToBox(points: unknown[]) {
  const values = points.map(Number).filter(Number.isFinite)
  if (values.length >= 4) {
    const [x1, y1, x2, y2] = values
    const width = Math.max(1, Math.max(x1, x2))
    const height = Math.max(1, Math.max(y1, y2))
    return {
      x: Math.min(x1, x2) / width,
      y: Math.min(y1, y2) / height,
      w: Math.abs(x2 - x1) / width,
      h: Math.abs(y2 - y1) / height,
    }
  }
  return { x: 0, y: 0, w: 0.05, h: 0.05 }
}

function numericIdFromString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}
