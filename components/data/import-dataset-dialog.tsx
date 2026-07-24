"use client"

import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderOpen,
  Loader2,
  Tags,
  Upload,
  UserRound,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  createImportTask,
  fetchLabels,
  uploadImportTaskFilesWithProgress,
} from "@/lib/api/client"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendCvatLabel, BackendImportJob } from "@/lib/api/types"

type UploadPhase = "idle" | "analyzing" | "creating" | "uploading" | "processing"

type ClassMapping = {
  sourceName: string
  targetName: string
  color: string
  count: number
}

type AnnotationImportTarget = "review" | "annotation"

type DatasetProfile = {
  files: File[]
  images: File[]
  totalBytes: number
  format: string
  annotationFiles: number
  classes: Array<{ name: string; count: number }>
  warnings: string[]
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"])
const annotationExtensions = new Set([".txt", ".json", ".xml"])
const classFileNames = new Set(["classes.txt", "obj.names", "data.yaml", "dataset.yaml"])
const fallbackColors = [
  "#4f8cff",
  "#22c55e",
  "#a855f7",
  "#f97316",
  "#eab308",
  "#14b8a6",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#6366f1",
]
const coco80ClassNames = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
]

export function ImportDatasetDialog({
  open,
  initialProjectId,
  lockProject = false,
  onClose,
  onImported,
}: {
  open: boolean
  initialProjectId?: string | null
  lockProject?: boolean
  onClose: () => void
  onImported?: (job: BackendImportJob, projectId: string | null) => void
}) {
  const { projects, activeProject, currentUser, isAdmin, annotators } = useCurrentUser()
  const [selectedProjectId, setSelectedProjectId] = React.useState(initialProjectId ?? activeProject?.id ?? "")
  const [name, setName] = React.useState(defaultDatasetName)
  const [profile, setProfile] = React.useState<DatasetProfile | null>(null)
  const [mappings, setMappings] = React.useState<ClassMapping[]>([])
  const [labels, setLabels] = React.useState<BackendCvatLabel[]>([])
  const [assigneeUserId, setAssigneeUserId] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<BackendImportJob | null>(null)
  const [phase, setPhase] = React.useState<UploadPhase>("idle")
  const [progress, setProgress] = React.useState({ loaded: 0, total: 0, percent: 0 })
  const [mappingEditorOpen, setMappingEditorOpen] = React.useState(false)
  const [annotationImportTarget, setAnnotationImportTarget] = React.useState<AnnotationImportTarget>("review")
  const analysisToken = React.useRef(0)

  const selectedProject = React.useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )
  const projectOptions = projects
  const projectLabelNames = React.useMemo(() => uniqueLabels(labels), [labels])
  const existingByName = React.useMemo(() => {
    const map = new Map<string, BackendCvatLabel>()
    for (const label of labels) map.set(label.name.toLocaleLowerCase("pt-BR"), label)
    return map
  }, [labels])
  const unresolvedMappings = mappings.filter((mapping) => !mapping.targetName.trim()).length
  const canSubmit =
    Boolean(selectedProjectId) &&
    Boolean(profile?.images.length) &&
    unresolvedMappings === 0 &&
    phase !== "analyzing" &&
    phase !== "creating" &&
    phase !== "uploading" &&
    phase !== "processing" &&
    !result
  const busy = phase !== "idle"

  React.useEffect(() => {
    if (!open) return
    const defaultProjectId = initialProjectId ?? activeProject?.id ?? projects[0]?.id ?? ""
    setSelectedProjectId(defaultProjectId)
    setName(defaultDatasetName())
    setProfile(null)
    setMappings([])
    setLabels([])
    setAssigneeUserId("")
    setError(null)
    setResult(null)
    setPhase("idle")
    setProgress({ loaded: 0, total: 0, percent: 0 })
    setMappingEditorOpen(false)
    setAnnotationImportTarget("review")
    analysisToken.current += 1
  }, [activeProject?.id, initialProjectId, open, projects])

  React.useEffect(() => {
    if (!open || !selectedProject?.externalId) {
      setLabels([])
      return
    }
    const controller = new AbortController()
    fetchLabels({ projectExternalId: selectedProject.externalId }, controller.signal)
      .then(setLabels)
      .catch(() => setLabels([]))
    return () => controller.abort()
  }, [open, selectedProject?.externalId])

  React.useEffect(() => {
    if (!profile) return
    setMappings(buildMappings(profile.classes, labels))
  }, [labels, profile])

  async function handleDatasetSelection(fileList: FileList | null) {
    const files = Array.from(fileList ?? [])
    const token = analysisToken.current + 1
    analysisToken.current = token
    setError(null)
    setResult(null)
    setProfile(null)
    setMappings([])
    setMappingEditorOpen(false)
    if (files.length === 0) return
    setPhase("analyzing")
    setProgress({ loaded: 0, total: files.length, percent: 1 })
    await nextFrame()
    try {
      const nextProfile = await analyzeDataset(files, (loaded, total) => {
        if (analysisToken.current !== token) return
        setProgress({ loaded, total, percent: Math.max(1, Math.round((loaded / Math.max(total, 1)) * 100)) })
      })
      if (analysisToken.current !== token) return
      setProfile(nextProfile)
      setMappings(buildMappings(nextProfile.classes, labels))
      setProgress({ loaded: files.length, total: files.length, percent: 100 })
      if (nextProfile.images.length === 0) {
        setError("Nenhuma imagem foi encontrada. Se for um ZIP, extraia a pasta antes de importar.")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel ler o dataset.")
    } finally {
      if (analysisToken.current === token) setPhase("idle")
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedProjectId) {
      setError("Selecione o projeto de destino.")
      return
    }
    if (!profile || profile.images.length === 0) {
      setError("Selecione uma pasta de dataset com imagens.")
      return
    }
    if (unresolvedMappings > 0) {
      setError("Resolva todas as classes antes de importar.")
      return
    }
    setError(null)
    setPhase("creating")
    setProgress({ loaded: 0, total: profile.totalBytes, percent: 1 })
    try {
      const assigneeId = isAdmin ? assigneeUserId || null : currentUser.role === "anotador" ? currentUser.id || null : null
      const created = await createImportTask({
        project_id: selectedProjectId,
        name: name.trim() || defaultDatasetName(),
        assignee_user_id: assigneeId,
        estimated_bytes: profile.totalBytes,
        labels: labelsFromMappings(mappings),
        class_mappings: mappings.map((mapping) => ({
          source_name: mapping.sourceName,
          target_name: mapping.targetName,
          color: mapping.color,
          count: mapping.count,
        })),
        annotation_import_target: profile.annotationFiles > 0 ? annotationImportTarget : "annotation",
        sync_after_import: true,
      })
      setPhase("uploading")
      const uploaded = await uploadImportTaskFilesWithProgress(created.job.id, profile.files, (uploadProgress) => {
        setProgress(uploadProgress)
      })
      setPhase("processing")
      setProgress({ loaded: profile.totalBytes, total: profile.totalBytes, percent: 100 })
      setResult(uploaded)
      onImported?.(uploaded, selectedProjectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel importar o dataset.")
    } finally {
      setPhase("idle")
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Importar dataset"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form
        onSubmit={submit}
        className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Importar dataset</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Leia a pasta, confira o catálogo e mapeie as classes para o projeto.
            </p>
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Nome no CVAT</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy || Boolean(result)}
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:bg-muted disabled:text-muted-foreground"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Projeto de destino</span>
                <select
                  value={selectedProjectId}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                  disabled={lockProject || busy || Boolean(result)}
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:bg-muted disabled:text-muted-foreground"
                >
                  <option value="">Selecione um projeto</option>
                  {projectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {isAdmin && (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Anotador responsável</span>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <select
                    value={assigneeUserId}
                    onChange={(event) => setAssigneeUserId(event.target.value)}
                    disabled={busy || Boolean(result) || annotators.length === 0}
                    className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-10 pr-3 text-sm outline-none focus:border-brand-blue disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <option value="">{annotators.length > 0 ? "Definir depois" : "Nenhum anotador ativo"}</option>
                    {annotators.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            )}

            <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/35 p-5 text-center transition-colors hover:bg-muted/55">
              <span className="flex size-11 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
                <FolderOpen className="size-5" />
              </span>
              <span className="text-sm font-medium text-foreground">
                {phase === "analyzing"
                  ? "Lendo dataset..."
                  : profile
                    ? `${profile.images.length.toLocaleString("pt-BR")} imagens encontradas`
                    : "Selecionar pasta do dataset"}
              </span>
              <span className="text-xs text-muted-foreground">
                YOLO, COCO, CVAT XML ou pasta com imagens. ZIP deve ser extraído antes.
              </span>
              <input
                type="file"
                multiple
                disabled={busy || Boolean(result)}
                onChange={(event) => {
                  const input = event.currentTarget
                  void handleDatasetSelection(input.files).finally(() => {
                    input.value = ""
                  })
                }}
                className="sr-only"
                {...directoryInputProps()}
              />
            </label>

            {(profile || progress.percent > 0) && (
              <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium text-foreground">{phaseTitle(phase, result)}</span>
                    {profile ? ` - ${formatBytes(profile.totalBytes)} selecionados` : ""}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">{progress.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand-blue transition-[width] duration-200"
                    style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                  />
                </div>
              </div>
            )}

            {profile && (
              <DatasetImportReviewStrip
                profile={profile}
                mappings={mappings}
                existingByName={existingByName}
              />
            )}

            {profile && profile.annotationFiles > 0 && (
              <AnnotationImportTargetControl
                value={annotationImportTarget}
                disabled={busy || Boolean(result)}
                onChange={setAnnotationImportTarget}
              />
            )}

            {mappings.length > 0 && (
              <ClassMappingControl
                open={mappingEditorOpen}
                onOpenChange={setMappingEditorOpen}
                mappings={mappings}
                suggestions={projectLabelNames}
                existingByName={existingByName}
                onChange={(sourceName, patch) => {
                  setMappings((current) =>
                    current.map((mapping) =>
                      mapping.sourceName === sourceName ? { ...mapping, ...patch } : mapping,
                    ),
                  )
                }}
              />
            )}

            {profile?.warnings.map((warning) => (
              <div key={warning} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
            {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {result && (
              <div className="flex items-start gap-3 rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-brand-green">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <span>Dataset enviado como task CVAT. Job {result.job.id.slice(0, 8)} criado.</span>
              </div>
            )}
          </div>

        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-4">
          <span className="text-xs text-muted-foreground">
            {profile
              ? `${profile.images.length.toLocaleString("pt-BR")} imagens - ${mappings.length} classes`
              : "Selecione a pasta antes de importar"}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {result ? "Fechar" : "Cancelar"}
            </Button>
            {!result && (
              <Button type="submit" disabled={!canSubmit}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                Importar dataset
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

function AnnotationImportTargetControl({
  value,
  disabled,
  onChange,
}: {
  value: AnnotationImportTarget
  disabled: boolean
  onChange: (value: AnnotationImportTarget) => void
}) {
  const options: Array<{ value: AnnotationImportTarget; label: string; detail: string }> = [
    {
      value: "review",
      label: "Revisão",
      detail: "Frames anotados entram na fila",
    },
    {
      value: "annotation",
      label: "Anotação",
      detail: "Frames anotados abrem para ajuste",
    },
  ]

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <p className="mb-2 text-sm font-medium text-foreground">Destino das anotações importadas</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                selected ? "border-brand-blue bg-surface-blue" : "border-border bg-card hover:bg-muted"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span
                  className={`flex size-4 items-center justify-center rounded-full border ${
                    selected ? "border-brand-blue bg-brand-blue" : "border-border"
                  }`}
                >
                  {selected && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {option.label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{option.detail}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ClassMappingControl({
  open,
  onOpenChange,
  mappings,
  suggestions,
  existingByName,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mappings: ClassMapping[]
  suggestions: string[]
  existingByName: Map<string, BackendCvatLabel>
  onChange: (sourceName: string, patch: Partial<ClassMapping>) => void
}) {
  const newClasses = countNewClasses(mappings, existingByName)
  const reusedClasses = mappings.length - newClasses

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/45"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-blue text-brand-blue">
            <Tags className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">Mapeamento de classes</span>
            <span className="block truncate text-xs text-muted-foreground">
              {mappings.length.toLocaleString("pt-BR")} classes detectadas ·{" "}
              {reusedClasses.toLocaleString("pt-BR")} reaproveitadas · {newClasses.toLocaleString("pt-BR")} novas
            </span>
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground">
          {open ? "Ocultar" : "Configurar"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border">
          <div className="max-h-72 overflow-y-auto p-2">
            <datalist id="dataset-class-targets">
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {mappings.map((mapping) => (
              <div
                key={mapping.sourceName}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{mapping.sourceName}</p>
                  <p className="text-xs text-muted-foreground">
                    {mapping.count.toLocaleString("pt-BR")} referências detectadas
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={mapping.color}
                    onChange={(event) => onChange(mapping.sourceName, { color: event.target.value })}
                    className="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-1"
                    aria-label={`Cor de ${mapping.sourceName}`}
                  />
                  <input
                    value={mapping.targetName}
                    list="dataset-class-targets"
                    onChange={(event) => onChange(mapping.sourceName, { targetName: event.target.value })}
                    placeholder="Classe de destino"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DatasetImportReviewStrip({
  profile,
  mappings,
  existingByName,
}: {
  profile: DatasetProfile
  mappings: ClassMapping[]
  existingByName: Map<string, BackendCvatLabel>
}) {
  const newClasses = countNewClasses(mappings, existingByName)
  const reusedClasses = mappings.length - newClasses

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Database className="size-4 text-brand-blue" />
        Revisão da importação
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_.8fr_.8fr_1.25fr]">
        <CompactSummaryTile label="Formato" value={profile.format} />
        <CompactSummaryTile label="Imagens" value={profile.images.length.toLocaleString("pt-BR")} />
        <CompactSummaryTile label="Anotações" value={profile.annotationFiles.toLocaleString("pt-BR")} />
        <div className="min-w-0 rounded-lg bg-card px-3 py-2">
          <p className="text-xs text-muted-foreground">Classes</p>
          <p className="text-sm font-semibold text-foreground">{mappings.length.toLocaleString("pt-BR")}</p>
          {mappings.length > 0 && (
            <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
              {reusedClasses.toLocaleString("pt-BR")} existentes · {newClasses.toLocaleString("pt-BR")} novas
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function CompactSummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold text-foreground" title={value}>
        {value}
      </p>
    </div>
  )
}

function countNewClasses(mappings: ClassMapping[], existingByName: Map<string, BackendCvatLabel>) {
  return mappings.filter((mapping) => !existingByName.has(mapping.targetName.toLocaleLowerCase("pt-BR"))).length
}

async function analyzeDataset(
  files: File[],
  onProgress: (loaded: number, total: number) => void,
): Promise<DatasetProfile> {
  const images = files.filter(isImageFile)
  const annotationCandidates = files.filter(isAnnotationFile)
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  const warnings: string[] = []
  const classNames = new Set<string>()
  const classCounts = new Map<string, number>()
  const yoloClassIds = new Map<number, number>()
  let annotationFileCount = 0
  let detectedFormat = images.length > 0 ? "Pasta de imagens" : "Desconhecido"
  let loaded = 0
  const totalToRead = Math.min(annotationCandidates.length, 1200)

  for (const file of annotationCandidates.slice(0, totalToRead)) {
    const name = relativeName(file).toLocaleLowerCase("pt-BR")
    if (file.size > 4 * 1024 * 1024) {
      loaded += 1
      onProgress(loaded, Math.max(totalToRead, 1))
      continue
    }
    const text = await file.text()
    if (classFileNames.has(baseName(name)) || name.endsWith(".names")) {
      for (const label of parseClassFile(text, name)) classNames.add(label)
      detectedFormat = name.endsWith(".yaml") ? "YOLO" : "Arquivo de classes"
    } else if (name.endsWith(".json")) {
      const labels = parseCocoCategories(text)
      if (labels.length > 0) {
        for (const label of labels) classNames.add(label)
        detectedFormat = "COCO JSON"
        annotationFileCount += 1
      }
    } else if (name.endsWith(".xml")) {
      const labels = parseCvatXmlLabels(text)
      if (labels.length > 0) {
        for (const label of labels) classNames.add(label)
        detectedFormat = "CVAT XML"
        annotationFileCount += 1
      }
    } else if (name.endsWith(".txt")) {
      const ids = parseYoloLabelIds(text)
      if (ids.length > 0 || isYoloLabelPath(name)) {
        annotationFileCount += 1
        for (const classId of ids) {
          yoloClassIds.set(classId, (yoloClassIds.get(classId) ?? 0) + 1)
        }
        detectedFormat = "YOLO"
      }
    }
    loaded += 1
    onProgress(loaded, Math.max(totalToRead, 1))
    if (loaded % 40 === 0) await nextFrame()
  }

  const explicitClassNames = classNames.size > 0
  const yoloClassIdList = Array.from(yoloClassIds.keys())
  let orderedNames = Array.from(classNames)
  if (!explicitClassNames && yoloClassIdList.length > 0 && looksLikeCocoDataset(files)) {
    const maxId = Math.max(...yoloClassIdList)
    if (maxId < coco80ClassNames.length) {
      orderedNames = coco80ClassNames
      detectedFormat = "YOLO (COCO)"
      warnings.push("Nao encontrei data.yaml/classes.txt; usei nomes COCO80 porque a pasta parece coco128.")
    }
  }
  if (!explicitClassNames && orderedNames.length === 0 && yoloClassIdList.length > 0) {
    warnings.push("Nao encontrei arquivo de nomes de classes; usando classe_N para os IDs YOLO.")
  }
  for (const [classId, count] of yoloClassIds) {
    const name = orderedNames[classId] ?? `classe_${classId}`
    classCounts.set(name, (classCounts.get(name) ?? 0) + count)
    classNames.add(name)
  }
  for (const name of classNames) {
    if (!classCounts.has(name)) classCounts.set(name, 0)
  }
  if (annotationCandidates.length > totalToRead) {
    warnings.push(`Amostramos ${totalToRead.toLocaleString("pt-BR")} arquivos de anotação para detectar classes.`)
  }

  return {
    files,
    images,
    totalBytes,
    format: detectedFormat,
    annotationFiles: annotationFileCount,
    classes: Array.from(classCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    warnings,
  }
}

function buildMappings(classes: Array<{ name: string; count: number }>, labels: BackendCvatLabel[]): ClassMapping[] {
  const existingByName = new Map(labels.map((label) => [label.name.toLocaleLowerCase("pt-BR"), label]))
  return classes.map((source, index) => {
    const existing = existingByName.get(source.name.toLocaleLowerCase("pt-BR"))
    return {
      sourceName: source.name,
      targetName: existing?.name ?? source.name,
      color: existing?.color ?? fallbackColors[index % fallbackColors.length],
      count: source.count,
    }
  })
}

function labelsFromMappings(mappings: ClassMapping[]) {
  const byName = new Map<string, { name: string; color: string; attributes: unknown[] }>()
  for (const mapping of mappings) {
    const name = mapping.targetName.trim()
    if (!name) continue
    const key = name.toLocaleLowerCase("pt-BR")
    if (!byName.has(key)) byName.set(key, { name, color: mapping.color, attributes: [] })
  }
  return Array.from(byName.values())
}

function uniqueLabels(labels: BackendCvatLabel[]) {
  const seen = new Set<string>()
  const names: string[] = []
  for (const label of labels) {
    const key = label.name.toLocaleLowerCase("pt-BR")
    if (seen.has(key)) continue
    seen.add(key)
    names.push(label.name)
  }
  return names.sort((a, b) => a.localeCompare(b, "pt-BR"))
}

function parseClassFile(text: string, filename: string) {
  if (filename.endsWith(".yaml")) return parseYamlNames(text)
  return text
    .split(/\r?\n/)
    .map(cleanLabelName)
    .filter(Boolean)
}

function parseYamlNames(text: string) {
  const inline = text.match(/names\s*:\s*\[([^\]]+)\]/)
  if (inline?.[1]) {
    return inline[1]
      .split(",")
      .map(cleanLabelName)
      .filter(Boolean)
  }
  const lines = text.split(/\r?\n/)
  const names: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^\s*names\s*:/.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    if (/^\S/.test(line) && line.trim()) break
    const mapping = line.match(/^\s*(?:-\s*|\d+\s*:\s*)(.+)$/)
    if (mapping?.[1]) {
      const name = cleanLabelName(mapping[1])
      if (name) names.push(name)
    }
  }
  return names
}

function parseCocoCategories(text: string) {
  try {
    const parsed = JSON.parse(text) as { categories?: Array<{ name?: unknown }> }
    return Array.isArray(parsed.categories)
      ? parsed.categories.map((item) => cleanLabelName(String(item.name ?? ""))).filter(Boolean)
      : []
  } catch {
    return []
  }
}

function parseCvatXmlLabels(text: string) {
  return Array.from(text.matchAll(/<label>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/label>/g))
    .map((match) => cleanLabelName(match[1]))
    .filter(Boolean)
}

function parseYoloLabelIds(text: string) {
  const ids: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0]
    if (!first) continue
    const id = Number(first)
    if (Number.isInteger(id) && id >= 0) ids.push(id)
  }
  return ids
}

function isYoloLabelPath(path: string) {
  return path.endsWith(".txt") && /(^|\/)labels(\/|$)/.test(path)
}

function looksLikeCocoDataset(files: File[]) {
  return files.some((file) => {
    const path = relativeName(file).toLocaleLowerCase("pt-BR")
    return path.includes("coco128") || path.includes("coco/")
  })
}

function cleanLabelName(value: string) {
  return value.trim().replace(/^['"]|['"]$/g, "")
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || imageExtensions.has(extensionOf(file.name))
}

function isAnnotationFile(file: File) {
  const extension = extensionOf(file.name)
  const name = baseName(file.name).toLocaleLowerCase("pt-BR")
  return annotationExtensions.has(extension) || classFileNames.has(name) || name.endsWith(".names")
}

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf(".")
  return dot >= 0 ? filename.slice(dot).toLocaleLowerCase("pt-BR") : ""
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

function relativeName(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function directoryInputProps() {
  return {
    webkitdirectory: "",
    directory: "",
  } as React.InputHTMLAttributes<HTMLInputElement> & Record<string, string>
}

function defaultDatasetName() {
  const date = new Date()
  return `dataset_${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`
}

function phaseTitle(phase: UploadPhase, result: BackendImportJob | null) {
  if (result) return "Importação enviada"
  if (phase === "analyzing") return "Lendo estrutura"
  if (phase === "creating") return "Criando task"
  if (phase === "uploading") return "Enviando imagens"
  if (phase === "processing") return "Sincronizando CVAT"
  return "Pronto para importar"
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}
