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
type ExecMode = "continua" | "intervalo"
type GenerateSummary = { created: number; ignored: number; conflicts: number; jobId?: string }

type RunState =
  | { phase: "idle" }
  | { phase: "running"; processed: number; total: number; detections: number }
  | { phase: "done"; created: number; ignored: number; conflicts: number; jobId?: string }
  | { phase: "failed"; message: string }

/* ---------- Small pieces ---------- */

function modelStatusMeta(status: ModelInfo["status"]) {
  if (status === "Disponível") return { dot: "bg-brand-green", text: "text-brand-green" }
  if (status === "Carregando") return { dot: "bg-warning", text: "text-warning" }
  return { dot: "bg-destructive", text: "text-destructive" }
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

  // ---- Modo de execução ----
  const [execMode, setExecMode] = useState<ExecMode>("continua")
  const [liveActive, setLiveActive] = useState(false)
  const [liveAnnotating, setLiveAnnotating] = useState(false)
  const [liveCount, setLiveCount] = useState(0)
  const [rangeStart, setRangeStart] = useState("1")
  const [rangeEnd, setRangeEnd] = useState("50")

  const [run, setRun] = useState<RunState>({ phase: "idle" })
  const [conflictPrompt, setConflictPrompt] = useState<string[] | null>(null)
  const runTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLiveIndex = useRef<number | null>(null)

  useEffect(() => () => {
    if (runTimer.current) clearInterval(runTimer.current)
    if (liveTimer.current) clearTimeout(liveTimer.current)
  }, [])

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

  const applyModes: { id: ApplyMode; label: string }[] = [
    { id: "sugestoes", label: "Criar como sugestões" },
    { id: "aceitas", label: "Criar como anotações aceitas" },
    { id: "substituir", label: "Substituir predições anteriores do mesmo modelo" },
  ]

  const classesLabel =
    selectedClasses.length === 0
      ? "Todas"
      : selectedClasses.length <= 2
        ? selectedClasses.join(", ")
        : `${selectedClasses.length} classes`

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

  const startRun = (replaceModels: string[]) => {
    if (!hasModels) return
    setConflictPrompt(null)
    setRun({ phase: "running", processed: 0, total: rangeCount, detections: 0 })
    Promise.resolve(
      onGenerate({
        models: selectedModels,
        threshold,
        nmsIou,
        classes: selectedClasses,
        scope: `intervalo ${startNum}-${endNum}`,
        applyMode,
        replaceModels,
        frameStart: startNum - 1,
        frameEnd: endNum - 1,
      }),
    )
      .then((result) => setRun({ phase: "done", ...result }))
      .catch((err) =>
        setRun({
          phase: "failed",
          message: err instanceof Error ? err.message : "Falha ao enfileirar inferencia.",
        }),
      )
  }

  const handleGenerate = () => {
    if (run.phase === "running" || rangeError || !hasModels) return
    // Se o modo não é "substituir" e já existem sugestões de algum modelo selecionado, perguntar.
    const conflicting = selectedModels.map((m) => m.id).filter((id) => suggestionModelIds.includes(id))
    if (applyMode !== "substituir" && conflicting.length > 0) {
      setConflictPrompt(conflicting)
      return
    }
    startRun(applyMode === "substituir" ? selectedModels.map((m) => m.id) : [])
  }

  const cancelRun = () => {
    if (runTimer.current) clearInterval(runTimer.current)
    runTimer.current = null
    setRun({ phase: "idle" })
  }

  // ---- Modo contínuo: anota junto com o usuário ----
  const runLiveForCurrentImage = () => {
    if (!hasModels) return
    setLiveAnnotating(true)
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => {
      Promise.resolve(onGenerate({
        models: selectedModels,
        threshold,
        nmsIou,
        classes: selectedClasses,
        scope: `continua · imagem ${imageIndex}`,
        applyMode,
        // No modo contínuo, cada imagem substitui as sugestões anteriores dos mesmos modelos.
        replaceModels: selectedModels.map((m) => m.id),
        frameStart: imageIndex - 1,
        frameEnd: imageIndex - 1,
      }))
        .then(() => setLiveCount((c) => c + 1))
        .finally(() => setLiveAnnotating(false))
    }, 700)
  }

  useEffect(() => {
    if (!liveActive) return
    if (lastLiveIndex.current === imageIndex) return
    lastLiveIndex.current = imageIndex
    runLiveForCurrentImage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIndex, liveActive])

  const toggleLive = () => {
    if (liveActive) {
      if (liveTimer.current) clearTimeout(liveTimer.current)
      setLiveAnnotating(false)
      setLiveActive(false)
    } else {
      setLiveCount(0)
      lastLiveIndex.current = imageIndex
      setLiveActive(true)
      runLiveForCurrentImage()
    }
  }

  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Autoanotação</p>
        <Sparkles className="size-4 text-brand-blue" />
      </div>
      <div className="flex flex-col gap-3">
        {/* Modelos */}
        <CollapsibleSection title="Modelos">
          <div className="flex flex-col gap-2">
            {hasModels ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Modelo principal</span>
                  <select
                    value={mainModelId}
                    onChange={(e) => {
                      setMainModelId(e.target.value)
                      setAuxModelIds((ids) => ids.filter((id) => id !== e.target.value))
                    }}
                    className="h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} {m.version} - {m.task}
                      </option>
                    ))}
                  </select>
                </label>
                <ModelRow model={mainModel} />
              </>
            ) : (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                Nenhum modelo registrado para autoanotação.
              </p>
            )}

            {auxModels.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                onRemove={() => setAuxModelIds((ids) => ids.filter((id) => id !== m.id))}
              />
            ))}

            {auxPickerOpen && auxCandidates.length > 0 ? (
              <select
                autoFocus
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) setAuxModelIds((ids) => [...ids, e.target.value])
                  setAuxPickerOpen(false)
                }}
                onBlur={() => setAuxPickerOpen(false)}
                className="h-9 rounded-lg bg-muted px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                aria-label="Selecionar modelo auxiliar"
              >
                <option value="" disabled>
                  Selecionar modelo...
                </option>
                {auxCandidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.version} - {m.task}
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
          </div>
        </CollapsibleSection>

        {/* Parâmetros */}
        <CollapsibleSection title="Parâmetros">
          <div className="flex flex-col gap-3">
            <SliderInput label="Confiança mínima" value={threshold} onChange={setThreshold} />
            <SliderInput label="NMS IoU" value={nmsIou} onChange={setNmsIou} />

            {/* Classes multiselect */}
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
                  {classNames.map((c) => {
                    const on = selectedClasses.includes(c)
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() =>
                          setSelectedClasses((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]))
                        }
                        className={cn(
                          "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                          on ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {c}
                        {on && <CheckCircle2 className="size-3.5 text-brand-blue" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Modo de aplicação */}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-xs text-muted-foreground">Modo de aplicação</legend>
              {applyModes.map((m) => (
                <label key={m.id} className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name="apply-mode"
                    value={m.id}
                    checked={applyMode === m.id}
                    onChange={() => setApplyMode(m.id)}
                    className="mt-0.5 accent-[var(--brand-blue)]"
                  />
                  <span className="leading-snug">{m.label}</span>
                </label>
              ))}
              <p className="text-xs text-muted-foreground">Anotações manuais nunca são sobrescritas.</p>
            </fieldset>
          </div>
        </CollapsibleSection>

        {/* Execução / conflito / resultado */}
        {conflictPrompt && (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-surface-subtle p-3">
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
          <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Loader2 className="size-4 animate-spin text-brand-blue" />
              Enfileirando inferência...
            </p>
            <ProgressBar value={run.total > 0 ? (run.processed / run.total) * 100 : 0} />
            <div className="flex flex-col gap-0.5 text-xs tabular-nums text-muted-foreground">
              <span>
                Intervalo: {rangeCount.toLocaleString("pt-BR")} {rangeCount === 1 ? "imagem" : "imagens"}
              </span>
              <span>O progresso detalhado aparece na central de jobs.</span>
            </div>
            <Button size="sm" variant="outline" onClick={cancelRun} className="self-start">
              Cancelar
            </Button>
          </div>
        )}

        {run.phase === "done" && (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-brand-green">
              <CheckCircle2 className="size-4" />
              Job enfileirado
            </p>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <li>As sugestões aparecerão quando o backend concluir a inferência.</li>
              {run.jobId && <li>Job backend: {run.jobId}</li>}
            </ul>
            <Button size="sm" variant="outline" className="self-start">
              Enviar para revisão rápida
            </Button>
          </div>
        )}

        {/* Camadas de predição */}
        {run.phase === "failed" && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-surface-subtle p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="size-4" />
              Falha na autoanotacao
            </p>
            <p className="text-xs text-muted-foreground">{run.message}</p>
          </div>
        )}

        {layers.length > 0 && (
          <CollapsibleSection title="Camadas de predição">
            <div className="flex flex-col gap-1.5">
              {layers.map((l) => (
                <div key={l.modelId} className="flex items-center justify-between gap-2 rounded-lg px-1 py-1">
                  <span className={cn("truncate text-sm", l.visible ? "text-foreground" : "text-muted-foreground line-through")}>
                    {l.label}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {l.count} {l.unit}
                    </span>
                    <button
                      type="button"
                      onClick={() => onToggleLayer(l.modelId)}
                      aria-label={l.visible ? `Ocultar camada ${l.label}` : `Mostrar camada ${l.label}`}
                      aria-pressed={l.visible}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {l.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveLayer(l.modelId)}
                      aria-label={`Remover camada ${l.label}`}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Execução */}
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Execução</span>

          {/* Seletor de modo */}
          <div role="radiogroup" aria-label="Modo de execução" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(
              [
                { id: "continua", label: "Contínua" },
                { id: "intervalo", label: "Intervalo" },
              ] as { id: ExecMode; label: string }[]
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={execMode === m.id}
                onClick={() => {
                  setExecMode(m.id)
                  // Trocar para Intervalo pausa o modo contínuo para evitar anotações em segundo plano.
                  if (m.id === "intervalo" && liveActive) {
                    if (liveTimer.current) clearTimeout(liveTimer.current)
                    setLiveAnnotating(false)
                    setLiveActive(false)
                  }
                }}
                className={cn(
                  "h-8 rounded-md text-sm font-medium transition-colors",
                  execMode === m.id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {execMode === "continua" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                O modelo anota junto com você: a cada imagem que você abre, novas sugestões são geradas automaticamente.
              </p>

              {liveActive && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-brand-green/40 bg-surface-subtle p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-brand-green">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-green opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-brand-green" />
                    </span>
                    Autoanotação ativa
                  </p>
                  <div className="flex flex-col gap-0.5 text-xs tabular-nums text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {liveAnnotating && <Loader2 className="size-3 animate-spin text-brand-blue" />}
                      {liveAnnotating
                        ? `Anotando imagem ${imageIndex.toLocaleString("pt-BR")}...`
                        : `Aguardando você navegar · imagem ${imageIndex.toLocaleString("pt-BR")}`}
                    </span>
                    <span>
                      {liveCount} {liveCount === 1 ? "imagem anotada" : "imagens anotadas"} nesta sessão
                    </span>
                  </div>
                </div>
              )}

              <Button onClick={toggleLive} variant={liveActive ? "outline" : "default"} disabled={!hasModels}>
                <Sparkles className="size-4" />
                {liveActive ? "Pausar autoanotação" : "Ativar autoanotação"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Defina um intervalo de imagens do lote para anotar de uma só vez.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">Da imagem</span>
                  <input
                    type="number"
                    min={1}
                    max={totalImages}
                    value={rangeStart}
                    onChange={(e) => setRangeStart(e.target.value)}
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
                    onChange={(e) => setRangeEnd(e.target.value)}
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
              <Button onClick={handleGenerate} disabled={run.phase === "running" || !!rangeError || !hasModels}>
                <Sparkles className="size-4" />
                Gerar anotações
              </Button>
            </div>
          )}

          <Button variant="outline" onClick={onClearSuggestions} disabled={layers.length === 0}>
            Limpar sugestões
          </Button>
          <button type="button" className="self-center text-xs text-muted-foreground hover:text-foreground hover:underline">
            Ver configurações avançadas
          </button>
        </div>
      </div>
    </section>
  )
}
