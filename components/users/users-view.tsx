"use client"

import * as React from "react"
import { Plus, Users, ShieldCheck, PenLine, X, Trash2, FolderKanban } from "lucide-react"
import { Card } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader } from "@/components/app/primitives"
import { AdminOnly } from "@/components/app/admin-only"
import {
  useCurrentUser,
  roleLabels,
  type UserRole,
  type AppUser,
  type NewUserInput,
  type ProjectRecord,
} from "@/lib/auth/user-context"

const roleTone: Record<UserRole, string> = {
  admin: "bg-surface-purple text-brand-lavender",
  anotador: "bg-surface-blue text-brand-blue",
}

export function UsersView() {
  const {
    users,
    addUser,
    removeUser,
    currentUser,
    projects,
    assignUserToProject,
    removeUserFromProject,
  } = useCurrentUser()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [pendingRemoval, setPendingRemoval] = React.useState<AppUser | null>(null)

  const adminCount = users.filter((user) => user.role === "admin").length
  const annotatorCount = users.filter((user) => user.role === "anotador").length

  function canRemove(user: AppUser) {
    if (user.id === currentUser.id) return false
    if (user.role === "admin" && adminCount <= 1) return false
    return true
  }

  return (
    <AdminOnly>
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <PageHeader
          title="Usuários"
          subtitle="Gerencie quem tem acesso ao sistema, associe anotadores a projetos e crie novos membros."
          actions={
            <Button size="lg" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              Novo usuário
            </Button>
          }
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard label="Usuários" value={String(users.length)} hint="no total" tone="blue" />
          <MetricCard label="Administradores" value={String(adminCount)} hint="com acesso total" tone="purple" />
          <MetricCard label="Anotadores" value={String(annotatorCount)} hint="acesso à anotação" tone="mint" />
        </div>

        <Card className="p-0">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold text-foreground">Equipe</h2>
          </div>
          <ul className="divide-y divide-border">
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isCurrent={user.id === currentUser.id}
                canRemove={canRemove(user)}
                projects={projects}
                onAssign={(projectId) => assignUserToProject(projectId, user.id)}
                onUnassign={(projectId) => removeUserFromProject(projectId, user.id)}
                onRemove={() => setPendingRemoval(user)}
              />
            ))}
          </ul>
        </Card>
      </div>

      <NewUserDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreate={addUser} />

      <ConfirmRemoveDialog
        user={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => {
          if (pendingRemoval) removeUser(pendingRemoval.id)
          setPendingRemoval(null)
        }}
      />
    </AdminOnly>
  )
}

function UserRow({
  user,
  isCurrent,
  canRemove,
  projects,
  onAssign,
  onUnassign,
  onRemove,
}: {
  user: AppUser
  isCurrent: boolean
  canRemove: boolean
  projects: ProjectRecord[]
  onAssign: (projectId: string) => void
  onUnassign: (projectId: string) => void
  onRemove: () => void
}) {
  const isAnnotator = user.role === "anotador"
  const memberProjects = projects.filter((project) => project.annotatorIds.includes(user.id))
  const availableProjects = projects.filter((project) => !project.annotatorIds.includes(user.id))

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-4">
        <Avatar name={user.name} src={user.avatar} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
            {user.name}
            {isCurrent && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                você
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${roleTone[user.role]}`}
        >
          {user.role === "admin" ? <ShieldCheck className="size-3.5" /> : <PenLine className="size-3.5" />}
          {roleLabels[user.role]}
        </span>
        <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground lg:block">
          {user.createdAt}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remover ${user.name}`}
          title={
            canRemove
              ? `Remover ${user.name}`
              : isCurrent
                ? "Você não pode remover a si mesmo"
                : "Não é possível remover o único administrador"
          }
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-[3.5rem]">
        {!isAnnotator ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderKanban className="size-3.5" />
            Administrador tem acesso a todos os projetos
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FolderKanban className="size-3.5" />
              Projetos:
            </span>
            {memberProjects.length === 0 && (
              <span className="text-xs text-muted-foreground">Nenhum projeto associado</span>
            )}
            {memberProjects.map((project) => (
              <span
                key={project.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-blue py-0.5 pl-2.5 pr-1 text-xs font-medium text-brand-blue"
              >
                {project.name}
                <button
                  type="button"
                  onClick={() => onUnassign(project.id)}
                  aria-label={`Remover ${user.name} de ${project.name}`}
                  className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-brand-blue/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <AddToProjectMenu
              projects={availableProjects}
              onSelect={onAssign}
              label={`Adicionar ${user.name} a um projeto`}
            />
          </>
        )}
      </div>
    </li>
  )
}

function AddToProjectMenu({
  projects,
  onSelect,
  label,
}: {
  projects: ProjectRecord[]
  onSelect: (projectId: string) => void
  label: string
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-brand-blue hover:text-brand-blue"
      >
        <Plus className="size-3" />
        Adicionar a projeto
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          {projects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Já está em todos os projetos.</p>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(project.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                <FolderKanban className="size-4 shrink-0 text-brand-blue" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ConfirmRemoveDialog({
  user,
  onClose,
  onConfirm,
}: {
  user: AppUser | null
  onClose: () => void
  onConfirm: () => void
}) {
  React.useEffect(() => {
    if (!user) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [user, onClose])

  if (!user) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Remover usuário"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex flex-col gap-3 p-5">
          <span className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <Trash2 className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-foreground">Remover usuário</h2>
            <p className="text-sm text-muted-foreground text-pretty">
              Tem certeza que deseja remover <span className="font-medium text-foreground">{user.name}</span> do
              sistema? Ele será desassociado de todos os projetos. Esta ação não pode ser desfeita.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            <Trash2 className="size-4" />
            Remover
          </Button>
        </div>
      </div>
    </div>
  )
}

function NewUserDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (input: NewUserInput) => Promise<AppUser>
}) {
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [role, setRole] = React.useState<UserRole>("anotador")
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setEmail("")
    setPassword("")
    setRole("anotador")
    setError(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const emailOk = /.+@.+\..+/.test(email.trim())
    const initialPassword = password.trim()
    if (!name.trim()) {
      setError("Informe o nome do usuário.")
      return
    }
    if (!emailOk) {
      setError("Informe um e-mail válido.")
      return
    }
    if (initialPassword.length < 6) {
      setError("A senha deve ter ao menos 6 caracteres.")
      return
    }
    setSaving(true)
    try {
      await onCreate({ name: name.trim(), email: email.trim(), password: initialPassword, role })
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : "Não foi possível criar o usuário.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Novo usuário"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <form
        onSubmit={submit}
        className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Novo usuário</h2>
            <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
              Defina o acesso do novo membro da equipe.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
              placeholder="Ex.: Ana Ribeiro"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">E-mail</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              placeholder="Ex.: ana@cvat.plus"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Senha inicial</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={6}
              autoComplete="new-password"
              placeholder="Mínimo de 6 caracteres"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Perfil de acesso</span>
            <div className="grid grid-cols-2 gap-2">
              {(["anotador", "admin"] as UserRole[]).map((value) => {
                const active = role === value
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRole(value)}
                    className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      active ? "border-brand-blue bg-surface-blue" : "border-border hover:bg-muted"
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {value === "admin" ? <ShieldCheck className="size-4" /> : <PenLine className="size-4" />}
                      {roleLabels[value]}
                    </span>
                    <span className="text-xs text-muted-foreground text-pretty">
                      {value === "admin" ? "Gerencia projetos, memória e usuários." : "Acessa apenas a anotação."}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            <Users className="size-4" />
            {saving ? "Criando..." : "Criar usuário"}
          </Button>
        </div>
      </form>
    </div>
  )
}
