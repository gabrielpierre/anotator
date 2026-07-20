"use client"

import * as React from "react"
import { X, FolderOpen, Check, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { createProject, updateProject, mockFallbackEnabled } from "@/lib/api/client"
import { useCurrentUser } from "@/lib/auth/user-context"
import type { BackendProject } from "@/lib/api/types"

const quotaPresets = [30, 40, 60, 100]

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name: string }>
}

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

  async function chooseFolder() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker
    if (picker) {
      const handle = await picker()
      setStoragePath((current) => current || handle.name)
      return
    }
    setError("Seu navegador não expõe o caminho da pasta. Informe o caminho manualmente.")
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const resolvedQuota = Number(customQuota || quotaGb)
    if (!name.trim() || !Number.isFinite(resolvedQuota) || resolvedQuota <= 0) {
      setError("Preencha o nome e um limite de storage válido.")
      return
    }
    if (!isEdit && !storagePath.trim()) {
      setError("Informe a pasta onde o dataset será armazenado.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit && project) {
        try {
          const updated = await updateProject(project.id, {
            name: name.trim(),
            storage_quota_gb: Math.round(resolvedQuota),
          })
          onSaved(updated, "edit", annotatorIds)
        } catch (err) {
          // Sem backend disponível: aplica a edição localmente no modo demonstração.
          if (!mockFallbackEnabled()) throw err
          onSaved(synthesizeProject(project, name.trim(), Math.round(resolvedQuota)), "edit", annotatorIds)
        }
      } else {
        const created = await createProject({
          name: name.trim(),
          storage_path: storagePath.trim(),
          storage_quota_gb: Math.round(resolvedQuota),
          warn_at_percent: 85,
        })
        onSaved(created, "create", annotatorIds)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar o projeto.")
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
                ? "Atualize o nome do projeto e o limite de memória reservada."
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
              placeholder="Ex.: Veículos - Rodovia 2026"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Pasta do projeto</span>
            <div className="flex gap-2">
              <input
                value={storagePath}
                onChange={(event) => setStoragePath(event.target.value)}
                placeholder="Ex.: D:\\datasets\\rodovia-2026"
                disabled={isEdit}
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              />
              {!isEdit && (
                <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
                  <FolderOpen className="size-4" />
                  Escolher
                </Button>
              )}
            </div>
            {isEdit && (
              <span className="text-xs text-muted-foreground">A pasta do projeto não pode ser alterada após a criação.</span>
            )}
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Limite de memória</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                  }`}
                >
                  {value} GB
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input
                value={customQuota}
                onChange={(event) => setCustomQuota(event.target.value)}
                inputMode="numeric"
                placeholder="Outro valor"
                className="h-10 w-36 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
              />
              <span className="text-sm text-muted-foreground">GB</span>
            </label>
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
    </div>
  )
}

function synthesizeProject(target: ProjectDialogTarget, name: string, quotaGb: number): BackendProject {
  const now = new Date().toISOString()
  return {
    id: target.id,
    external_id: target.id,
    name,
    status: "active",
    raw: {
      source: "local",
      storage: {
        path: target.storagePath,
        quota_gb: quotaGb,
        quota_bytes: quotaGb * 1024 ** 3,
        used_bytes: 0,
        used_gb: 0,
        warn_at_percent: 85,
        enforce_quota: true,
      },
    },
    created_at: now,
    updated_at: now,
  }
}
