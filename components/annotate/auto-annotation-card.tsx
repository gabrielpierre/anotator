"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  Plus,
  X,
  Eye,
  EyeOff,
  Trash2,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProgressBar } from "@/components/app/primitives"
import { cn } from "@/lib/utils"

/* ---------- Types ---------- */

export type ModelInfo = {
  id: string
  name: string
  version: string
  task: "Detecção" | "Detecção rápida" | "Segmentação" | "Classificação"
  status: "Disponível" | "Carregando" | "Indisponível"
  family: "detection" | "segmentation" | "classification" | "tracking"
  baseModel: string
}

export type Suggestion = {
  id: number
  backendId: string
  cls: string
  conf: number
  x: number
  y: number
  w: number
  h: number
  status: "proposed"
  origin: {
    model_id: string
    model_version: string
    confidence: number
    threshold_used: number
    nms_iou: number
    timestamp: string
    scope: string
    user_id: string
  }
}

export type PredictionLayer = {
  modelId: string
  label: string
  unit: string
  count: number
  visible: boolean
}

type ApplyMode = "sugestoes" | "aceitas" | "substituir"
type GenerateSummary = { created: number; ignored: number; conflicts: number; jobId?: string }
type RunTarget = { frameStart: number; frameEnd: number; total: number; scope: string; dedupeKey?: string }

type RunState =
  | { phase: "idle" }
  | { phase: "running"; total: number }
  | { phase: "done"; created: number; ignored: number; conflicts: number; jobId?: string }
  | { phase: "failed"; message: string }

/* ---------- Small pieces ---------- */

function modelStatusMeta(status: ModelInfo["status"]) {
  if (status === "Disponível") return { dot: "bg-brand-green", text: "text-brand-green" }
  if (status === "Carregando") return { dot: "bg-warning", text: "text-warning" }
  return { dot: "bg-destructive", text: "text-destructive" }
}

function buildDedupeKey(value: unknown) {
  const input = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `aa:${(hash >>> 0).toString(36)}`
}

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {title}
        <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="pt-3">{children}</div>
        </div>
      </div>
    </div>
  )
}

function SliderInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
          className="h-7 w-16 rounded-md bg-muted px-2 text-right text-xs tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring/50"
          aria-label={label}
        />
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-[var(--brand-blue)]"
        aria-label={`${label} (slider)`}
      />
    </div>
  )
}

function ModelRow({
  model,
  onRemove,
}: {
  model: ModelInfo
  onRemove?: () => void
}) {
  const meta = modelStatusMeta(model.status)
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-2.5 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {model.name} {model.version}
        </span>
        <span className="text-xs text-muted-foreground">{model.task}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={cn("inline-flex items-center gap-1.5 text-xs", meta.text)}>
          <span className={cn("size-1.5 rounded-full", meta.dot)} />
          {model.status}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remover ${model.name} ${model.version}`}
            className="rounded p-0.5 text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------- Main card ---------- */

export function AutoAnnotationCard({
  models,
  classNames,
  layers,
  onGenerate,
  onClearSuggestions,
  onToggleLayer,
  onRemoveLayer,
  suggestionModelIds,
  imageIndex,
  totalImages,
}: {
  models: ModelInfo[]
  classNames: string[]
  layers: PredictionLayer[]
  /** Cria sugestões para os modelos informados. replaceModels indica quais devem substituir as sugestões existentes. */
  onGenerate: (params: {
    models: ModelInfo[]
    threshold: number
    nmsIou: number
    classes: string[]
    scope: string
    applyMode: ApplyMode
    replaceModels: string[]
    frameStart: number
    frameEnd: number
    dedupeKey?: string
  }) => GenerateSummary | Promise<GenerateSummary>
  onClearSuggestions: () => void
  onToggleLayer: (modelId: string) => void
  onRemoveLayer: (modelId: string) => void
  /** IDs de modelos que já possuem sugestões no canvas. */
  suggestionModelIds: string[]
  /** Índice (1-based) da imagem atual no lote — usado pelo modo contínuo. */
  imageIndex: number
  totalImages: number
}) {
  const [mainModelId, setMainModelId] = useState(models[0]?.id ?? "")
  const [auxModelIds, setAuxModelIds] = useState<string[]>([])
  const [auxPickerOpen, setAuxPickerOpen] = useState(false)

  const [threshold, setThreshold] = useState(0.35)
  const [nmsIou, setNmsIou] = useState(0.45)
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])
  const [classesOpen, setClassesOpen] = useState(false)
  const [applyMode, setApplyMode] = useState<ApplyMode>("sugestoes")
  const [sectionCollapsed, setSectionCollapsed] = useState(false)

  // ---- Modo de execução ----
  const [autoRunActive, setAutoRunActive] = useState(false)
  const [runKeyTick, setRunKeyTick] = useState(0)
  const [rangeStart, setRangeStart] = useState("1")
  const [rangeEnd, setRangeEnd] = useState("50")

  const [run, setRun] = useState<RunState>({ phase: "idle" })
  const [conflictPrompt, setConflictPrompt] = useState<string[] | null>(null)
  const autoRunTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRunKeys = useRef(new Set<string>())
  const processedRunKeys = useRef(new Set<string>())
  const pendingRunTarget = useRef<RunTarget | null>(null)

  useEffect(() => () => {
    if (autoRunTimer.current) clearTimeout(autoRunTimer.current)
    if (runResetTimer.current) clearTimeout(runResetTimer.current)
  }, [])

  useEffect(() => {
    if (runResetTimer.current) clearTimeout(runResetTimer.current)
    if (run.phase !== "done") return
    runResetTimer.current = setTimeout(() => setRun({ phase: "idle" }), 4500)
    return () => {
      if (runResetTimer.current) clearTimeout(runResetTimer.current)
    }
  }, [run.phase])

  useEffect(() => {
    const ids = new Set(models.map((model) => model.id))
    if (!mainModelId || !ids.has(mainModelId)) setMainModelId(models[0]?.id ?? "")
    setAuxModelIds((current) => current.filter((id) => ids.has(id) && id !== mainModelId))
  }, [mainModelId, models])

  const mainModel = models.find((m) => m.id === mainModelId) ?? null
  const auxModels = auxModelIds.map((id) => models.find((m) => m.id === id)).filter((m): m is ModelInfo => Boolean(m))
  const selectedModels = mainModel ? [mainModel, ...auxModels] : []
  const auxCandidates = models.filter((m) => m.id !== mainModelId && !auxModelIds.includes(m.id))
  const hasModels = models.length > 0 && mainModel !== null
  const selectedModelFingerprint = selectedModels
    .map((model) => `${model.id}@${model.version}:${model.family}:${model.baseModel}`)
    .join("|")

  const applyModes: { id: ApplyMode; label: string; description: string }[] = [
    { id: "sugestoes", label: "Sugerir", description: "Cria sugestões para aceitar ou rejeitar no canvas." },
    { id: "aceitas", label: "Aceitar", description: "Cria anotações aceitas diretamente." },
    { id: "substituir", label: "Substituir", description: "Remove sugestões anteriores do mesmo modelo." },
  ]
  const selectedApplyMode = applyModes.find((mode) => mode.id === applyMode) ?? applyModes[0]
  const suggestionCount = layers.reduce((total, layer) => total + layer.count, 0)

  const classesLabel =
    selectedClasses.length === 0
      ? "Todas"
      : selectedClasses.length <= 2
        ? selectedClasses.join(", ")
        : `${selectedClasses.length} classes`
  const selectedClassesFingerprint = [...selectedClasses].sort((a, b) => a.localeCompare(b)).join("|") || "*"
  const currentImageDedupeKey = buildDedupeKey({
    target: "frame",
    frameStart: imageIndex - 1,
    frameEnd: imageIndex - 1,
    models: selectedModelFingerprint,
    threshold: Number(threshold.toFixed(3)),
    nmsIou: Number(nmsIou.toFixed(3)),
    classes: selectedClassesFingerprint,
    applyMode,
  })
  const currentImageHasModelSuggestions =
    applyMode === "sugestoes" && selectedModels.some((model) => suggestionModelIds.includes(model.id))
  const currentImageQueued = pendingRunKeys.current.has(currentImageDedupeKey)
  const currentImageProcessed = processedRunKeys.current.has(currentImageDedupeKey) || currentImageHasModelSuggestions
  void runKeyTick

  // ---- Validação do intervalo ----
  const startNum = Number(rangeStart)
  const endNum = Number(rangeEnd)
  const rangeError =
    !rangeStart || !rangeEnd || !Number.isInteger(startNum) || !Number.isInteger(endNum)
      ? "Informe números inteiros válidos."
      : startNum < 1 || endNum > totalImages
        ? `O intervalo deve estar entre 1 e ${totalImages.toLocaleString("pt-BR")}.`
        : startNum > endNum
          ? "O início deve ser menor ou igual ao fim."
          : null
  const rangeCount = rangeError ? 0 : endNum - startNum + 1
  const currentImageRunTarget: RunTarget = {
    frameStart: imageIndex - 1,
    frameEnd: imageIndex - 1,
    total: 1,
    scope: `imagem ${imageIndex}`,
    dedupeKey: currentImageDedupeKey,
  }
  const intervalRunTarget: RunTarget = {
    frameStart: startNum - 1,
    frameEnd: endNum - 1,
    total: rangeCount,
    scope: `intervalo ${startNum}-${endNum}`,
    dedupeKey: buildDedupeKey({
      target: "interval",
      frameStart: startNum - 1,
      frameEnd: endNum - 1,
      models: selectedModelFingerprint,
      threshold: Number(threshold.toFixed(3)),
      nmsIou: Number(nmsIou.toFixed(3)),
      classes: selectedClassesFingerprint,
      applyMode,
    }),
  }

  const refreshRunKeyState = () => setRunKeyTick((tick) => tick + 1)

  const markRunPending = (key?: string) => {
    if (!key) return
    pendingRunKeys.current.add(key)
    refreshRunKeyState()
  }

  const markRunProcessed = (key?: string) => {
    if (!key) return
    pendingRunKeys.current.delete(key)
    processedRunKeys.current.add(key)
    refreshRunKeyState()
  }

  const markRunFailed = (key?: string) => {
    if (!key) return
    pendingRunKeys.current.delete(key)
    refreshRunKeyState()
  }

  const startRun = (
    replaceModels: string[],
    target = pendingRunTarget.current ?? intervalRunTarget,
  ) => {
    if (!hasModels) return
    setConflictPrompt(null)
    pendingRunTarget.current = null
    markRunPending(target.dedupeKey)
    setRun({ phase: "running", total: target.total })
    Promise.resolve(
      onGenerate({
        models: selectedModels,
        threshold,
        nmsIou,
        classes: selectedClasses,
        scope: target.scope,
        applyMode,
        replaceModels,
        frameStart: target.frameStart,
        frameEnd: target.frameEnd,
        dedupeKey: target.dedupeKey,
      }),
    )
      .then((result) => {
        markRunProcessed(target.dedupeKey)
        setRun({ phase: "done", ...result })
      })
      .catch((err) => {
        markRunFailed(target.dedupeKey)
        setRun({
          phase: "failed",
          message: err instanceof Error ? err.message : "Falha ao enfileirar inferencia.",
        })
      })
  }

  const requestRun = (target: RunTarget, source: "manual" | "auto" = "manual") => {
    if (run.phase === "running" || !hasModels) return
    if (target.dedupeKey && (pendingRunKeys.current.has(target.dedupeKey) || processedRunKeys.current.has(target.dedupeKey))) {
      return
    }
    pendingRunTarget.current = target
    // Se o modo não é "substituir" e já existem sugestões de algum modelo selecionado, perguntar.
    const conflicting = selectedModels.map((m) => m.id).filter((id) => suggestionModelIds.includes(id))
    if (source === "auto" && applyMode === "sugestoes" && conflicting.length > 0) {
      markRunProcessed(target.dedupeKey)
      return
    }
    if (applyMode !== "substituir" && conflicting.length > 0) {
      setConflictPrompt(conflicting)
      return
    }
    startRun(applyMode === "substituir" ? selectedModels.map((m) => m.id) : [], target)
  }

  const handleGenerateCurrentImage = () => {
    if (currentImageQueued || currentImageProcessed) return
    requestRun(currentImageRunTarget)
  }

  const handleGenerate = () => {
    if (rangeError) return
    requestRun(intervalRunTarget)
  }

  const cancelRun = () => {
    setRun({ phase: "idle" })
  }

  useEffect(() => {
    if (!autoRunActive || !hasModels || currentImageQueued || currentImageProcessed || run.phase === "running") return
    if (autoRunTimer.current) clearTimeout(autoRunTimer.current)
    autoRunTimer.current = setTimeout(() => {
      requestRun(currentImageRunTarget, "auto")
    }, 500)
    return () => {
      if (autoRunTimer.current) clearTimeout(autoRunTimer.current)
    }
  }, [autoRunActive, currentImageDedupeKey, currentImageProcessed, currentImageQueued, hasModels, run.phase])

  const toggleAutoRun = () => {
    if (autoRunActive) {
      if (autoRunTimer.current) clearTimeout(autoRunTimer.current)
      setAutoRunActive(false)
    } else {
      setAutoRunActive(true)
    }
  }

  const handleClearSuggestions = () => {
    pendingRunKeys.current.clear()
    processedRunKeys.current.clear()
    refreshRunKeyState()
    onClearSuggestions()
  }

  const mainModelStatus = mainModel ? modelStatusMeta(mainModel.status) : null
  const generateLabel = currentImageQueued
    ? "Enfileirado"
    : currentImageProcessed
      ? "Já gerado nesta imagem"
      : "Gerar nesta imagem"

  return (
    <section className="px-4 py-4">
      <button
        type="button"
        onClick={() => setSectionCollapsed((collapsed) => !collapsed)}
        aria-expanded={!sectionCollapsed}
        className="mb-3 flex w-full items-center justify-between gap-3 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">Autoanotação</p>
          {autoRunActive && <p className="mt-0.5 text-xs text-brand-green">Ativa ao navegar</p>}
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            sectionCollapsed ? "-rotate-90" : "rotate-0",
          )}
        />
      </button>

      {!sectionCollapsed && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Modelo ativo</span>
            {mainModel && mainModelStatus && (
              <span className={cn("inline-flex items-center gap-1.5 text-xs", mainModelStatus.text)}>
                <span className={cn("size-1.5 rounded-full", mainModelStatus.dot)} />
                {mainModel.status}
              </span>
            )}
          </div>
          {hasModels ? (
            <>
              <select
                value={mainModelId}
                onChange={(event) => {
                  setMainModelId(event.target.value)
                  setAuxModelIds((ids) => ids.filter((id) => id !== event.target.value))
                }}
                className="h-10 rounded-xl bg-muted px-3 text-sm font-medium text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                aria-label="Modelo ativo da autoanotação"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} {model.version} - {model.task}
                  </option>
                ))}
              </select>
              {mainModel && (
                <p className="text-xs text-muted-foreground">
                  {mainModel.task} · {mainModel.baseModel}
                </p>
              )}
            </>
          ) : (
            <p className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
              Nenhum modelo registrado para autoanotação.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sugestões</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {suggestionCount.toLocaleString("pt-BR")} nesta imagem
            </span>
          </div>
          {layers.length > 0 ? (
            <div className="flex flex-col">
              {layers.map((layer) => (
                <div key={layer.modelId} className="flex items-center justify-between gap-2 border-t border-border/60 py-2 first:border-t-0">
                  <div className="min-w-0">
                    <p className={cn("truncate text-sm", layer.visible ? "text-foreground" : "text-muted-foreground line-through")}>
                      {layer.label}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {layer.count} {layer.unit}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleLayer(layer.modelId)}
                      aria-label={layer.visible ? `Ocultar camada ${layer.label}` : `Mostrar camada ${layer.label}`}
                      aria-pressed={layer.visible}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveLayer(layer.modelId)}
                      aria-label={`Remover camada ${layer.label}`}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma sugestão nesta imagem.</p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Modo</span>
          <div role="radiogroup" aria-label="Modo de aplicação" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
            {applyModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={applyMode === mode.id}
                onClick={() => setApplyMode(mode.id)}
                className={cn(
                  "h-8 rounded-lg text-sm font-medium transition-colors",
                  applyMode === mode.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {selectedApplyMode.description} Anotações manuais nunca são sobrescritas.
          </p>
        </div>

        {conflictPrompt && (
          <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-surface-subtle p-3">
            <p className="flex items-start gap-2 text-xs leading-relaxed text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              Já existem sugestões deste modelo. Deseja substituir ou manter ambas?
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => startRun(conflictPrompt)}>
                Substituir
              </Button>
              <Button size="sm" variant="outline" onClick={() => startRun([])}>
                Manter ambas
              </Button>
              <button
                type="button"
                onClick={() => setConflictPrompt(null)}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {run.phase === "running" && (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-subtle p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Loader2 className="size-4 animate-spin text-brand-blue" />
              Enfileirando inferência...
            </p>
            <ProgressBar value={45} />
            <p className="text-xs tabular-nums text-muted-foreground">
              {run.total.toLocaleString("pt-BR")} {run.total === 1 ? "imagem" : "imagens"} · progresso detalhado nos jobs
            </p>
            <Button size="sm" variant="outline" onClick={cancelRun} className="self-start">
              Cancelar
            </Button>
          </div>
        )}

        {run.phase === "failed" && (
          <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-surface-subtle p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="size-4" />
              Falha na autoanotação
            </p>
            <p className="text-xs text-muted-foreground">{run.message}</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="rounded-xl border border-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Autoanotar ao navegar</p>
                <p className={cn("text-xs", autoRunActive ? "text-brand-green" : "text-muted-foreground")}>
                  {autoRunActive ? "Ativado" : "Desativado"}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoRunActive}
                onClick={toggleAutoRun}
                disabled={!hasModels}
                className={cn(
                  "relative h-6 w-10 shrink-0 rounded-full border transition-colors disabled:opacity-50",
                  autoRunActive
                    ? "border-brand-green bg-brand-green"
                    : "border-muted-foreground/25 bg-muted-foreground/20 hover:bg-muted-foreground/25",
                )}
              >
                <span
                  className={cn(
                    "absolute left-1 top-1 size-4 rounded-full bg-background shadow-sm ring-1 ring-border transition-transform",
                    autoRunActive ? "translate-x-4" : "translate-x-0",
                  )}
                />
              </button>
            </div>
          </div>

          <Button
            variant="outline"
            onClick={handleGenerateCurrentImage}
            disabled={run.phase === "running" || !hasModels || currentImageQueued || currentImageProcessed}
          >
            {currentImageQueued ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {generateLabel}
          </Button>
          <Button variant="outline" onClick={handleClearSuggestions} disabled={layers.length === 0}>
            Limpar sugestões
          </Button>
        </div>

        <CollapsibleSection title="Configuração avançada" defaultOpen={false}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Modelos auxiliares</p>
              {auxModels.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  onRemove={() => setAuxModelIds((ids) => ids.filter((id) => id !== model.id))}
                />
              ))}
              {auxPickerOpen && auxCandidates.length > 0 ? (
                <select
                  autoFocus
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value) setAuxModelIds((ids) => [...ids, event.target.value])
                    setAuxPickerOpen(false)
                  }}
                  onBlur={() => setAuxPickerOpen(false)}
                  className="h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                  aria-label="Selecionar modelo auxiliar"
                >
                  <option value="" disabled>
                    Selecionar modelo...
                  </option>
                  {auxCandidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} {model.version} - {model.task}
                    </option>
                  ))}
                </select>
              ) : (
                auxCandidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAuxPickerOpen(true)}
                    className="flex items-center gap-1.5 self-start text-xs font-medium text-brand-blue hover:underline"
                  >
                    <Plus className="size-3.5" />
                    Adicionar modelo auxiliar
                  </button>
                )
              )}
              {auxModels.length === 0 && auxCandidates.length === 0 && (
                <p className="text-xs text-muted-foreground">Nenhum outro modelo disponível.</p>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <SliderInput label="Confiança mínima" value={threshold} onChange={setThreshold} />
              <SliderInput label="NMS IoU" value={nmsIou} onChange={setNmsIou} />

              <div className="relative flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Classes</span>
                <button
                  type="button"
                  onClick={() => setClassesOpen((v) => !v)}
                  aria-expanded={classesOpen}
                  className="flex h-9 items-center justify-between rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                >
                  <span className="truncate">{classesLabel}</span>
                  <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", classesOpen && "rotate-180")} />
                </button>
                {classesOpen && (
                  <div className="absolute top-full z-20 mt-1 flex max-h-48 w-full flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => setSelectedClasses([])}
                      className={cn(
                        "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                        selectedClasses.length === 0 ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      Todas
                      {selectedClasses.length === 0 && <CheckCircle2 className="size-3.5 text-brand-blue" />}
                    </button>
                    {classNames.map((className) => {
                      const selected = selectedClasses.includes(className)
                      return (
                        <button
                          key={className}
                          type="button"
                          onClick={() =>
                            setSelectedClasses((prev) =>
                              selected ? prev.filter((item) => item !== className) : [...prev, className],
                            )
                          }
                          className={cn(
                            "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                            selected ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {className}
                          {selected && <CheckCircle2 className="size-3.5 text-brand-blue" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-sm font-medium text-foreground">Processar intervalo</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Da imagem</span>
                  <input
                    type="number"
                    min={1}
                    max={totalImages}
                    value={rangeStart}
                    onChange={(event) => setRangeStart(event.target.value)}
                    className="h-9 rounded-lg bg-muted px-3 text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                    aria-label="Início do intervalo"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Até a imagem</span>
                  <input
                    type="number"
                    min={1}
                    max={totalImages}
                    value={rangeEnd}
                    onChange={(event) => setRangeEnd(event.target.value)}
                    className="h-9 rounded-lg bg-muted px-3 text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                    aria-label="Fim do intervalo"
                  />
                </label>
              </div>
              {rangeError ? (
                <p className="text-xs text-destructive">{rangeError}</p>
              ) : (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {rangeCount.toLocaleString("pt-BR")} {rangeCount === 1 ? "imagem" : "imagens"} de{" "}
                  {totalImages.toLocaleString("pt-BR")} serão processadas.
                </p>
              )}
              <Button
                variant="outline"
                onClick={handleGenerate}
                disabled={run.phase === "running" || !!rangeError || !hasModels}
              >
                Gerar intervalo
              </Button>
            </div>
          </div>
        </CollapsibleSection>
      </div>
      )}
    </section>
  )
}
