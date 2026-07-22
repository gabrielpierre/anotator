"use client"

import * as React from "react"
import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, Upload, UserRound, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createImportTask, uploadImportTaskFilesWithProgress } from "@/lib/api/client"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendImportJob } from "@/lib/api/types"

type UploadPhase = "idle" | "creating" | "preparing" | "uploading" | "processing"

export function ImportBatchDialog({
  open,
  projectId,
  onClose,
  onImported,
}: {
  open: boolean
  projectId?: string | null
  onClose: () => void
  onImported?: (job: BackendImportJob) => void
}) {
  const [name, setName] = React.useState(defaultBatchName)
  const [files, setFiles] = React.useState<File[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<BackendImportJob | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [uploadProgress, setUploadProgress] = React.useState({ loaded: 0, total: 0, percent: 0 })
  const [uploadPhase, setUploadPhase] = React.useState<UploadPhase>("idle")
  const [optimisticUploadPercent, setOptimisticUploadPercent] = React.useState(0)
  const [selectingFiles, setSelectingFiles] = React.useState(false)
  const [fileLoadProgress, setFileLoadProgress] = React.useState({ loaded: 0, total: 0, percent: 0 })
  const [assigneeUserId, setAssigneeUserId] = React.useState("")
  const fileSelectionToken = React.useRef(0)
  const { currentUser, isAdmin, annotators } = useCurrentUser()

  React.useEffect(() => {
    if (!open) return
    setName(defaultBatchName())
    setFiles([])
    setError(null)
    setResult(null)
    setAssigneeUserId("")
    setUploadProgress({ loaded: 0, total: 0, percent: 0 })
    setUploadPhase("idle")
    setOptimisticUploadPercent(0)
    setFileLoadProgress({ loaded: 0, total: 0, percent: 0 })
    setSelectingFiles(false)
    fileSelectionToken.current += 1
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  const uploadFinished = submitting && uploadProgress.percent >= 100
  const duplicateNames = React.useMemo(() => duplicateFileNames(files), [files])
  const hasDuplicateNames = duplicateNames.length > 0
  const progressVisible = files.length > 0 || selectingFiles || submitting
  const activeUploadPercent = Math.max(uploadProgress.percent, optimisticUploadPercent)
  const progressPercent = submitting
    ? activeUploadPercent
    : selectingFiles
      ? fileLoadProgress.percent
      : files.length > 0
        ? 100
        : 0
  const progressTitle = submitting
    ? uploadPhaseTitle(uploadPhase, uploadFinished)
    : selectingFiles
      ? "Carregando imagens..."
      : "Arquivos prontos"

  React.useEffect(() => {
    if (!submitting || uploadFinished || uploadPhase === "idle" || uploadPhase === "processing") return
    const ceiling = uploadPhase === "creating" ? 6 : uploadPhase === "preparing" ? 12 : 92
    const step = uploadPhase === "uploading" ? 3 : 1
    const interval = window.setInterval(() => {
      setOptimisticUploadPercent((current) => Math.min(ceiling, Math.max(current, uploadProgress.percent) + step))
    }, 450)
    return () => window.clearInterval(interval)
  }, [submitting, uploadFinished, uploadPhase, uploadProgress.percent])

  const handleFileSelection = React.useCallback(async (fileList: FileList | null) => {
    const totalFiles = fileList?.length ?? 0
    const token = fileSelectionToken.current + 1
    fileSelectionToken.current = token
    setError(null)
    setResult(null)
    setFiles([])
    setSelectingFiles(totalFiles > 0)
    setFileLoadProgress({
      loaded: 0,
      total: totalFiles,
      percent: totalFiles > 0 ? 1 : 100,
    })
    await nextFrame()

    if (totalFiles === 0) {
      setSelectingFiles(false)
      return
    }

    const nextFiles: File[] = []
    const chunkSize = 128
    for (let index = 0; index < totalFiles; index += chunkSize) {
      if (fileSelectionToken.current !== token) return
      const end = Math.min(totalFiles, index + chunkSize)
      for (let fileIndex = index; fileIndex < end; fileIndex += 1) {
        const file = fileList?.item(fileIndex)
        if (file) nextFiles.push(file)
      }
      setFileLoadProgress({
        loaded: end,
        total: totalFiles,
        percent: Math.max(1, Math.round((end / totalFiles) * 100)),
      })
      await nextFrame()
    }
    if (fileSelectionToken.current === token) {
      setFiles(nextFiles)
      setSelectingFiles(false)
    }
  }, [])

  if (!open) return null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError("Informe o nome do lote.")
      return
    }
    if (files.length === 0) {
      setError("Selecione pelo menos uma imagem.")
      return
    }
    if (hasDuplicateNames) {
      setError("Remova os arquivos com nomes repetidos antes de subir o lote.")
      return
    }
    setSubmitting(true)
    setError(null)
    setResult(null)
    setUploadPhase("creating")
    setOptimisticUploadPercent(1)
    setUploadProgress({ loaded: 0, total: totalBytes, percent: 0 })
    try {
      await nextFrame()
      const assigneeId = isAdmin ? assigneeUserId || null : currentUser.role === "anotador" ? currentUser.id || null : null
      const created = await createImportTask({
        project_id: projectId || null,
        name: name.trim(),
        assignee_user_id: assigneeId,
        estimated_bytes: totalBytes,
        sync_after_import: true,
      })
      setUploadPhase("preparing")
      setOptimisticUploadPercent((current) => Math.max(current, 8))
      await nextFrame()
      const uploaded = await uploadImportTaskFilesWithProgress(created.job.id, files, (progress) => {
        setUploadPhase(progress.percent >= 100 ? "processing" : "uploading")
        setOptimisticUploadPercent((current) => Math.max(current, progress.percent))
        setUploadProgress(progress)
      })
      setUploadPhase("processing")
      setOptimisticUploadPercent(100)
      setResult(uploaded)
      onImported?.(uploaded)
    } catch (err) {
      setUploadPhase("idle")
      setOptimisticUploadPercent(0)
      setError(err instanceof Error ? err.message : "Não foi possível importar o lote.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Importar lote de imagens"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form
        onSubmit={submit}
        className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Importar lote de imagens</h2>
            <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
              Envie imagens para criar uma task de importação e sincronizar o CVAT.
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

        <div className="flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Nome do lote</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Lote 2026-07-20"
              disabled={submitting || Boolean(result)}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            />
          </label>

          {isAdmin && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Anotador responsável</span>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <select
                  value={assigneeUserId}
                  onChange={(event) => setAssigneeUserId(event.target.value)}
                  disabled={submitting || Boolean(result) || annotators.length === 0}
                  className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-10 pr-3 text-sm outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                >
                  <option value="">
                    {annotators.length > 0 ? "Definir depois" : "Nenhum anotador ativo"}
                  </option>
                  {annotators.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          )}
          {!isAdmin && currentUser.role === "anotador" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Anotador responsável</span>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={currentUser.name}
                  readOnly
                  disabled
                  className="h-10 w-full rounded-lg border border-border bg-muted pl-10 pr-3 text-sm text-muted-foreground"
                />
              </div>
            </label>
          )}

          <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/35 p-5 text-center transition-colors hover:bg-muted/55">
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
              <ImagePlus className="size-5" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {selectingFiles
                ? `${fileLoadProgress.loaded.toLocaleString("pt-BR")} / ${fileLoadProgress.total.toLocaleString("pt-BR")} imagens`
                : files.length > 0
                  ? `${files.length.toLocaleString("pt-BR")} imagens selecionadas`
                  : "Selecionar imagens"}
            </span>
            <span className="text-xs text-muted-foreground">
              JPG, PNG, WEBP ou outros formatos aceitos pelo CVAT.
            </span>
            <input
              type="file"
              multiple
              accept="image/*"
              disabled={submitting || selectingFiles || Boolean(result)}
              onChange={(event) => {
                const input = event.currentTarget
                void handleFileSelection(input.files).finally(() => {
                  input.value = ""
                })
              }}
              className="sr-only"
            />
          </label>

          {progressVisible && (
            <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-medium text-foreground">{progressTitle}</span>
                  {" - "}
                  {selectingFiles
                    ? `${fileLoadProgress.loaded.toLocaleString("pt-BR")} de ${fileLoadProgress.total.toLocaleString("pt-BR")} arquivos`
                    : `${formatBytes(totalBytes)} em ${files.length} arquivos`}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-foreground">
                  {Math.max(0, Math.min(100, progressPercent))}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-brand-blue transition-[width] duration-200"
                  style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                />
              </div>
              {submitting && (
                  <div className="flex items-center justify-between gap-3">
                    <span>{uploadDetail(uploadPhase, uploadProgress, totalBytes)}</span>
                    <span>{uploadFinished ? "Aguarde" : uploadRemainder(uploadPhase, uploadProgress, totalBytes)}</span>
                  </div>
              )}
            </div>
          )}
          {hasDuplicateNames && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Arquivos com nomes repetidos</p>
                <p className="mt-0.5 text-xs text-amber-700">
                  Renomeie ou remova: {formatDuplicateNames(duplicateNames)}.
                </p>
              </div>
            </div>
          )}
          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {result && (
            <div className="flex items-start gap-3 rounded-lg bg-brand-green/10 px-3 py-2 text-sm text-brand-green">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>Job {result.job.id.slice(0, 8)} criado. Acompanhe o processamento em Jobs.</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {result ? "Fechar" : "Cancelar"}
          </Button>
          {!result && (
            <Button type="submit" disabled={submitting || selectingFiles || hasDuplicateNames}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {selectingFiles ? "Carregando..." : uploadFinished ? "Finalizando..." : submitting ? "Enviando..." : "Subir lote"}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function defaultBatchName() {
  const date = new Date()
  return `Lote ${date.toLocaleDateString("pt-BR")}`
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

function uploadPhaseTitle(phase: UploadPhase, uploadFinished: boolean) {
  if (uploadFinished || phase === "processing") return "Finalizando..."
  if (phase === "creating") return "Criando job de importação..."
  if (phase === "preparing") return "Preparando upload..."
  return "Enviando imagens..."
}

function uploadDetail(
  phase: UploadPhase,
  progress: { loaded: number; total: number; percent: number },
  fallbackTotal: number,
) {
  if (phase === "creating") return "Abrindo importação no backend"
  if (phase === "preparing") return "Montando pacote de envio"
  const total = progress.total || fallbackTotal
  if (progress.loaded > 0 && total > 0) {
    return `${formatBytes(Math.min(progress.loaded, total))} de ${formatBytes(total)} enviados`
  }
  return "Iniciando conexão de upload"
}

function uploadRemainder(
  phase: UploadPhase,
  progress: { loaded: number; total: number; percent: number },
  fallbackTotal: number,
) {
  if (phase === "creating" || phase === "preparing") return "Aguarde"
  const total = progress.total || fallbackTotal
  if (progress.loaded > 0 && total > 0) {
    return `${formatBytes(Math.max(total - progress.loaded, 0))} restantes`
  }
  return "Calculando"
}

function duplicateFileNames(files: File[]) {
  const counts = new Map<string, { name: string; count: number }>()
  for (const file of files) {
    const name = file.name.trim() || "upload.bin"
    const key = name.toLocaleLowerCase("pt-BR")
    const current = counts.get(key)
    counts.set(key, { name: current?.name ?? name, count: (current?.count ?? 0) + 1 })
  }
  return Array.from(counts.values())
    .filter((entry) => entry.count > 1)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
}

function formatDuplicateNames(duplicates: Array<{ name: string; count: number }>) {
  const visible = duplicates.slice(0, 4).map((entry) => `${entry.name} (${entry.count}x)`)
  const hidden = duplicates.length - visible.length
  return hidden > 0 ? `${visible.join(", ")} e mais ${hidden}` : visible.join(", ")
}
