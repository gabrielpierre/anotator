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

type AnnotationImportTarget = "review" | "annotation" | "ready"
type DuplicatePolicy = "review" | "ignore" | "include"

type DuplicateConflict = {
  id: string
  keepPath: string
  keepClass: string
  keepPreviewUrl: string | null
  duplicatePath: string
  duplicateClass: string
  duplicatePreviewUrl: string | null
}

type DatasetProfile = {
  sourceFiles: File[]
  sourceImages: File[]
  files: File[]
  images: File[]
  totalBytes: number
  format: string
  annotationFiles: number
  annotationCount: number
  classes: Array<{ name: string; count: number }>
  warnings: string[]
  blockingIssues: string[]
  duplicateConflicts: DuplicateConflict[]
}

type DirectoryDuplicateReview = {
  files: File[]
  images: File[]
  skippedByClass: Map<string, number>
  skippedCount: number
  conflicts: DuplicateConflict[]
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"])
const annotationExtensions = new Set([".txt", ".json", ".xml"])
const classFileNames = new Set(["classes.txt", "obj.names", "data.yaml", "dataset.yaml"])
const splitFolderNames = new Set(["train", "training", "val", "valid", "validation", "test", "testing"])
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
  const [duplicatePolicy, setDuplicatePolicy] = React.useState<DuplicatePolicy>("review")
  const [duplicateResolverOpen, setDuplicateResolverOpen] = React.useState(false)
  const [duplicateResolutions, setDuplicateResolutions] = React.useState<Record<string, string>>({})
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
  const busy = phase !== "idle"
  const submitBlockReason = importSubmitBlockReason({
    selectedProjectId,
    profile,
    unresolvedMappings,
    duplicatePolicy,
    duplicateResolutions,
  })
  const canSubmit =
    !submitBlockReason &&
    !busy &&
    !result

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
    setDuplicatePolicy("review")
    setDuplicateResolverOpen(false)
    setDuplicateResolutions({})
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
    setDuplicatePolicy("review")
    setDuplicateResolverOpen(false)
    setDuplicateResolutions({})
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
      setDuplicateResolverOpen((nextProfile.duplicateConflicts?.length ?? 0) > 0)
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
    const duplicateBlockReason = duplicateSubmitBlockReason(profile, duplicatePolicy, duplicateResolutions)
    if (duplicateBlockReason) {
      setError(duplicateBlockReason)
      return
    }
    const importFiles = importFilesForDuplicatePolicy(profile, duplicatePolicy, duplicateResolutions)
    const importBytes = importFiles.reduce((total, file) => total + file.size, 0)
    setError(null)
    setPhase("creating")
    setProgress({ loaded: 0, total: importBytes, percent: 1 })
    try {
      const assigneeId = isAdmin ? assigneeUserId || null : currentUser.role === "anotador" ? currentUser.id || null : null
      const created = await createImportTask({
        project_id: selectedProjectId,
        name: name.trim() || defaultDatasetName(),
        assignee_user_id: assigneeId,
        estimated_bytes: importBytes,
        labels: labelsFromMappings(mappings),
        class_mappings: mappings.map((mapping) => ({
          source_name: mapping.sourceName,
          target_name: mapping.targetName,
          color: mapping.color,
          count: mapping.count,
        })),
        annotation_import_target: profileAnnotationCount(profile) > 0 ? annotationImportTarget : "annotation",
        duplicate_policy: duplicatePolicy,
        sync_after_import: true,
      })
      setPhase("uploading")
      const uploaded = await uploadImportTaskFilesWithProgress(created.job.id, importFiles, (uploadProgress) => {
        setProgress(uploadProgress)
      })
      setPhase("processing")
      setProgress({ loaded: importBytes, total: importBytes, percent: 100 })
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
            <div className={`grid gap-3 ${lockProject ? "" : "sm:grid-cols-2"}`}>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Nome no CVAT</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy || Boolean(result)}
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:bg-muted disabled:text-muted-foreground"
                />
              </label>

              {!lockProject && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-foreground">Projeto de destino</span>
                  <select
                    value={selectedProjectId}
                    onChange={(event) => setSelectedProjectId(event.target.value)}
                    disabled={busy || Boolean(result)}
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
              )}
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

            {profile && profileAnnotationCount(profile) > 0 && (
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

            {profile && (profile.duplicateConflicts?.length ?? 0) > 0 && (
              <DuplicateReviewControl
                conflicts={profile.duplicateConflicts}
                policy={duplicatePolicy}
                resolverOpen={duplicateResolverOpen}
                resolutions={duplicateResolutions}
                onPolicyChange={setDuplicatePolicy}
                onResolverOpenChange={setDuplicateResolverOpen}
                onResolve={(conflictId, keepPath) => {
                  setDuplicateResolutions((current) => ({ ...current, [conflictId]: keepPath }))
                }}
              />
            )}

            {profile?.warnings.map((warning) => (
              <div key={warning} className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{warning}</span>
              </div>
            ))}
            {profile?.blockingIssues?.map((issue) => (
              <div key={issue} className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{issue}</span>
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
          <span className="flex min-w-0 flex-col gap-0.5 text-xs">
            {!busy && !result && submitBlockReason ? (
              <span className="truncate text-destructive">{submitBlockReason}</span>
            ) : (
              <span className="text-muted-foreground">
                {profile
                  ? `${profile.images.length.toLocaleString("pt-BR")} imagens - ${mappings.length} classes`
                  : "Selecione a pasta antes de importar"}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {result ? "Fechar" : "Cancelar"}
            </Button>
            {!result && (
              <Button type="submit" disabled={!canSubmit} title={submitBlockReason ?? undefined}>
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

function importSubmitBlockReason({
  selectedProjectId,
  profile,
  unresolvedMappings,
  duplicatePolicy,
  duplicateResolutions,
}: {
  selectedProjectId: string
  profile: DatasetProfile | null
  unresolvedMappings: number
  duplicatePolicy: DuplicatePolicy
  duplicateResolutions: Record<string, string>
}) {
  if (!selectedProjectId) return "Selecione um projeto de destino para importar."
  if (!profile) return "Selecione a pasta do dataset antes de importar."
  const duplicateBlockReason = duplicateSubmitBlockReason(profile, duplicatePolicy, duplicateResolutions)
  if (duplicateBlockReason) return duplicateBlockReason
  if (profile.images.length === 0) return "A pasta selecionada não possui imagens importáveis."
  if (unresolvedMappings > 0) return "Resolva todas as classes antes de importar."
  return null
}

function profileAnnotationCount(profile: DatasetProfile) {
  return profile.annotationCount ?? profile.annotationFiles ?? 0
}

function DuplicateReviewControl({
  conflicts,
  policy,
  resolverOpen,
  resolutions,
  onPolicyChange,
  onResolverOpenChange,
  onResolve,
}: {
  conflicts: DuplicateConflict[]
  policy: DuplicatePolicy
  resolverOpen: boolean
  resolutions: Record<string, string>
  onPolicyChange: (policy: DuplicatePolicy) => void
  onResolverOpenChange: (open: boolean) => void
  onResolve: (conflictId: string, keepPath: string) => void
}) {
  const resolved = conflicts.filter((conflict) => Boolean(resolutions[conflict.id])).length
  const allResolved = resolved === conflicts.length
  const status =
    policy === "include"
      ? "Todas serão adicionadas."
      : policy === "ignore"
        ? "Duplicatas conflitantes serão ignoradas."
        : allResolved
          ? "Conflitos resolvidos."
          : `${resolved.toLocaleString("pt-BR")} de ${conflicts.length.toLocaleString("pt-BR")} resolvido(s).`

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <AlertTriangle className="size-4 text-muted-foreground" />
            Duplicatas com classes diferentes
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{status}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onResolverOpenChange(!resolverOpen)}
        >
          {resolverOpen ? "Fechar" : "Resolver"}
        </Button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <DuplicatePolicyButton
          active={policy === "review"}
          label="Resolver"
          description="Escolher classe por conflito"
          onClick={() => {
            onPolicyChange("review")
            onResolverOpenChange(true)
          }}
        />
        <DuplicatePolicyButton
          active={policy === "ignore"}
          label="Ignorar tudo"
          description="Manter a primeira ocorrência"
          onClick={() => onPolicyChange("ignore")}
        />
        <DuplicatePolicyButton
          active={policy === "include"}
          label="Adicionar tudo"
          description="Importar mesmo com conflito"
          onClick={() => onPolicyChange("include")}
        />
      </div>

      {resolverOpen && policy === "review" && (
        <div className="mt-3 space-y-2">
          {conflicts.map((conflict) => {
            const selected = resolutions[conflict.id]
            return (
              <div key={conflict.id}>
                <p className="mb-2 truncate text-xs text-muted-foreground" title={`${conflict.keepPath} / ${conflict.duplicatePath}`}>
                  Mesmo arquivo em duas classes
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <DuplicateChoiceButton
                    active={selected === conflict.keepPath}
                    classNameLabel={conflict.keepClass}
                    path={conflict.keepPath}
                    previewUrl={conflict.keepPreviewUrl}
                    onClick={() => onResolve(conflict.id, conflict.keepPath)}
                  />
                  <DuplicateChoiceButton
                    active={selected === conflict.duplicatePath}
                    classNameLabel={conflict.duplicateClass}
                    path={conflict.duplicatePath}
                    previewUrl={conflict.duplicatePreviewUrl}
                    onClick={() => onResolve(conflict.id, conflict.duplicatePath)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DuplicatePolicyButton({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-left transition ${
        active ? "border-brand-blue bg-brand-blue/10 text-foreground" : "border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span>
    </button>
  )
}

function DuplicateChoiceButton({
  active,
  classNameLabel,
  path,
  previewUrl,
  onClick,
}: {
  active: boolean
  classNameLabel: string
  path: string
  previewUrl: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-0 rounded-lg text-left transition ${
        active ? "text-foreground" : "text-foreground hover:bg-muted/60"
      }`}
    >
      <span className={`block aspect-[4/3] overflow-hidden rounded-lg border ${
        active ? "border-brand-blue ring-2 ring-brand-blue/20" : "border-border"
      }`}>
        {previewUrl ? (
          <img src={previewUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-xs text-muted-foreground">Sem preview</span>
        )}
      </span>
      <span className="block px-1.5 py-2">
        <span className="block truncate text-sm font-medium text-foreground">{classNameLabel}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={path}>
          {path}
        </span>
      </span>
    </button>
  )
}

function duplicateSubmitBlockReason(
  profile: DatasetProfile,
  duplicatePolicy: DuplicatePolicy,
  duplicateResolutions: Record<string, string>,
) {
  const conflicts = profile.duplicateConflicts ?? []
  if (conflicts.length === 0 || duplicatePolicy !== "review") return null
  const unresolved = conflicts.filter((conflict) => !duplicateResolutions[conflict.id]).length
  if (unresolved === 0) return null
  return `Resolva ${unresolved.toLocaleString("pt-BR")} duplicata(s) com classes diferentes antes de importar.`
}

function importFilesForDuplicatePolicy(
  profile: DatasetProfile,
  duplicatePolicy: DuplicatePolicy,
  duplicateResolutions: Record<string, string>,
) {
  const conflicts = profile.duplicateConflicts ?? []
  if (duplicatePolicy === "include") return profile.sourceFiles ?? profile.files
  const skippedPaths = new Set<string>()
  for (const conflict of conflicts) {
    const keepPath = duplicatePolicy === "ignore" ? conflict.keepPath : duplicateResolutions[conflict.id]
    if (!keepPath) continue
    skippedPaths.add(keepPath === conflict.keepPath ? conflict.duplicatePath : conflict.keepPath)
  }
  return profile.files.filter((file) => !skippedPaths.has(relativeName(file)))
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
    {
      value: "ready",
      label: "Pronto para treino",
      detail: "Importa como aprovado e disponível",
    },
  ]

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <p className="mb-2 text-sm font-medium text-foreground">Destino das anotações importadas</p>
      <div className="grid gap-2 sm:grid-cols-3">
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
        <CompactSummaryTile label="Anotações" value={profileAnnotationCount(profile).toLocaleString("pt-BR")} />
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
  let effectiveFiles = files
  let images = files.filter(isImageFile)
  const annotationCandidates = files.filter(isAnnotationFile)
  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  const warnings: string[] = []
  const blockingIssues: string[] = []
  let duplicateConflicts: DuplicateConflict[] = []
  const classNames = new Set<string>()
  const classCounts = new Map<string, number>()
  const yoloClassIds = new Map<number, number>()
  let annotationFileCount = 0
  let annotationCount = 0
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
        annotationCount += parseCocoAnnotationCount(text)
      }
    } else if (name.endsWith(".xml")) {
      const labels = parseCvatXmlLabels(text)
      if (labels.length > 0) {
        for (const label of labels) classNames.add(label)
        detectedFormat = "CVAT XML"
        annotationFileCount += 1
        annotationCount += parseCvatXmlAnnotationCount(text)
      }
    } else if (name.endsWith(".txt")) {
      const ids = parseYoloLabelIds(text)
      if (ids.length > 0 || isYoloLabelPath(name)) {
        annotationFileCount += 1
        annotationCount += ids.length
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
  if (classNames.size === 0 && yoloClassIds.size === 0) {
    const directoryClasses = directoryClassCounts(images)
    if (directoryClasses.size >= 2) {
      detectedFormat = "Classificação por pastas"
      const duplicateReview = await reviewDirectoryDuplicates(files, images)
      for (const [name, count] of directoryClasses) {
        const skipped = duplicateReview.skippedByClass.get(name.toLocaleLowerCase("pt-BR")) ?? 0
        const importableCount = Math.max(0, count - skipped)
        classNames.add(name)
        classCounts.set(name, importableCount)
        annotationCount += importableCount
      }
      effectiveFiles = duplicateReview.files
      images = duplicateReview.images
      totalBytes = effectiveFiles.reduce((total, file) => total + file.size, 0)
      if (duplicateReview.conflicts.length > 0) {
        duplicateConflicts = duplicateReview.conflicts
      }
    }
  }
  for (const name of classNames) {
    if (!classCounts.has(name)) classCounts.set(name, 0)
  }
  if (annotationCandidates.length > totalToRead) {
    warnings.push(`Amostramos ${totalToRead.toLocaleString("pt-BR")} arquivos de anotação para detectar classes.`)
  }

  return {
    sourceFiles: files,
    sourceImages: files.filter(isImageFile),
    files: effectiveFiles,
    images,
    totalBytes,
    format: detectedFormat,
    annotationFiles: annotationFileCount,
    annotationCount,
    classes: Array.from(classCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    warnings,
    blockingIssues,
    duplicateConflicts,
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

function parseCocoAnnotationCount(text: string) {
  try {
    const parsed = JSON.parse(text) as { annotations?: unknown }
    return Array.isArray(parsed.annotations) ? parsed.annotations.length : 0
  } catch {
    return 0
  }
}

function parseCvatXmlLabels(text: string) {
  return Array.from(text.matchAll(/<label>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/label>/g))
    .map((match) => cleanLabelName(match[1]))
    .filter(Boolean)
}

function parseCvatXmlAnnotationCount(text: string) {
  return Array.from(text.matchAll(/<(?:box|polygon|polyline|points|ellipse|cuboid|tag)\b/g)).length
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

function directoryClassCounts(images: File[]) {
  const counts = new Map<string, number>()
  for (const image of images) {
    const className = directoryClassName(image)
    if (!className) continue
    counts.set(className, (counts.get(className) ?? 0) + 1)
  }
  return new Map(Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0], "pt-BR")))
}

function directoryClassName(file: File) {
  const segments = relativeName(file).split(/[\\/]/).filter(Boolean)
  const dirs = segments.slice(0, -1)
  if (dirs.length === 0) return null

  const splitIndex = dirs.findIndex((segment) => splitFolderNames.has(segment.toLocaleLowerCase("pt-BR")))
  if (splitIndex >= 0) {
    const afterSplit = dirs[splitIndex + 1]
    return afterSplit ? cleanLabelName(afterSplit) : null
  }

  if (dirs.length < 2) return null
  return cleanLabelName(dirs[dirs.length - 1]) || null
}

async function reviewDirectoryDuplicates(files: File[], images: File[]): Promise<DirectoryDuplicateReview> {
  const fallback: DirectoryDuplicateReview = {
    files,
    images,
    skippedByClass: new Map<string, number>(),
    skippedCount: 0,
    conflicts: [],
  }
  if (!globalThis.crypto?.subtle) return fallback

  const annotatedImages = images
    .map((file) => ({ file, path: relativeName(file), className: directoryClassName(file) }))
    .filter((item): item is { file: File; path: string; className: string } => Boolean(item.className))
    .sort((a, b) => a.path.localeCompare(b.path, "pt-BR"))

  const byHash = new Map<string, Array<{ file: File; path: string; className: string }>>()
  for (const item of annotatedImages) {
    const hash = await fileSha256(item.file)
    const group = byHash.get(hash) ?? []
    group.push(item)
    byHash.set(hash, group)
    if (group.length % 40 === 0) await nextFrame()
  }

  const skippedPaths = new Set<string>()
  const skippedByClass = new Map<string, number>()
  const conflicts: DuplicateConflict[] = []
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    const classes = new Set(group.map((item) => item.className.toLocaleLowerCase("pt-BR")))
    const first = group[0]
    if (classes.size > 1) {
      for (const item of group.slice(1)) {
        conflicts.push({
          id: `${first.path}::${item.path}`,
          keepPath: first.path,
          keepClass: first.className,
          keepPreviewUrl: URL.createObjectURL(first.file),
          duplicatePath: item.path,
          duplicateClass: item.className,
          duplicatePreviewUrl: URL.createObjectURL(item.file),
        })
      }
      continue
    }
    for (const item of group.slice(1)) {
      skippedPaths.add(item.path)
      const key = item.className.toLocaleLowerCase("pt-BR")
      skippedByClass.set(key, (skippedByClass.get(key) ?? 0) + 1)
    }
  }

  if (skippedPaths.size === 0) {
    return { ...fallback, conflicts }
  }

  return {
    files: files.filter((file) => !skippedPaths.has(relativeName(file))),
    images: images.filter((file) => !skippedPaths.has(relativeName(file))),
    skippedByClass,
    skippedCount: skippedPaths.size,
    conflicts,
  }
}

async function fileSha256(file: File) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
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
