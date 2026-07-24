"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Trash2,
  Check,
  Plus,
  MoreHorizontal,
  Pencil,
  ArrowRightLeft,
  X,
  AlertTriangle,
  FolderKanban,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  createInferenceRun,
  deleteLabel,
  deleteInferenceSuggestions,
  fetchLabelImpact,
  fetchLabels,
  fetchModelVersions,
  fetchInferenceSuggestions,
  fetchReviewAnnotations,
  fetchTaskDataMeta,
  fetchTasks,
  jobsEventsUrl,
  mapLabel,
  renameLabel,
  saveManualAnnotations,
  taskFrameAssetUrl,
  updateLabelColor,
  updateInferenceSuggestionStatus,
} from "@/lib/api/client"
import { labelsFromTasks } from "@/lib/api/status"
import { useCurrentUser } from "@/lib/auth/user-context"
import type {
  BackendAnnotationRecord,
  BackendCvatLabel,
  BackendLabelImpact,
  BackendInferenceSuggestion,
  BackendManualAnnotationShape,
  BackendModelVersion,
  BackendTask,
  BackendTaskDataMeta,
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
type ClassActionMode = "rename" | "map" | "delete"
type ClassActionTarget = { mode: ClassActionMode; cls: ClassItem }

const initialClassList: ClassItem[] = []

const newClassPalette = [
  "#4f8cff",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
  "#6366f1",
  "#eab308",
]

type Shape =
  | { id: number; type: "box"; cls: string; conf?: number; x: number; y: number; w: number; h: number }
  | { id: number; type: "polygon"; cls: string; points: { x: number; y: number }[] }
  | { id: number; type: "point"; cls: string; x: number; y: number }

const initialShapes: Shape[] = []

type FrameDimensions = { width: number; height: number }
type StageSize = { width: number; height: number }

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
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tasks, setTasks] = useState<BackendTask[] | null>(null)
  const [backendLabels, setBackendLabels] = useState<BackendCvatLabel[]>([])
  const [taskMeta, setTaskMeta] = useState<BackendTaskDataMeta | null>(null)
  const [modelVersions, setModelVersions] = useState<BackendModelVersion[]>([])
  const { currentUser, activeProject, projects } = useCurrentUser()
  const activeProjectId = activeProject?.id ?? projects[0]?.id ?? null
  const activeProjectExternalId = activeProject?.externalId ?? projects[0]?.externalId ?? null
  const selectedTaskId = searchParams.get("task")
  const currentTask = useMemo(() => {
    if (!activeProjectExternalId) return null
    if (!tasks?.length) return null
    if (!selectedTaskId) return tasks[0]
    return tasks.find((task) => task.external_id === selectedTaskId || task.id === selectedTaskId) ?? null
  }, [activeProjectExternalId, selectedTaskId, tasks])
  const currentProjectExternalId = currentTask?.project_external_id ?? activeProjectExternalId
  const currentProjectId =
    (currentProjectExternalId
      ? projects.find((project) => project.externalId === currentProjectExternalId)?.id
      : null) ??
    activeProjectId
  const currentClassScopeKey = classScopeKey(currentProjectExternalId)
  const projectTasks = useMemo(() => {
    if (!tasks?.length) return []
    if (!currentTask) return tasks
    return currentProjectExternalId
      ? tasks.filter((task) => task.project_external_id === currentProjectExternalId)
      : tasks.filter((task) => !task.project_external_id)
  }, [currentProjectExternalId, currentTask, tasks])
  const [localProjectClasses, setLocalProjectClasses] = useState<Record<string, ClassItem[]>>({})
  const projectClassCatalog = useMemo(
    () =>
      mergeClassItems(
        localProjectClasses[currentClassScopeKey] ?? [],
        classItemsFromBackendLabels(backendLabels, projectTasks, currentProjectExternalId),
        labelsFromTasks(projectTasks).map((label) => ({ name: label.name, color: label.color })),
      ),
    [backendLabels, currentClassScopeKey, currentProjectExternalId, localProjectClasses, projectTasks],
  )
  const annotationModels = modelVersions
    .filter((model) => model.status !== "archived")
    .map(modelInfoFromBackend)
  const totalImages = Math.max(1, currentTask?.size ?? 1)
  const [tool, setTool] = useState<ToolKey>("box")
  const [classList, setClassList] = useState<ClassItem[]>(() => initialClassList)
  // Nenhuma classe ativa por padrão: o usuário desenha primeiro e escolhe a classe depois.
  const [activeClass, setActiveClass] = useState<string | null>(null)
  const [classActionMenu, setClassActionMenu] = useState<string | null>(null)
  const [classActionDialog, setClassActionDialog] = useState<ClassActionTarget | null>(null)
  const [classActionValue, setClassActionValue] = useState("")
  const [classActionImpact, setClassActionImpact] = useState<BackendLabelImpact | null>(null)
  const [classActionError, setClassActionError] = useState<string | null>(null)
  const [classActionSubmitting, setClassActionSubmitting] = useState(false)
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
  const [isPanning, setIsPanning] = useState(false)
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [polyDraft, setPolyDraft] = useState<{ x: number; y: number }[] | null>(null)
  const polyDraftRef = useRef(polyDraft)
  polyDraftRef.current = polyDraft
  const [cursorNorm, setCursorNorm] = useState<{ x: number; y: number } | null>(null)
  const lastPolyClick = useRef(0)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dismissedCanvasHints, setDismissedCanvasHints] = useState<Record<string, true>>({})
  const [activeSuggestionHints, setActiveSuggestionHints] = useState<Record<string, true>>({})
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState({ classes: false, objects: false })
  const toggleRightPanelSection = (section: "classes" | "objects") => {
    setRightPanelCollapsed((current) => ({ ...current, [section]: !current[section] }))
  }

  // ---- Navegação de imagens ----
  const [imageIndex, setImageIndex] = useState(0)
  const [onlyUnannotated, setOnlyUnannotated] = useState(false)
  const [annotatedFrames, setAnnotatedFrames] = useState<Set<number>>(() => new Set())
  const loadedAnnotationKeys = useRef(new Set<string>())
  const dirtyFrameSignatures = useRef(new Map<string, string>())
  const handledJobEvents = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    if (!activeProjectExternalId) {
      setTasks([])
      setModelVersions([])
      return () => controller.abort()
    }
    fetchTasks({ projectExternalId: activeProjectExternalId }, controller.signal)
      .then(setTasks)
      .catch(() => setTasks(null))
    if (currentProjectId) {
      fetchModelVersions({ projectId: currentProjectId }, controller.signal).then(setModelVersions).catch(() => setModelVersions([]))
    } else {
      setModelVersions([])
    }
    return () => controller.abort()
  }, [activeProjectExternalId, currentProjectId])

  useEffect(() => {
    const controller = new AbortController()
    if (!currentProjectExternalId) {
      setBackendLabels([])
      return () => controller.abort()
    }
    fetchLabels({ projectExternalId: currentProjectExternalId }, controller.signal)
      .then(setBackendLabels)
      .catch(() => setBackendLabels([]))
    return () => controller.abort()
  }, [currentProjectExternalId])

  useEffect(() => {
    setClassList(projectClassCatalog)
    setActiveClass((active) =>
      active && projectClassCatalog.some((label) => label.name === active) ? active : null,
    )
  }, [projectClassCatalog])

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
  const blockedAnnotationFrames = useMemo(() => {
    const frames = new Set<number>()
    for (const state of taskMeta?.frame_workflow_states ?? []) {
      if (state.status === "review_pending" || state.status === "approved") {
        frames.add(state.frame)
      }
    }
    if (taskAnnotationImportTarget(currentTask) === "review") {
      for (const frame of annotatedFrames) frames.add(frame)
    }
    return frames
  }, [annotatedFrames, currentTask, taskMeta?.frame_workflow_states])
  const hasAnnotatableFrame = useMemo(() => {
    for (let frame = 0; frame < totalImages; frame += 1) {
      if (!blockedAnnotationFrames.has(frame)) return true
    }
    return false
  }, [blockedAnnotationFrames, totalImages])
  const knownAnnotatedFrames = useMemo(() => {
    const frames = new Set(annotatedFrames)
    if (!currentTaskId) return frames
    const prefix = `${currentTaskId}:`
    for (const [frameKey, frameShapes] of Object.entries(shapesByFrame)) {
      if (!frameKey.startsWith(prefix)) continue
      if (!frameShapes.some((shape) => shape.cls.trim())) continue
      const frame = Number.parseInt(frameKey.slice(prefix.length), 10)
      if (Number.isInteger(frame) && frame >= 0) frames.add(frame)
    }
    return frames
  }, [annotatedFrames, currentTaskId, shapesByFrame])
  const frameAvailableForAnnotation = useCallback(
    (frame: number) => !blockedAnnotationFrames.has(frame),
    [blockedAnnotationFrames],
  )
  const findAnnotationImage = useCallback(
    (fromIndex: number, direction: -1 | 1, includeCurrent = false, onlyUnannotatedFilter = onlyUnannotated) => {
      for (
        let index = includeCurrent ? fromIndex : fromIndex + direction;
        index >= 1 && index <= totalImages;
        index += direction
      ) {
        const frame = index - 1
        if (!frameAvailableForAnnotation(frame)) continue
        if (onlyUnannotatedFilter && knownAnnotatedFrames.has(frame)) continue
        return index
      }
      return null
    },
    [frameAvailableForAnnotation, knownAnnotatedFrames, onlyUnannotated, totalImages],
  )
  const annotationQueueImages = useMemo(() => {
    const images: number[] = []
    for (let index = 1; index <= totalImages; index += 1) {
      const frame = index - 1
      if (!frameAvailableForAnnotation(frame)) continue
      if (onlyUnannotated && knownAnnotatedFrames.has(frame)) continue
      images.push(index)
    }
    return images
  }, [frameAvailableForAnnotation, knownAnnotatedFrames, onlyUnannotated, totalImages])
  const currentQueuePosition = annotationQueueImages.indexOf(imageIndex)
  const currentQueueNumber =
    annotationQueueImages.length === 0
      ? 0
      : currentQueuePosition >= 0
        ? currentQueuePosition + 1
        : Math.min(imageIndex, annotationQueueImages.length)
  const visibleQueueImages = useMemo(() => {
    const windowSize = Math.min(10, annotationQueueImages.length)
    if (windowSize === 0) return []
    const anchorIndex = currentQueuePosition >= 0 ? currentQueuePosition : 0
    const windowStart = Math.max(0, Math.min(anchorIndex - 4, annotationQueueImages.length - windowSize))
    return annotationQueueImages.slice(windowStart, windowStart + windowSize)
  }, [annotationQueueImages, currentQueuePosition])
  const navigateImage = useCallback(
    (direction: -1 | 1, step = 1) => {
      setImageIndex((index) => {
        let nextIndex = index
        for (let count = 0; count < step; count += 1) {
          const candidate = findAnnotationImage(nextIndex, direction)
          if (!candidate) break
          nextIndex = candidate
        }
        return nextIndex
      })
    },
    [findAnnotationImage],
  )
  const canGoPrevious = findAnnotationImage(imageIndex, -1) != null
  const canGoNext = findAnnotationImage(imageIndex, 1) != null
  const toggleOnlyUnannotated = (checked: boolean) => {
    setOnlyUnannotated(checked)
    if (!checked || !knownAnnotatedFrames.has(currentFrame)) return
    const nextImage =
      findAnnotationImage(imageIndex, 1, false, checked) ??
      findAnnotationImage(imageIndex, -1, false, checked)
    if (nextImage) setImageIndex(nextImage)
  }

  useEffect(() => {
    if (totalImages <= 0) return
    if (frameAvailableForAnnotation(currentFrame) && (!onlyUnannotated || !knownAnnotatedFrames.has(currentFrame))) return
    const nextImage =
      findAnnotationImage(imageIndex, 1, true) ??
      findAnnotationImage(imageIndex, -1)
    if (nextImage) setImageIndex(nextImage)
  }, [
    currentFrame,
    findAnnotationImage,
    frameAvailableForAnnotation,
    imageIndex,
    knownAnnotatedFrames,
    onlyUnannotated,
    totalImages,
  ])
  const [naturalFrameDimensionsByKey, setNaturalFrameDimensionsByKey] = useState<Record<string, FrameDimensions>>({})
  const currentFrameDimensions = useMemo(
    () => frameDimensionsFromMeta(taskMeta, currentFrame) ?? naturalFrameDimensionsByKey[currentFrameKey] ?? null,
    [currentFrame, currentFrameKey, naturalFrameDimensionsByKey, taskMeta],
  )
  const stageAspectRatio = currentFrameDimensions
    ? currentFrameDimensions.width / currentFrameDimensions.height
    : 16 / 9
  const shapes = shapesByFrame[currentFrameKey] ?? initialShapes

  useEffect(() => {
    setImageIndex(1)
    setSelectedId(null)
    setDraft(null)
    setPolyDraft(null)
    setClassPicker(null)
    setAnnotatedFrames(new Set())
  }, [currentTaskId])

  useEffect(() => {
    if (!currentTaskId) {
      setTaskMeta(null)
      return
    }
    const controller = new AbortController()
    fetchTaskDataMeta(currentTaskId, controller.signal)
      .then(setTaskMeta)
      .catch(() => {
        if (!controller.signal.aborted) setTaskMeta(null)
      })
    return () => controller.abort()
  }, [currentTaskId])

  useEffect(() => {
    const taskExternalId = currentTask?.external_id
    if (!taskExternalId) {
      setAnnotatedFrames(new Set())
      return
    }
    const controller = new AbortController()
    fetchReviewAnnotations({ taskExternalId }, controller.signal)
      .then((records) => {
        const frames = new Set<number>()
        records.forEach((record) => {
          if (!isEditableAnnotationRecord(record) || record.frame == null) return
          frames.add(record.frame)
        })
        setAnnotatedFrames(frames)
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnnotatedFrames(new Set())
      })
    return () => controller.abort()
  }, [currentTask?.external_id])

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

  const refreshCurrentFrameAnnotations = useCallback(
    async (signal?: AbortSignal, mode: "initial" | "refresh" = "refresh") => {
      const taskExternalId = currentTask?.external_id
      if (!taskExternalId || !currentFrameDimensions) return
      const records = await fetchReviewAnnotations({ taskExternalId, frame: currentFrame }, signal)
      loadedAnnotationKeys.current.add(currentFrameKey)
      const loadedShapes = shapesFromAnnotationRecords(records, currentFrameDimensions)
      if (loadedShapes.length > 0) {
        nextId.current = Math.max(nextId.current, Math.max(...loadedShapes.map((shape) => shape.id)) + 1)
      }
      setClassList((prev) => mergeAnnotationClasses(prev, records))
      setAnnotatedFrames((prev) => {
        const next = new Set(prev)
        if (loadedShapes.some((shape) => shape.cls.trim())) next.add(currentFrame)
        else next.delete(currentFrame)
        return next
      })
      setShapesByFrame((prev) => {
        const currentShapes = prev[currentFrameKey] ?? initialShapes
        if (mode === "initial" && currentShapes.length > 0) return prev
        const nextShapes =
          dirtyFrameSignatures.current.has(currentFrameKey) && currentShapes.length > 0
            ? mergeLoadedShapes(currentShapes, loadedShapes)
            : loadedShapes
        return { ...prev, [currentFrameKey]: nextShapes }
      })
    },
    [currentFrame, currentFrameDimensions, currentFrameKey, currentTask?.external_id],
  )

  useEffect(() => {
    const taskExternalId = currentTask?.external_id
    if (!taskExternalId || !currentFrameDimensions || loadedAnnotationKeys.current.has(currentFrameKey)) return
    const controller = new AbortController()
    refreshCurrentFrameAnnotations(controller.signal, "initial").catch(() => {
      if (!controller.signal.aborted) loadedAnnotationKeys.current.add(currentFrameKey)
    })
    return () => controller.abort()
  }, [currentFrameDimensions, currentFrameKey, currentTask?.external_id, refreshCurrentFrameAnnotations])

  const suggestions = backendSuggestions
    .filter((suggestion) => suggestion.frame === currentFrame)
    .map(mapBackendSuggestion)
  const visibleSuggestions = suggestions.filter((suggestion) => !hiddenLayers.includes(suggestion.origin.model_id))
  const suggestionHintKey = `suggestions:${currentFrameKey}`
  const showSuggestionHint = Boolean(
    (visibleSuggestions.length > 0 || activeSuggestionHints[suggestionHintKey]) && !dismissedCanvasHints[suggestionHintKey],
  )
  const toolHintText =
    tool === "box"
      ? activeClass
        ? `Arraste para desenhar como "${activeClass}" · duplo clique troca a classe`
        : "Arraste para desenhar · escolha a classe depois no autocomplete"
      : tool === "polygon"
        ? polyDraft?.length
          ? "Clique no primeiro ponto para fechar · Enter ou duplo-clique finaliza · Esc cancela"
          : "Clique para adicionar o primeiro vértice do polígono"
        : tool === "point"
          ? "Clique para adicionar um ponto"
          : tool === "pan"
            ? "Arraste para mover · scroll para zoom"
            : tool === "select"
              ? "Clique para selecionar · arraste para mover · Delete remove"
              : activeClass
                ? `Clique em um objeto para aplicar "${activeClass}"`
                : "Clique em um objeto para escolher a classe"
  const toolHintKey = `tool:${currentFrameKey}:${tool}:${activeClass ?? ""}:${polyDraft?.length ? "draft" : "idle"}`
  const dismissCanvasHint = (key: string) => {
    setDismissedCanvasHints((previous) => (previous[key] ? previous : { ...previous, [key]: true }))
  }

  useEffect(() => {
    if (visibleSuggestions.length === 0) return
    setActiveSuggestionHints((previous) =>
      previous[suggestionHintKey] ? previous : { ...previous, [suggestionHintKey]: true },
    )
  }, [suggestionHintKey, visibleSuggestions.length])

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
    if (!currentProjectId) return
    const source = new EventSource(jobsEventsUrl({ projectId: currentProjectId }))
    const onJobs = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          jobs?: {
            id?: string
            kind?: string
            status?: string
            task_external_id?: string | null
            raw?: Record<string, unknown>
            updated_at?: string
          }[]
        }
        const finalJobs = (payload.jobs ?? []).filter((job) =>
          ["succeeded", "failed", "canceled"].includes(String(job.status)),
        )
        const newFinalJobs = finalJobs.filter((job) => {
          const key = `${job.id ?? "job"}:${job.kind ?? ""}:${job.status ?? ""}:${job.updated_at ?? ""}`
          if (handledJobEvents.current.has(key)) return false
          handledJobEvents.current.add(key)
          return true
        })
        const currentTaskExternalId = currentTask?.external_id
        const hasFinishedInference = newFinalJobs.some(
          (job) => job.kind === "inference" && job.task_external_id === currentTaskExternalId,
        )
        const finishedImports = newFinalJobs.filter((job) => job.kind === "import")
        const hasCurrentTaskImport = finishedImports.some((job) => {
          const rawTaskId = typeof job.raw?.cvat_task_id === "string" ? job.raw.cvat_task_id : null
          return currentTaskExternalId && (job.task_external_id === currentTaskExternalId || rawTaskId === currentTaskExternalId)
        })
        if (finishedImports.length > 0 && activeProjectExternalId) {
          void fetchTasks({ projectExternalId: activeProjectExternalId }).then(setTasks).catch(() => null)
        }
        if (hasFinishedInference || hasCurrentTaskImport) {
          void loadSuggestions()
          loadedAnnotationKeys.current.delete(currentFrameKey)
          void refreshCurrentFrameAnnotations(undefined, "refresh")
        }
      } catch {
        // Ignore malformed SSE snapshots.
      }
    }
    source.addEventListener("jobs", onJobs as EventListener)
    source.onerror = () => source.close()
    return () => source.close()
  }, [
    activeProjectExternalId,
    currentFrameKey,
    currentProjectId,
    currentTask?.external_id,
    loadSuggestions,
    refreshCurrentFrameAnnotations,
  ])

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
    dedupeKey?: string
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
          dedupe_key: params.dedupeKey ? `${currentTask.external_id}:${model.id}:${params.dedupeKey}` : null,
        }),
      ),
    )
    setHiddenLayers((prev) => prev.filter((id) => !params.models.some((m) => m.id === id)))
    const suggestionRefreshDelays = [700, 1600, 3200]
    suggestionRefreshDelays.forEach((delay) => {
      window.setTimeout(() => {
        if (params.applyMode === "aceitas") {
          void refreshCurrentFrameAnnotations(undefined, "refresh").catch(() => undefined)
        } else {
          void loadSuggestions().catch(() => undefined)
        }
      }, delay)
    })

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
  const [stageSize, setStageSize] = useState<StageSize | null>(null)
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
      if ((e.target as HTMLElement | null)?.closest("[data-canvas-scroll-area]")) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const mx = e.clientX - cx
      const my = e.clientY - cy
      const { s, tx, ty } = viewRef.current
      const deltaY = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1)
      const factor = Math.exp(-deltaY * 0.0015)
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const k = ns / s
      setView({ s: ns, tx: mx - k * (mx - tx), ty: my - k * (my - ty) })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [currentTask?.id])

  const zoomBy = useCallback((factor: number) => {
    setView((v) => ({ ...v, s: clamp(v.s * factor, MIN_SCALE, MAX_SCALE) }))
  }, [])
  const resetView = useCallback(() => setView({ s: 1, tx: 0, ty: 0 }), [])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateStageSize = () => {
      const rect = container.getBoundingClientRect()
      const style = window.getComputedStyle(container)
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      const availableWidth = Math.max(1, rect.width - horizontalPadding)
      const availableHeight = Math.max(1, rect.height - verticalPadding)
      let width = availableWidth
      let height = width / stageAspectRatio
      if (height > availableHeight) {
        height = availableHeight
        width = height * stageAspectRatio
      }
      setStageSize((previous) => {
        if (previous && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) {
          return previous
        }
        return { width, height }
      })
    }

    updateStageSize()
    const observer = new ResizeObserver(updateStageSize)
    observer.observe(container)
    window.addEventListener("resize", updateStageSize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", updateStageSize)
    }
  }, [stageAspectRatio])

  const dragWindow = (
    onMove: (e: PointerEvent) => void,
    onUp?: (e: PointerEvent) => void,
    pointerCapture?: { target: Element; pointerId: number },
  ) => {
    const doc = containerRef.current?.ownerDocument ?? document
    const move = (e: PointerEvent) => onMove(e)
    const releasePointer = () => {
      if (!pointerCapture) return
      try {
        if (pointerCapture.target.hasPointerCapture?.(pointerCapture.pointerId)) {
          pointerCapture.target.releasePointerCapture(pointerCapture.pointerId)
        }
      } catch {
        // The browser may already have released the pointer.
      }
    }
    const up = (e: PointerEvent | Event) => {
      doc.removeEventListener("pointermove", move)
      doc.removeEventListener("pointerup", up)
      doc.removeEventListener("pointercancel", up)
      window.removeEventListener("blur", up)
      releasePointer()
      onUp?.(e as PointerEvent)
    }
    doc.addEventListener("pointermove", move)
    doc.addEventListener("pointerup", up)
    doc.addEventListener("pointercancel", up)
    window.addEventListener("blur", up)
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
    const item: ClassItem = { name, color: nextClassColor(classList, name), parent: parent ?? undefined }

    setClassList((prev) => insertClassItem(prev, item, parent))
    setLocalProjectClasses((prev) => {
      const current = mergeClassItems(prev[currentClassScopeKey] ?? [], classList)
      return { ...prev, [currentClassScopeKey]: insertClassItem(current, item, parent) }
    })

    return name
  }

  const updateClassColor = useCallback(
    (name: string, rawColor: string) => {
      const color = normalizeHexColor(rawColor)
      if (!color) return
      const applyColor = (items: ClassItem[]) =>
        items.map((item) => (item.name.toLowerCase() === name.toLowerCase() ? { ...item, color } : item))

      setClassList((prev) => applyColor(prev))
      setLocalProjectClasses((prev) => {
        const current = mergeClassItems(prev[currentClassScopeKey] ?? [], classList)
        return { ...prev, [currentClassScopeKey]: applyColor(current) }
      })
      void updateLabelColor({
        name,
        color,
        project_external_id: currentProjectExternalId,
        task_external_id: currentTask?.external_id ?? null,
      })
        .then((updated) => {
          setBackendLabels((prev) => mergeBackendLabels(prev, updated))
        })
        .catch(() => {
          // A cor permanece localmente; o próximo salvamento da anotação também envia label_color.
        })
    },
    [classList, currentClassScopeKey, currentProjectExternalId, currentTask?.external_id],
  )

  const classActionSourceName = classActionDialog?.cls.name ?? null

  useEffect(() => {
    if (!classActionMenu) return
    const close = () => setClassActionMenu(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [classActionMenu])

  useEffect(() => {
    if (!classActionSourceName) return
    const controller = new AbortController()
    setClassActionImpact(null)
    setClassActionError(null)
    fetchLabelImpact(
      {
        name: classActionSourceName,
        projectExternalId: currentProjectExternalId,
        taskExternalId: currentProjectExternalId ? null : currentTask?.external_id,
      },
      controller.signal,
    )
      .then(setClassActionImpact)
      .catch((error) => {
        if (!controller.signal.aborted) setClassActionError(classActionErrorMessage(error))
      })
    return () => controller.abort()
  }, [classActionSourceName, currentProjectExternalId, currentTask?.external_id])

  const openClassAction = (mode: ClassActionMode, cls: ClassItem) => {
    setClassActionMenu(null)
    setClassActionDialog({ mode, cls })
    setClassActionValue(mode === "rename" ? cls.name : "")
    setClassActionError(null)
    setClassActionImpact(null)
  }

  const rewriteLocalClassReferences = useCallback(
    (sourceName: string, targetName: string | null) => {
      const sourceLower = sourceName.toLowerCase()
      const targetLower = targetName?.toLowerCase() ?? null
      const rewriteItems = (items: ClassItem[]) => {
        if (!targetName) {
          return items
            .filter((item) => item.name.toLowerCase() !== sourceLower)
            .map((item) => (item.parent?.toLowerCase() === sourceLower ? { ...item, parent: undefined } : item))
        }
        const targetExists = items.some((item) => item.name.toLowerCase() === targetLower)
        return items
          .filter((item) => !(targetExists && item.name.toLowerCase() === sourceLower))
          .map((item) => {
            if (item.name.toLowerCase() === sourceLower) return { ...item, name: targetName }
            if (item.parent?.toLowerCase() === sourceLower) return { ...item, parent: targetName }
            return item
          })
      }

      setClassList((prev) => mergeClassItems(rewriteItems(prev)))
      setLocalProjectClasses((prev) => {
        const current = mergeClassItems(prev[currentClassScopeKey] ?? [], classList)
        return { ...prev, [currentClassScopeKey]: mergeClassItems(rewriteItems(current)) }
      })
      setActiveClass((current) => (current?.toLowerCase() === sourceLower ? targetName : current))

      if (targetName) {
        setShapesByFrame((prev) => {
          const next: Record<string, Shape[]> = {}
          let changed = false
          for (const [key, frameShapes] of Object.entries(prev)) {
            next[key] = frameShapes.map((shape) => {
              if (shape.cls.toLowerCase() !== sourceLower) return shape
              changed = true
              return { ...shape, cls: targetName }
            })
          }
          return changed ? next : prev
        })
        setBackendSuggestions((prev) =>
          prev.map((suggestion) =>
            suggestion.label_name?.toLowerCase() === sourceLower
              ? { ...suggestion, label_name: targetName }
              : suggestion,
          ),
        )
      } else {
        setBackendSuggestions((prev) =>
          prev.filter((suggestion) => suggestion.label_name?.toLowerCase() !== sourceLower),
        )
      }
    },
    [classList, currentClassScopeKey],
  )

  const refreshClassSources = useCallback(async () => {
    if (!currentProjectExternalId) {
      setBackendLabels([])
      setTasks([])
      return
    }
    const [labelRows, taskRows] = await Promise.all([
      fetchLabels({ projectExternalId: currentProjectExternalId }),
      fetchTasks({ projectExternalId: currentProjectExternalId }),
    ])
    setBackendLabels(labelRows)
    setTasks(taskRows)
  }, [currentProjectExternalId])

  const submitClassAction = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!classActionDialog) return
    const sourceName = classActionDialog.cls.name
    const targetName = classActionValue.trim()
    const scope = {
      project_external_id: currentProjectExternalId,
      task_external_id: currentProjectExternalId ? null : currentTask?.external_id ?? null,
    }

    if (classActionDialog.mode !== "delete" && !targetName) {
      setClassActionError("Informe a classe de destino.")
      return
    }
    if (classActionDialog.mode === "rename") {
      const targetExists = classList.some(
        (item) => item.name.toLowerCase() === targetName.toLowerCase() && item.name.toLowerCase() !== sourceName.toLowerCase(),
      )
      if (targetExists) {
        setClassActionError("Essa classe ja existe. Use mapear para juntar as classes.")
        return
      }
    }
    if (classActionDialog.mode === "delete") {
      const localUsage = Object.values(shapesByFrame).reduce(
        (total, frameShapes) =>
          total + frameShapes.filter((shape) => shape.cls.toLowerCase() === sourceName.toLowerCase()).length,
        0,
      )
      if (localUsage > 0) {
        setClassActionError("Ainda ha objetos carregados com essa classe. Mapeie para outra classe antes de excluir.")
        return
      }
    }

    setClassActionSubmitting(true)
    setClassActionError(null)
    try {
      if (classActionDialog.mode === "rename") {
        await renameLabel({ name: sourceName, new_name: targetName, ...scope })
        rewriteLocalClassReferences(sourceName, targetName)
      } else if (classActionDialog.mode === "map") {
        await mapLabel({ source_name: sourceName, target_name: targetName, ...scope })
        rewriteLocalClassReferences(sourceName, targetName)
      } else {
        await deleteLabel({
          name: sourceName,
          projectExternalId: scope.project_external_id,
          taskExternalId: scope.task_external_id,
        })
        rewriteLocalClassReferences(sourceName, null)
      }
      await refreshClassSources()
      setClassActionDialog(null)
      setClassActionValue("")
    } catch (error) {
      setClassActionError(classActionErrorMessage(error))
    } finally {
      setClassActionSubmitting(false)
    }
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
    (
      e: {
        clientX: number
        clientY: number
        pointerId?: number
        currentTarget?: EventTarget | null
        preventDefault?: () => void
        stopPropagation?: () => void
      },
      options: { temporary?: boolean } = {},
    ) => {
      e.preventDefault?.()
      e.stopPropagation?.()
      const useTemporaryPan = Boolean(options.temporary && toolRef.current !== "pan")
      if (useTemporaryPan) setTempTool("pan")
      setIsPanning(true)
      const pointerCapture =
        typeof e.pointerId === "number" && e.currentTarget instanceof Element
          ? { target: e.currentTarget, pointerId: e.pointerId }
          : undefined
      if (pointerCapture) {
        try {
          pointerCapture.target.setPointerCapture(pointerCapture.pointerId)
        } catch {
          // Some elements cannot capture the pointer; document listeners still handle the drag.
        }
      }
      const start = { x: e.clientX, y: e.clientY }
      const base = { ...viewRef.current }
      dragWindow(
        (ev) => {
          setView({ s: base.s, tx: base.tx + (ev.clientX - start.x), ty: base.ty + (ev.clientY - start.y) })
        },
        () => {
          setIsPanning(false)
          if (useTemporaryPan) setTempTool(null)
        },
        pointerCapture,
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Pointer down on the empty stage.
  const onStagePointerDown = (e: React.PointerEvent) => {
    // Botão do meio (scroll pressionado): sempre move a imagem, em qualquer ferramenta.
    if (e.button === 1) {
      startPan(e, { temporary: true })
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
      setReturnToolAfterSelect(null)
      startPan(e, { temporary: true })
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
      startPan(e, { temporary: true })
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
    if (e.button === 1) {
      startPan(e, { temporary: true })
      return
    }
    if (e.button !== 0) return
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
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault()
        navigateImage(e.key === "ArrowLeft" ? -1 : 1)
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
  }, [undo, redo, deleteSelected, finishPolygon, navigateImage, polyDraft, classList])

  useEffect(() => {
    const onMouseNavigation = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      event.stopPropagation()
      navigateImage(event.button === 3 ? -1 : 1)
    }

    window.addEventListener("mousedown", onMouseNavigation, { capture: true })
    window.addEventListener("auxclick", onMouseNavigation, { capture: true })
    return () => {
      window.removeEventListener("mousedown", onMouseNavigation, { capture: true })
      window.removeEventListener("auxclick", onMouseNavigation, { capture: true })
    }
  }, [navigateImage])

  const saveFrameShapes = useCallback(async (targetShapes: Shape[], mode: "manual" | "auto" = "manual") => {
    if (!currentTask?.external_id) {
      if (mode === "manual") setSaveError("Nenhuma task CVAT sincronizada para salvar.")
      return
    }
    if (targetShapes.some((shape) => !shape.cls.trim())) {
      if (mode === "manual") setSaveError("Defina a classe de todos os objetos antes de salvar.")
      return
    }
    const signature = frameShapesSignature(targetShapes)
    setSaving(true)
    setSaveError(null)
    try {
      const records = await saveManualAnnotations({
        task_external_id: currentTask.external_id,
        frame: currentFrame,
        shapes: targetShapes.map((shape) => shapeToManualAnnotation(shape, classList)),
        actor: currentUser.email || currentUser.id,
        sync_cvat: true,
        replace_existing: true,
      })
      loadedAnnotationKeys.current.add(currentFrameKey)
      setClassList((prev) => mergeAnnotationClasses(prev, records))
      setLocalProjectClasses((prev) => {
        const existing = prev[currentClassScopeKey] ?? []
        const saved = classItemsFromAnnotationRecords(records, classList)
        if (saved.length === 0) return prev
        return { ...prev, [currentClassScopeKey]: mergeClassItems(existing, saved) }
      })
      setAnnotatedFrames((prev) => {
        const next = new Set(prev)
        if (targetShapes.some((shape) => shape.cls.trim())) next.add(currentFrame)
        else next.delete(currentFrame)
        return next
      })
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
  }, [classList, currentClassScopeKey, currentFrame, currentFrameKey, currentTask?.external_id, currentUser.email, currentUser.id])

  const persistCurrentFrame = useCallback(
    async (mode: "manual" | "auto" = "manual") => saveFrameShapes(shapes, mode),
    [saveFrameShapes, shapes],
  )

  const acceptSuggestion = (suggestion: Suggestion) => {
    setActiveSuggestionHints((previous) =>
      previous[suggestionHintKey] ? previous : { ...previous, [suggestionHintKey]: true },
    )
    const cls = createClassItem(suggestion.cls) ?? suggestion.cls
    const shape: Shape = {
      id: nextId.current++,
      type: "box",
      cls,
      conf: suggestion.conf,
      x: suggestion.x,
      y: suggestion.y,
      w: suggestion.w,
      h: suggestion.h,
    }
    const nextShapes = [...shapes, shape]
    past.current.push(shapes)
    if (past.current.length > 50) past.current.shift()
    future.current = []
    setShapes(nextShapes)
    setSelectedId(shape.id)
    setBackendSuggestions((prev) => prev.filter((item) => item.id !== suggestion.backendId))
    void updateInferenceSuggestionStatus(suggestion.backendId, "accepted").catch(() => {
      setSaveError("A sugestão foi aceita localmente, mas o backend não confirmou a decisão.")
    })
    void saveFrameShapes(nextShapes, "manual")
  }

  const rejectSuggestion = (suggestion: Suggestion) => {
    setActiveSuggestionHints((previous) =>
      previous[suggestionHintKey] ? previous : { ...previous, [suggestionHintKey]: true },
    )
    setBackendSuggestions((prev) => prev.filter((item) => item.id !== suggestion.backendId))
    void updateInferenceSuggestionStatus(suggestion.backendId, "rejected").catch(() => {
      setSaveError("A sugestão foi rejeitada localmente, mas o backend não confirmou a decisão.")
    })
  }

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

  const activeCanvasTool = tempTool ?? tool
  const cursor =
    isPanning
      ? "grabbing"
      : activeCanvasTool === "pan"
      ? "grab"
      : activeCanvasTool === "box" || activeCanvasTool === "polygon" || activeCanvasTool === "point"
        ? "crosshair"
        : "default"

  const pct = (v: number) => `${v * 100}%`

  if (!currentTask) {
    const isLoadingTasks = Boolean(activeProjectExternalId) && tasks === null
    const title = !activeProjectExternalId
      ? "Nenhum projeto ativo"
      : isLoadingTasks
        ? "Carregando lotes"
        : selectedTaskId
          ? "Lote nao encontrado neste projeto"
          : "Nenhum lote para anotar"
    const description = !activeProjectExternalId
      ? "Selecione ou crie um projeto antes de abrir a tela de anotacao."
      : isLoadingTasks
        ? "Buscando os lotes do projeto ativo."
        : selectedTaskId
          ? "A task informada nao pertence ao projeto ativo ou foi removida."
          : "Suba um lote em Dados. Assim que a importacao terminar, as imagens aparecem automaticamente aqui para anotar."
    const targetHref = activeProjectExternalId ? projectScopedHref("/dados", activeProjectId) : "/projetos"

    return (
      <div className="flex h-[calc(100dvh-3.5rem)] items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
            {isLoadingTasks ? (
              <span className="size-5 animate-spin rounded-full border-2 border-brand-blue/30 border-t-brand-blue" />
            ) : (
              <FolderKanban className="size-6" />
            )}
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-foreground">{title}</p>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {!isLoadingTasks && (
            <Button onClick={() => router.push(targetHref)}>
              {activeProjectExternalId ? "Ir para dados" : "Ir para projetos"}
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (taskMeta && !hasAnnotatableFrame) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
            <FolderKanban className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-foreground">Este lote está em revisão</p>
            <p className="text-sm text-muted-foreground">
              As imagens com anotações importadas foram enviadas para Revisar e não ficam disponíveis para anotação.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => router.push(projectScopedHref("/revisar", activeProjectId))}>
              Ir para revisar
            </Button>
            <Button variant="outline" onClick={() => router.push(projectScopedHref("/dados", activeProjectId))}>
              Ver dados
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
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
              onClick={() => navigateImage(-1)}
              disabled={!canGoPrevious}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular-nums text-muted-foreground">
              {currentQueueNumber.toLocaleString("pt-BR")} / {annotationQueueImages.length.toLocaleString("pt-BR")}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Próxima imagem"
              onClick={() => navigateImage(1)}
              disabled={!canGoNext}
            >
              <ChevronRight className="size-4" />
            </Button>
            <span className="ml-2 font-medium text-foreground">
              {currentTask ? currentTask.name : `Imagem ${String(imageIndex).padStart(6, "0")}.jpg`}
            </span>
            {(annotationQueueImages.length !== totalImages || onlyUnannotated) && (
              <span className="rounded-full bg-muted px-2 py-1 text-xs tabular-nums text-muted-foreground">
                Imagem {imageIndex.toLocaleString("pt-BR")}
              </span>
            )}
            <label className="ml-3 inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <input
                type="checkbox"
                checked={onlyUnannotated}
                onChange={(event) => toggleOnlyUnannotated(event.target.checked)}
                className="size-3.5 accent-[var(--brand-blue)]"
              />
              Apenas sem anotação
            </label>
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
          onPointerDownCapture={(e) => {
            if (e.button !== 0) return
            if (toolRef.current !== "select") return
            const target = e.target as HTMLElement | null
            if (
              target?.closest(
                "[data-annotation-hit],button,input,textarea,select,[role='dialog'],[data-canvas-scroll-area]",
              )
            ) {
              return
            }
            setSelectedId(null)
            setReturnToolAfterSelect(null)
            startPan(e, { temporary: true })
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.button === 1) {
              startPan(e, { temporary: true })
              return
            }
            if (e.button !== 0) return
            const currentTool = toolRef.current
            if (currentTool === "select") {
              setSelectedId(null)
              setReturnToolAfterSelect(null)
              startPan(e, { temporary: true })
            } else if (currentTool === "pan") {
              startPan(e)
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
          onMouseDownCapture={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
        >
          {showSuggestionHint && (
            <button
              type="button"
              onClick={() => dismissCanvasHint(suggestionHintKey)}
              className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-xs text-white/85 shadow-sm backdrop-blur transition-colors hover:bg-black/80"
            >
              Sugestões ativas · clique esquerdo aceita · botão direito rejeita
            </button>
          )}
          <div
            ref={stageRef}
            className="relative overflow-hidden rounded-lg shadow-2xl"
            style={{
              width: stageSize ? `${stageSize.width}px` : undefined,
              height: stageSize ? `${stageSize.height}px` : undefined,
              aspectRatio: `${stageAspectRatio}`,
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
              cursor,
            }}
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
              className="pointer-events-none size-full object-contain"
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget
                if (!image.naturalWidth || !image.naturalHeight) return
                const dimensions = { width: image.naturalWidth, height: image.naturalHeight }
                setNaturalFrameDimensionsByKey((previous) => {
                  const current = previous[currentFrameKey]
                  if (current?.width === dimensions.width && current.height === dimensions.height) return previous
                  return { ...previous, [currentFrameKey]: dimensions }
                })
              }}
            />

            {/* Committed shapes */}
            {shapes.map((s) => {
              const color = colorFor(s.cls)
              const selected = s.id === selectedId
              if (s.type === "box") {
                return (
                  <div
                    key={s.id}
                    data-annotation-hit
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
                          data-annotation-hit
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
                    data-annotation-hit
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
                    data-annotation-hit
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
            {visibleSuggestions.map((s) => {
              const color = colorFor(s.cls)
              return (
                <div
                  key={`sug-${s.backendId}`}
                  data-annotation-hit
                  role="button"
                  tabIndex={0}
                  title="Clique para aceitar. Botão direito rejeita."
                  className="pointer-events-auto absolute cursor-pointer rounded-[3px] border-2 border-dashed transition-[box-shadow,background-color] hover:shadow-[0_0_0_3px_rgba(79,140,255,0.28)]"
                  onPointerDown={(event) => {
                    if (event.button === 1) {
                      startPan(event, { temporary: true })
                      return
                    }
                    if (event.button !== 0) {
                      event.stopPropagation()
                      return
                    }
                    event.preventDefault()
                    event.stopPropagation()
                    acceptSuggestion(s)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    rejectSuggestion(s)
                  }}
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
              data-canvas-scroll-area
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
          {!dismissedCanvasHints[toolHintKey] && (
            <button
              type="button"
              onClick={() => dismissCanvasHint(toolHintKey)}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white/80 backdrop-blur transition-colors hover:bg-black/80"
            >
              {toolHintText}
            </button>
          )}
        </div>

        {/* Filmstrip: fila atual de anotacao */}
        <div className="flex items-center gap-2 border-t border-border bg-card px-3 py-2">
          <button
            type="button"
            aria-label="Retroceder 10 imagens"
            onClick={() => navigateImage(-1, 10)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronsLeft className="size-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {visibleQueueImages.map((n) => {
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
            })}
          </div>
          <button
            type="button"
            aria-label="Avançar 10 imagens"
            onClick={() => navigateImage(1, 10)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Right panel */}
      <aside className="flex w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-card lg:w-80 lg:border-l lg:border-t-0">
        <section className="border-b border-border px-4 py-4">
          <button
            type="button"
            onClick={() => toggleRightPanelSection("classes")}
            aria-expanded={!rightPanelCollapsed.classes}
            className="mb-3 flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-sm font-semibold text-foreground">Classes</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Atalhos 1-9
              <ChevronDown
                className={cn(
                  "size-4 transition-transform",
                  rightPanelCollapsed.classes ? "-rotate-90" : "rotate-0",
                )}
              />
            </span>
          </button>
          {!rightPanelCollapsed.classes && (
          <div className="flex flex-col gap-1">
            {classList.map((c, i) => {
              const isActive = activeClass === c.name
              const shortcutIndex = classList.filter((x) => !x.parent).findIndex((x) => x.name === c.name)
              return (
                <div key={c.name} className="flex flex-col">
                  <div
                    className={cn(
                      "group relative flex items-center justify-between rounded-lg transition-colors",
                      isActive ? "bg-muted ring-1 ring-brand-blue/40" : "hover:bg-muted",
                    )}
                  >
                    <label
                      className={cn(
                        "ml-2 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-background",
                        c.parent && "ml-6",
                      )}
                      title={`Alterar cor de ${c.name}`}
                      aria-label={`Alterar cor de ${c.name}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                      <input
                        type="color"
                        value={colorInputValue(c.color)}
                        onChange={(event) => updateClassColor(c.name, event.target.value)}
                        className="sr-only"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setActiveClass((prev) => (prev === c.name ? null : c.name))}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openClassAction("rename", c)
                      }}
                      aria-pressed={isActive}
                      title={isActive ? "Clique para desmarcar" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-sm"
                    >
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
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setClassActionMenu((current) => (current === c.name ? null : c.name))
                        }}
                        aria-label={`Acoes da classe ${c.name}`}
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 data-[open=true]:opacity-100"
                        data-open={classActionMenu === c.name}
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </span>
                    {classActionMenu === c.name && (
                      <div
                        className="absolute right-1 top-8 z-30 w-48 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => openClassAction("rename", c)}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <Pencil className="size-4 text-muted-foreground" />
                          Renomear
                        </button>
                        <button
                          type="button"
                          onClick={() => openClassAction("map", c)}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <ArrowRightLeft className="size-4 text-muted-foreground" />
                          Mapear para outra
                        </button>
                        <button
                          type="button"
                          onClick={() => openClassAction("delete", c)}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="size-4" />
                          Excluir
                        </button>
                      </div>
                    )}
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
          </div>
          )}
        </section>

        <section className="border-b border-border px-4 py-4">
          <button
            type="button"
            onClick={() => toggleRightPanelSection("objects")}
            aria-expanded={!rightPanelCollapsed.objects}
            className="mb-3 flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-sm font-semibold text-foreground">Objetos ({shapes.length})</span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                rightPanelCollapsed.objects ? "-rotate-90" : "rotate-0",
              )}
            />
          </button>
          {!rightPanelCollapsed.objects && (
          <>
            {selectedId != null && (
              <button
                type="button"
                onClick={deleteSelected}
                className="mb-2 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
                Remover
              </button>
            )}
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
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
            </div>
          </>
          )}
        </section>

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
    {classActionDialog && (
      <ClassActionDialog
        target={classActionDialog}
        value={classActionValue}
        impact={classActionImpact}
        error={classActionError}
        submitting={classActionSubmitting}
        classList={classList}
        onValueChange={setClassActionValue}
        onClose={() => {
          if (classActionSubmitting) return
          setClassActionDialog(null)
          setClassActionValue("")
          setClassActionError(null)
        }}
        onSubmit={submitClassAction}
      />
    )}
    </>
  )
}

function ClassActionDialog({
  target,
  value,
  impact,
  error,
  submitting,
  classList,
  onValueChange,
  onClose,
  onSubmit,
}: {
  target: ClassActionTarget
  value: string
  impact: BackendLabelImpact | null
  error: string | null
  submitting: boolean
  classList: ClassItem[]
  onValueChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: React.FormEvent) => void
}) {
  const sourceName = target.cls.name
  const isDeleteBlocked = target.mode === "delete" && Boolean(impact?.used)
  const title =
    target.mode === "rename"
      ? "Renomear classe"
      : target.mode === "map"
        ? "Mapear classe"
        : "Excluir classe"
  const description =
    target.mode === "rename"
      ? "Troca o nome da classe em todo o projeto. Se o destino ja existe, use mapear."
      : target.mode === "map"
        ? "Move anotacoes, sugestoes e assets desta classe para outra."
        : "Remove a classe do catalogo apenas quando ela nao esta em uso."
  const destinationSuggestions = classList.filter((item) => item.name.toLowerCase() !== sourceName.toLowerCase())
  const destinationQuery = value.trim().toLowerCase()
  const filteredDestinationSuggestions = destinationSuggestions.filter((item) =>
    item.name.toLowerCase().includes(destinationQuery),
  )
  const hasSelectedDestination = destinationSuggestions.some((item) => item.name.toLowerCase() === destinationQuery)
  const submitLabel = target.mode === "rename" ? "Renomear" : target.mode === "map" ? "Mapear" : "Excluir"
  const submitDisabled = submitting || isDeleteBlocked || (target.mode === "map" && !hasSelectedDestination)
  const impactSummary = formatClassImpactSummary(impact)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form
        onSubmit={onSubmit}
        className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Fechar"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <div className="rounded-xl bg-muted px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full" style={{ backgroundColor: target.cls.color }} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{sourceName}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{impactSummary}</p>
          </div>

          {target.mode !== "delete" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {target.mode === "rename" ? "Novo nome" : "Classe de destino"}
              </span>
              <input
                autoFocus
                value={value}
                onChange={(event) => onValueChange(event.target.value)}
                placeholder={target.mode === "rename" ? "Ex.: torre" : "Digite para filtrar"}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
              />
            </label>
          )}

          {target.mode === "map" && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sugestões de destino</p>
              {filteredDestinationSuggestions.length ? (
                <div className="flex flex-wrap gap-2">
                  {filteredDestinationSuggestions.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => onValueChange(item.name)}
                      className={cn(
                        "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
                        value.trim().toLowerCase() === item.name.toLowerCase()
                          ? "border-brand-blue bg-brand-blue/10 text-brand-blue"
                          : "border-border bg-background text-foreground hover:border-brand-blue/60",
                      )}
                    >
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : destinationSuggestions.length ? (
                <p className="text-sm text-muted-foreground">Nenhuma classe encontrada.</p>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhuma outra classe criada neste projeto.</p>
              )}
            </div>
          )}

          {isDeleteBlocked && (
            <div className="flex gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>Esta classe esta em uso. Mapeie para outra classe antes de excluir.</p>
            </div>
          )}

          {error && <div className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={submitDisabled}
            variant={target.mode === "delete" ? "destructive" : "default"}
          >
            {submitting ? "Aplicando..." : submitLabel}
          </Button>
        </div>
      </form>
    </div>
  )
}

function formatClassImpactSummary(impact: BackendLabelImpact | null) {
  if (!impact) return "Calculando uso da classe..."
  return [
    `${impact.annotations} anot.`,
    `${impact.suggestions} sugest.`,
    `${impact.derived_assets} assets`,
    `${impact.task_labels} lotes`,
  ].join(" · ")
}

function classActionErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Nao foi possivel aplicar a acao.")
  try {
    const parsed = JSON.parse(raw) as { message?: string }
    if (parsed.message?.includes("Target label already exists")) {
      return "Essa classe ja existe. Use mapear para juntar as classes."
    }
    if (parsed.message?.includes("Label is in use")) {
      return "Esta classe esta em uso. Mapeie para outra classe antes de excluir."
    }
    if (parsed.message) return parsed.message
  } catch {
    // O backend tambem pode retornar erro como string simples.
  }
  if (raw.includes("Target label already exists")) return "Essa classe ja existe. Use mapear para juntar as classes."
  if (raw.includes("Label is in use")) return "Esta classe esta em uso. Mapeie para outra classe antes de excluir."
  return raw
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
    backendId: suggestion.id,
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

function shapeToManualAnnotation(shape: Shape, classList: ClassItem[]): BackendManualAnnotationShape {
  const labelColor = classList.find((item) => item.name === shape.cls)?.color ?? null
  if (shape.type === "box") {
    return {
      client_id: String(shape.id),
      shape_type: "rectangle",
      label_name: shape.cls,
      label_color: labelColor,
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
      label_color: labelColor,
      points,
      bbox_norm: bboxFromNormalizedPoints(points),
    }
  }
  return {
    client_id: String(shape.id),
    shape_type: "points",
    label_name: shape.cls,
    label_color: labelColor,
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

function shapesFromAnnotationRecords(records: BackendAnnotationRecord[], dimensions: FrameDimensions): Shape[] {
  const candidates = records
    .filter(isEditableAnnotationRecord)
    .map((record) => {
      const shape = shapeFromAnnotationRecord(record, dimensions)
      return shape ? { record, shape, priority: annotationRecordPriority(record) } : null
    })
    .filter((candidate): candidate is { record: BackendAnnotationRecord; shape: Shape; priority: number } =>
      Boolean(candidate),
    )
    .sort((a, b) => b.priority - a.priority || Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at))

  const kept: typeof candidates = []
  for (const candidate of candidates) {
    const duplicate = kept.some((existing) => duplicateBoxes(candidate.shape, existing.shape))
    if (!duplicate) kept.push(candidate)
  }
  return kept.map((candidate) => candidate.shape)
}

function isEditableAnnotationRecord(record: BackendAnnotationRecord) {
  return !["deleted_by_reviewer", "needs_annotation", "rejected", "incorrect", "replaced_by_manual"].includes(
    String(record.review_state ?? "").toLowerCase(),
  )
}

function annotationRecordPriority(record: BackendAnnotationRecord) {
  let priority = 0
  if (record.external_id.startsWith("cvat_job:")) priority += 10
  if (record.source === "cvat-plus" || record.raw.origin === "cvat-plus") priority -= 1
  return priority
}

function duplicateBoxes(a: Shape, b: Shape) {
  if (a.type !== "box" || b.type !== "box") return false
  if (a.cls !== b.cls) return false
  return boxIou(a, b) >= 0.6
}

function mergeLoadedShapes(currentShapes: Shape[], loadedShapes: Shape[]) {
  const next = [...currentShapes]
  for (const loaded of loadedShapes) {
    const exists = next.some((current) => current.id === loaded.id || duplicateShapes(current, loaded))
    if (!exists) next.push(loaded)
  }
  return next
}

function duplicateShapes(a: Shape, b: Shape) {
  if (a.cls !== b.cls || a.type !== b.type) return false
  if (a.type === "box" && b.type === "box") return duplicateBoxes(a, b)
  return frameShapesSignature([a]) === frameShapesSignature([b])
}

function boxIou(
  a: Extract<Shape, { type: "box" }>,
  b: Extract<Shape, { type: "box" }>,
) {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const intersectionWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const intersectionHeight = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const intersection = intersectionWidth * intersectionHeight
  const union = a.w * a.h + b.w * b.h - intersection
  return union > 0 ? intersection / union : 0
}

function shapeFromAnnotationRecord(record: BackendAnnotationRecord, dimensions: FrameDimensions): Shape | null {
  const label = record.label_name ?? stringFromRecord(record.raw, "label_name") ?? "unknown"
  const id = numericIdFromString(record.external_id)
  const shapeType = record.shape_type ?? stringFromRecord(record.raw, "type")
  const pointsNorm = normalizedPointsFromRecord(record, dimensions)

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

  if ((shapeType === "rectangle" || shapeType === "box") && pointsNorm.length >= 4) {
    const box = bboxFromNormalizedPoints(pointsNorm)
    if (box) return { id, type: "box", cls: label, ...box }
  }

  const rawBbox = normalizedBoxFromRecord(record.raw.bbox_norm)
  if (rawBbox) {
    const bbox = usesLegacyStageCoordinates(record)
      ? legacyStageBoxToImageBox(rawBbox, dimensions)
      : rawBbox
    return { id, type: "box", cls: label, ...bbox }
  }

  if (pointsNorm.length >= 4) {
    const box = bboxFromNormalizedPoints(pointsNorm)
    if (box) return { id, type: "box", cls: label, ...box }
  }

  return null
}

function mergeAnnotationClasses(classList: ClassItem[], records: BackendAnnotationRecord[]) {
  return mergeClassItems(classList, classItemsFromAnnotationRecords(records, classList))
}

function classScopeKey(projectExternalId: string | null | undefined) {
  return projectExternalId ? `project:${projectExternalId}` : "project:__none__"
}

function mergeClassItems(...groups: ClassItem[][]) {
  const next: ClassItem[] = []
  const byName = new Set<string>()
  for (const group of groups) {
    for (const item of group) {
      const name = item.name.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (byName.has(key)) continue
      byName.add(key)
      next.push({ ...item, name })
    }
  }
  return next
}

function insertClassItem(items: ClassItem[], item: ClassItem, parent: string | null = item.parent ?? null) {
  if (items.some((current) => current.name.toLowerCase() === item.name.toLowerCase())) return items
  if (!parent) return [...items, { ...item, parent: undefined }]

  const parentIndex = items.findIndex((current) => current.name === parent)
  if (parentIndex < 0) return [...items, { ...item, parent: undefined }]

  let insertAt = parentIndex + 1
  while (insertAt < items.length && items[insertAt].parent === parent) insertAt++
  const next = [...items]
  next.splice(insertAt, 0, { ...item, parent })
  return next
}

function nextClassColor(existing: ClassItem[], seed: string) {
  const used = new Set(existing.map((item) => normalizeHexColor(item.color)).filter(Boolean))
  const start = Math.abs(hashString(seed)) % newClassPalette.length
  for (let offset = 0; offset < newClassPalette.length; offset++) {
    const color = newClassPalette[(start + offset) % newClassPalette.length]
    if (!used.has(color.toLowerCase())) return color
  }

  for (let index = 0; index < 64; index++) {
    const color = hslToHex((hashString(seed) + index * 137) % 360, 72, 52)
    if (!used.has(color.toLowerCase())) return color
  }
  return newClassPalette[start]
}

function colorInputValue(color: string) {
  return normalizeHexColor(color) ?? "#4f8cff"
}

function normalizeHexColor(color: string | null | undefined) {
  if (!color) return null
  const value = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [, r, g, b] = value
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return null
}

function hashString(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const h = ((hue % 360) + 360) % 360
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - chroma / 2
  const [r, g, b] =
    h < 60
      ? [chroma, x, 0]
      : h < 120
        ? [x, chroma, 0]
        : h < 180
          ? [0, chroma, x]
          : h < 240
            ? [0, x, chroma]
            : h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return `#${[r, g, b]
    .map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`
}

function classItemsFromBackendLabels(
  labels: BackendCvatLabel[],
  projectTasks: BackendTask[],
  projectExternalId: string | null,
) {
  const taskExternalIds = new Set(projectTasks.map((task) => task.external_id).filter(Boolean))
  const items: ClassItem[] = []
  for (const label of labels) {
    const taskScopedToProject = label.task_external_id ? taskExternalIds.has(label.task_external_id) : false
    const projectScoped = projectExternalId
      ? label.project_external_id === projectExternalId
      : !label.project_external_id && (!label.task_external_id || taskScopedToProject)
    if (!projectScoped && !taskScopedToProject) continue
    const name = label.name.trim()
    if (!name) continue
    items.push({
      name,
      color: label.color || stringFromRecord(label.raw, "color") || nextClassColor(items, name),
      parent: stringFromRecord(label.raw, "parent") ?? undefined,
    })
  }
  return items
}

function mergeBackendLabels(current: BackendCvatLabel[], incoming: BackendCvatLabel[]) {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((label) => [label.id, label]))
  for (const label of incoming) {
    byId.set(label.id, label)
  }
  return Array.from(byId.values())
}

function classItemsFromAnnotationRecords(records: BackendAnnotationRecord[], existing: ClassItem[]) {
  const items: ClassItem[] = []
  for (const record of records) {
    const name = record.label_name ?? stringFromRecord(record.raw, "label_name")
    if (!name) continue
    const current = existing.find((item) => item.name.toLowerCase() === name.toLowerCase())
    items.push({
      name,
      color: current?.color ?? nextClassColor([...existing, ...items], name),
      parent: current?.parent,
    })
  }
  return mergeClassItems(items)
}

function taskAnnotationImportTarget(task: BackendTask | null): "annotation" | "review" | null {
  const datasetImport = task?.raw?.dataset_import
  if (!datasetImport || typeof datasetImport !== "object" || Array.isArray(datasetImport)) return null
  const target = (datasetImport as Record<string, unknown>).annotation_import_target
  return target === "annotation" || target === "review" ? target : null
}

function frameDimensionsFromMeta(meta: BackendTaskDataMeta | null, frame: number): FrameDimensions | null {
  const rawFrame = Array.isArray(meta?.frames) ? meta.frames[frame] : null
  if (!rawFrame || typeof rawFrame !== "object" || Array.isArray(rawFrame)) return null
  const record = rawFrame as Record<string, unknown>
  const width = Number(record.width)
  const height = Number(record.height)
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return null
  return { width, height }
}

function normalizedPointsFromRecord(record: BackendAnnotationRecord, dimensions: FrameDimensions) {
  const pointsNorm = numberArrayFromUnknown(record.raw.points_norm)
  if (pointsNorm.length > 0 && pointsNorm.every(isNormalizedCoordinate)) {
    return normalizeRecordPoints(pointsNorm, record, dimensions)
  }

  const points = numberArrayFromUnknown(record.points)
  if (points.length === 0) return []
  if (points.every(isNormalizedCoordinate)) return normalizeRecordPoints(points, record, dimensions)

  return points.map((point, index) => {
    const axisSize = index % 2 === 0 ? dimensions.width : dimensions.height
    return clamp(point / axisSize)
  })
}

function normalizeRecordPoints(
  points: number[],
  record: BackendAnnotationRecord,
  dimensions: FrameDimensions,
) {
  const normalized = points.map((point) => clamp(point))
  if (!usesLegacyStageCoordinates(record)) return normalized
  const pairs = pairsFromNormalizedPoints(normalized).map((point) => legacyStagePointToImagePoint(point, dimensions))
  return pairs.flatMap((point) => [point.x, point.y])
}

function usesLegacyStageCoordinates(record: BackendAnnotationRecord) {
  return (
    record.external_id.startsWith("manual:") &&
    record.raw.origin === "cvat-plus" &&
    record.raw.coordinate_space !== "image-normalized"
  )
}

function legacyStageBoxToImageBox(box: { x: number; y: number; w: number; h: number }, dimensions: FrameDimensions) {
  const topLeft = legacyStagePointToImagePoint({ x: box.x, y: box.y }, dimensions)
  const bottomRight = legacyStagePointToImagePoint({ x: box.x + box.w, y: box.y + box.h }, dimensions)
  return normalizedBoxFromEdges(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y)
}

function legacyStagePointToImagePoint(point: { x: number; y: number }, dimensions: FrameDimensions) {
  const imageAspectRatio = dimensions.width / dimensions.height
  const legacyStageAspectRatio = 16 / 9
  if (imageAspectRatio < legacyStageAspectRatio) {
    const visibleShare = imageAspectRatio / legacyStageAspectRatio
    const topCrop = (1 - visibleShare) / 2
    return { x: clamp(point.x), y: clamp(point.y * visibleShare + topCrop) }
  }
  if (imageAspectRatio > legacyStageAspectRatio) {
    const visibleShare = legacyStageAspectRatio / imageAspectRatio
    const leftCrop = (1 - visibleShare) / 2
    return { x: clamp(point.x * visibleShare + leftCrop), y: clamp(point.y) }
  }
  return { x: clamp(point.x), y: clamp(point.y) }
}

function isNormalizedCoordinate(value: number) {
  return value >= 0 && value <= 1
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

function normalizedBoxFromEdges(x1: number, y1: number, x2: number, y2: number) {
  const left = clamp(Math.min(x1, x2))
  const top = clamp(Math.min(y1, y2))
  const right = clamp(Math.max(x1, x2))
  const bottom = clamp(Math.max(y1, y2))
  return {
    x: left,
    y: top,
    w: clamp(right - left),
    h: clamp(bottom - top),
  }
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

function projectScopedHref(path: string, projectId: string | null) {
  return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path
}

function numericIdFromString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}
