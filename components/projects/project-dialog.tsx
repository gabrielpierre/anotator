"use client"

import * as React from "react"
import { X, FolderOpen, Check, Users, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { apiBaseUrl, createProject, fetchDirectories, updateProject } from "@/lib/api/client"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendDirectoryListing, BackendProject } from "@/lib/api/types"

const quotaPresets = [30, 40, 60, 100]

export type ProjectDialogTarget = {
  id: string
  name: string
  storagePath: string
  quotaGb: number
  annotatorIds?: string[]
}

export function ProjectDialog({
  open,
  mode,
  project,
  onClose,
  onSaved,
}: {
  open: boolean
  mode: "create" | "edit"
  project?: ProjectDialogTarget | null
  onClose: () => void
  onSaved: (project: BackendProject, mode: "create" | "edit", annotatorIds: string[]) => void
}) {
  const isEdit = mode === "edit"
  const { annotators } = useCurrentUser()
  const [name, setName] = React.useState("")
  const [storagePath, setStoragePath] = React.useState("")
  const [quotaGb, setQuotaGb] = React.useState(40)
  const [customQuota, setCustomQuota] = React.useState("")
  const [annotatorIds, setAnnotatorIds] = React.useState<string[]>([])
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pathNotice, setPathNotice] = React.useState<string | null>(null)
  const [directoryPickerOpen, setDirectoryPickerOpen] = React.useState(false)
  const [directoryListing, setDirectoryListing] = React.useState<BackendDirectoryListing | null>(null)
  const [directoryLoading, setDirectoryLoading] = React.useState(false)
  const [directoryError, setDirectoryError] = React.useState<string | null>(null)

  // Sincroniza os campos ao abrir (ou ao trocar o projeto em edição).
  React.useEffect(() => {
    if (!open) return
    if (isEdit && project) {
      setName(project.name)
      setStoragePath(project.storagePath)
      const preset = quotaPresets.includes(project.quotaGb)
      setQuotaGb(preset ? project.quotaGb : 40)
      setCustomQuota(preset ? "" : String(project.quotaGb))
      setAnnotatorIds(project.annotatorIds ?? [])
    } else {
      setName("")
      setStoragePath("")
      setQuotaGb(40)
      setCustomQuota("")
      setAnnotatorIds([])
    }
    setError(null)
    setPathNotice(null)
  }, [open, isEdit, project])

  function toggleAnnotator(id: string) {
    setAnnotatorIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  async function loadDirectories(path?: string, opts: { fallbackToHome?: boolean } = {}) {
    setDirectoryLoading(true)
    setDirectoryError(null)
    try {
      const listing = await fetchDirectories(path)
      setDirectoryListing(listing)
    } catch (err) {
      if (opts.fallbackToHome) {
        try {
          const listing = await fetchDirectories()
          setDirectoryListing(listing)
          setDirectoryError("A pasta informada não foi encontrada. Mostrando a pasta inicial.")
        } catch (fallbackErr) {
          setDirectoryError(directoryPickerErrorMessage(fallbackErr))
        }
      } else {
        setDirectoryError(directoryPickerErrorMessage(err))
      }
    } finally {
      setDirectoryLoading(false)
    }
  }

  async function chooseFolder() {
    const normalizedPath = normalizeStoragePath(storagePath)
    const startPath = isAbsoluteStoragePath(normalizedPath) ? normalizedPath : undefined
    setError(null)
    setPathNotice(null)
    setDirectoryPickerOpen(true)
    await loadDirectories(startPath, { fallbackToHome: Boolean(startPath) })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const resolvedQuota = Number(customQuota || quotaGb)
    const resolvedPath = normalizeStoragePath(storagePath)
    if (!name.trim() || !Number.isFinite(resolvedQuota) || resolvedQuota <= 0) {
      setError("Preencha o nome e um limite de storage válido.")
      return
    }
    if (!resolvedPath) {
      setError("Informe a pasta onde o dataset será armazenado.")
      return
    }
    if (!isAbsoluteStoragePath(resolvedPath)) {
      setError("Informe um caminho absoluto, por exemplo /home/gabriel/datasets/coco128 ou D:/datasets/coco128.")
      return
    }
    if (resolvedPath !== storagePath) setStoragePath(resolvedPath)
    setSaving(true)
    setError(null)
    setPathNotice(null)
    try {
      if (isEdit && project) {
        const updated = await updateProject(project.id, {
          name: name.trim(),
          storage_path: resolvedPath,
          storage_quota_gb: Math.round(resolvedQuota),
        })
        onSaved(updated, "edit", annotatorIds)
      } else {
        const created = await createProject({
          name: name.trim(),
          storage_path: resolvedPath,
          storage_quota_gb: Math.round(resolvedQuota),
          warn_at_percent: 85,
        })
        onSaved(created, "create", annotatorIds)
      }
      onClose()
    } catch (err) {
      setError(projectSaveErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "Editar projeto" : "Novo projeto"}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form onSubmit={submit} className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{isEdit ? "Editar projeto" : "Novo projeto"}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
              {isEdit
                ? "Atualize a pasta do projeto e o limite de memória reservada."
                : "Defina onde o dataset será armazenado e o limite máximo de crescimento."}
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
            <span className="text-sm font-medium text-foreground">Nome</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Projeto 2026"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Pasta do projeto</span>
            <div className="flex gap-2">
              <input
                value={storagePath}
                onChange={(event) => {
                  setStoragePath(event.target.value)
                  setError(null)
                  setPathNotice(null)
                }}
                onBlur={() => setStoragePath((current) => normalizeStoragePath(current))}
                placeholder="Ex.: /home/gabriel/datasets/projeto-2026"
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void chooseFolder()}
                className="h-10 w-12 shrink-0 px-0"
                aria-label="Escolher pasta"
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Limite de memória</span>
            <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-1">
              {quotaPresets.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setQuotaGb(value)
                    setCustomQuota("")
                  }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    !customQuota && quotaGb === value
                      ? "border-brand-blue bg-surface-blue text-brand-blue"
                      : "border-border hover:bg-muted"
                  } h-10 min-w-20 shrink-0`}
                >
                  {value} GB
                </button>
              ))}
              <label className="flex shrink-0 items-center gap-2">
                <input
                  value={customQuota}
                  onChange={(event) => setCustomQuota(event.target.value)}
                  inputMode="numeric"
                  placeholder="Outro valor"
                  className="h-10 w-32 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
                />
                <span className="text-sm text-muted-foreground">GB</span>
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Users className="size-4" />
              Anotadores
            </span>
            {annotators.length === 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                Nenhum anotador cadastrado ainda. Crie usuários na página Usuários.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {annotators.map((annotator) => {
                  const selected = annotatorIds.includes(annotator.id)
                  return (
                    <button
                      key={annotator.id}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      onClick={() => toggleAnnotator(annotator.id)}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted"
                      }`}
                    >
                      <Avatar name={annotator.name} src={annotator.avatar} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-sm font-medium text-foreground">{annotator.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{annotator.email}</span>
                      </span>
                      <span
                        className={`flex size-5 items-center justify-center rounded-md border ${
                          selected ? "border-brand-blue bg-brand-blue text-white" : "border-border"
                        }`}
                      >
                        {selected && <Check className="size-3.5" />}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {pathNotice && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{pathNotice}</p>}
          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Salvando..." : isEdit ? "Salvar alterações" : "Criar projeto"}
          </Button>
        </div>
      </form>

      {directoryPickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Escolher pasta do projeto"
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        >
          <button
            type="button"
            aria-label="Fechar seletor de pasta"
            onClick={() => setDirectoryPickerOpen(false)}
            className="absolute inset-0 bg-black/45"
          />
          <div className="relative z-10 flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-foreground">Escolher pasta</h3>
                <p className="mt-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                  {directoryListing?.path ?? "Carregando..."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDirectoryPickerOpen(false)}
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Fechar seletor de pasta"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-border p-3">
              <Button
                type="button"
                variant="outline"
                disabled={!directoryListing?.parent || directoryLoading}
                onClick={() => directoryListing?.parent && void loadDirectories(directoryListing.parent)}
              >
                Subir
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={directoryLoading}
                onClick={() => void loadDirectories(directoryListing?.path)}
              >
                Atualizar
              </Button>
              <Button
                type="button"
                className="ml-auto"
                disabled={!directoryListing || directoryLoading}
                onClick={() => {
                  if (!directoryListing) return
                  setStoragePath(directoryListing.path)
                  setPathNotice(null)
                  setError(null)
                  setDirectoryPickerOpen(false)
                }}
              >
                <FolderOpen className="size-4" />
                Usar esta pasta
              </Button>
            </div>

            <div className="max-h-80 overflow-y-auto p-3">
              {directoryLoading && <p className="px-2 py-6 text-center text-sm text-muted-foreground">Carregando pastas...</p>}
              {directoryError && <p className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{directoryError}</p>}
              {!directoryLoading && directoryListing?.entries.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">Esta pasta não possui subpastas.</p>
              )}
              {!directoryLoading && directoryListing && (
                <ul className="flex flex-col gap-1">
                  {directoryListing.entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        onClick={() => void loadDirectories(entry.path)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground hover:bg-muted"
                      >
                        <FolderOpen className="size-4 shrink-0 text-brand-blue" />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeStoragePath(path: string) {
  const trimmed = path.trim()
  const drivePath = trimmed.match(/^\/([A-Za-z]):[\\/]*(.*)$/)
  if (drivePath) return `${drivePath[1]}:/${drivePath[2].replace(/^[\\/]+/, "")}`
  if (/^home\//.test(trimmed)) return `/${trimmed}`
  return trimmed
}

function isAbsoluteStoragePath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
}

function projectSaveErrorMessage(err: unknown) {
  if (err instanceof TypeError) {
    return `Não foi possível conectar ao backend em ${apiBaseUrl()}. Inicie o backend e tente novamente.`
  }
  if (err instanceof Error) return err.message
  return "Erro ao salvar o projeto."
}

function directoryPickerErrorMessage(err: unknown) {
  if (err instanceof TypeError) {
    return `Não foi possível carregar as pastas pelo backend em ${apiBaseUrl()}.`
  }
  if (err instanceof Error) return err.message
  return "Não foi possível carregar as pastas."
}
