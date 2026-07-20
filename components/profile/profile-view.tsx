"use client"

import * as React from "react"
import { Camera, Check, Trash2, User, Lock, ShieldCheck, PenLine, Eye, EyeOff } from "lucide-react"
import { Card } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import { Avatar } from "@/components/snowui/avatar"
import { PageHeader } from "@/components/app/primitives"
import { useCurrentUser, roleLabels } from "@/lib/auth/user-context"

export function ProfileView() {
  const { currentUser, isAdmin } = useCurrentUser()

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Meu perfil"
        subtitle="Atualize suas informações pessoais, foto e senha de acesso."
        badge={
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isAdmin ? "bg-surface-purple text-brand-lavender" : "bg-surface-blue text-brand-blue"
            }`}
          >
            {isAdmin ? <ShieldCheck className="size-3.5" /> : <PenLine className="size-3.5" />}
            {roleLabels[currentUser.role]}
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <PhotoCard />
        <div className="flex flex-col gap-6 lg:col-span-2">
          <PersonalInfoCard />
          <PasswordCard />
        </div>
      </div>
    </div>
  )
}

function SavedPill({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-green">
      <Check className="size-3.5" />
      Salvo
    </span>
  )
}

function PhotoCard() {
  const { currentUser, updateProfile } = useCurrentUser()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [saved, setSaved] = React.useState(false)

  function flashSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      updateProfile({ avatar: String(reader.result) })
      flashSaved()
    }
    reader.readAsDataURL(file)
    event.target.value = ""
  }

  return (
    <Card className="flex flex-col items-center gap-4 text-center">
      <div className="flex w-full items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Foto</h2>
        <SavedPill show={saved} />
      </div>

      <div className="relative">
        <Avatar name={currentUser.name} src={currentUser.avatar} size="lg" className="size-28 text-2xl" />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label="Alterar foto"
          className="absolute -bottom-1 -right-1 flex size-9 items-center justify-center rounded-full border-2 border-card bg-brand-blue text-white transition-opacity hover:opacity-90"
        >
          <Camera className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">{currentUser.name}</p>
        <p className="text-xs text-muted-foreground">{currentUser.email}</p>
      </div>

      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />

      <div className="flex w-full flex-col gap-2">
        <Button variant="outline" onClick={() => inputRef.current?.click()} className="w-full">
          <Camera className="size-4" />
          Enviar nova foto
        </Button>
        {currentUser.avatar && (
          <Button
            variant="ghost"
            onClick={() => {
              updateProfile({ avatar: "" })
              flashSaved()
            }}
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" />
            Remover foto
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground text-pretty">PNG ou JPG. A imagem fica quadrada e centralizada.</p>
    </Card>
  )
}

function PersonalInfoCard() {
  const { currentUser, updateProfile } = useCurrentUser()
  const [name, setName] = React.useState(currentUser.name)
  const [email, setEmail] = React.useState(currentUser.email)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  // Mantém os campos sincronizados ao trocar de usuário logado.
  React.useEffect(() => {
    setName(currentUser.name)
    setEmail(currentUser.email)
  }, [currentUser.id, currentUser.name, currentUser.email])

  const dirty = name.trim() !== currentUser.name || email.trim() !== currentUser.email

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError("Informe seu nome.")
      return
    }
    if (!/.+@.+\..+/.test(email.trim())) {
      setError("Informe um e-mail válido.")
      return
    }
    updateProfile({ name, email })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <User className="size-4 text-muted-foreground" />
          Informações pessoais
        </h2>
        <SavedPill show={saved} />
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Nome</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">E-mail</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>
        </div>

        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty}>
            Salvar alterações
          </Button>
        </div>
      </form>
    </Card>
  )
}

function PasswordCard() {
  const { changePassword } = useCurrentUser()
  const [current, setCurrent] = React.useState("")
  const [next, setNext] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [show, setShow] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  function reset() {
    setCurrent("")
    setNext("")
    setConfirm("")
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (next !== confirm) {
      setError("A confirmação não corresponde à nova senha.")
      return
    }
    const result = changePassword(current, next)
    if (!result.ok) {
      setError(result.error)
      return
    }
    reset()
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2500)
  }

  const canSubmit = current.length > 0 && next.length > 0 && confirm.length > 0

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock className="size-4 text-muted-foreground" />
          Senha
        </h2>
        <SavedPill show={saved} />
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Senha atual</span>
          <input
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            type={show ? "text" : "password"}
            autoComplete="current-password"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Nova senha</span>
            <input
              value={next}
              onChange={(event) => setNext(event.target.value)}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Mínimo de 6 caracteres"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Confirmar nova senha</span>
            <input
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-blue"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={() => setShow((value) => !value)}
          className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {show ? "Ocultar senhas" : "Mostrar senhas"}
        </button>

        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="flex justify-end">
          <Button type="submit" disabled={!canSubmit}>
            Atualizar senha
          </Button>
        </div>
      </form>
    </Card>
  )
}
