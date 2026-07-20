"use client"

import * as React from "react"
import { CheckCircle2, ImagePlus, Loader2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createImportTask, uploadImportTaskFiles } from "@/lib/api/client"
import type { BackendImportJob } from "@/lib/api/types"

export function ImportBatchDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported?: (job: BackendImportJob) => void
}) {
  const [name, setName] = React.useState(defaultBatchName)
  const [files, setFiles] = React.useState<File[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<BackendImportJob | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName(defaultBatchName())
    setFiles([])
    setError(null)
    setResult(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  const totalBytes = files.reduce((total, file) => total + file.size, 0)

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
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const created = await createImportTask({
        name: name.trim(),
        estimated_bytes: totalBytes,
        sync_after_import: true,
      })
      const uploaded = await uploadImportTaskFiles(created.job.id, files)
      setResult(uploaded)
      onImported?.(uploaded)
    } catch (err) {
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

          <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/35 p-5 text-center transition-colors hover:bg-muted/55">
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface-blue text-brand-blue">
              <ImagePlus className="size-5" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {files.length > 0 ? `${files.length} imagens selecionadas` : "Selecionar imagens"}
            </span>
            <span className="text-xs text-muted-foreground">
              JPG, PNG, WEBP ou outros formatos aceitos pelo CVAT.
            </span>
            <input
              type="file"
              multiple
              accept="image/*"
              disabled={submitting || Boolean(result)}
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []))
                setError(null)
              }}
              className="sr-only"
            />
          </label>

          {files.length > 0 && (
            <div className="rounded-lg bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{formatBytes(totalBytes)}</span> em {files.length} arquivos
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
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {submitting ? "Enviando..." : "Subir lote"}
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
