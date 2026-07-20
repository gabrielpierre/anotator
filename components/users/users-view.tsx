"use client"

import * as React from "react"
import { Plus, Users, ShieldCheck, PenLine, X } from "lucide-react"
import { Card, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { MetricCard } from "@/components/snowui/metric-card"
import { PageHeader } from "@/components/app/primitives"
import { AdminOnly } from "@/components/app/admin-only"
import { useCurrentUser, roleLabels, type UserRole } from "@/lib/auth/user-context"

const roleTone: Record<UserRole, string> = {
  admin: "bg-surface-purple text-brand-lavender",
  anotador: "bg-surface-blue text-brand-blue",
}

export function UsersView() {
  const { users, addUser } = useCurrentUser()
  const [dialogOpen, setDialogOpen] = React.useState(false)

  const adminCount = users.filter((user) => user.role === "admin").length
  const annotatorCount = users.filter((user) => user.role === "anotador").length

  return (
    <AdminOnly>
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <PageHeader
          title="Usuários"
          subtitle="Gerencie quem tem acesso ao sistema e crie novos administradores e anotadores."
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
              <li key={user.id} className="flex items-center gap-4 px-5 py-3">
                <Avatar name={user.name} src={user.avatar} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${roleTone[user.role]}`}
                >
                  {user.role === "admin" ? <ShieldCheck className="size-3.5" /> : <PenLine className="size-3.5" />}
                  {roleLabels[user.role]}
                </span>
                <span className="hidden w-32 shrink-0 text-right text-xs text-muted-foreground sm:block">
                  {user.createdAt}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <NewUserDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreate={addUser} />
    </AdminOnly>
  )
}

function NewUserDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (input: { name: string; email: string; role: UserRole }) => void
}) {
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<UserRole>("anotador")
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setEmail("")
    setRole("anotador")
    setError(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const emailOk = /.+@.+\..+/.test(email.trim())
    if (!name.trim()) {
      setError("Informe o nome do usuário.")
      return
    }
    if (!emailOk) {
      setError("Informe um e-mail válido.")
      return
    }
    onCreate({ name: name.trim(), email: email.trim(), role })
    onClose()
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
          <Button type="submit">
            <Users className="size-4" />
            Criar usuário
          </Button>
        </div>
      </form>
    </div>
  )
}
