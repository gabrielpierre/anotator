"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Eye, EyeOff, LogIn, Mail, Lock, ShieldCheck, Layers, Cpu } from "lucide-react"
import { Brand } from "@/components/app/brand"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/snowui/theme-toggle"
import { useCurrentUser } from "@/lib/auth/user-context"

const highlights = [
  { icon: Layers, title: "Anotação e revisão", text: "Fluxos de rotulagem e revisão rápida em um só lugar." },
  { icon: Cpu, title: "Treinamento assistido", text: "Métricas ao vivo e pipelines encadeados de visão." },
  { icon: ShieldCheck, title: "Acesso por perfil", text: "Controle fino entre administradores e anotadores." },
]

export function LoginView() {
  const router = useRouter()
  const { login, isAuthenticated } = useCurrentUser()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Já autenticado: segue direto para a aplicação.
  React.useEffect(() => {
    if (isAuthenticated) router.replace("/")
  }, [isAuthenticated, router])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await login(email, password)
    if (result.ok) {
      router.replace("/")
    } else {
      setError(result.error)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh bg-background">
      {/* Painel de marca — visível a partir de lg */}
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-surface-mint p-10 lg:flex xl:p-14">
        <Brand />

        <div className="flex flex-col gap-6">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-foreground text-balance xl:text-4xl">
            A camada de orquestração da sua equipe de visão computacional.
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
            Centralize datasets, anotação, revisão e treinamento com controle de acesso por perfil — do
            primeiro rótulo ao modelo em produção.
          </p>

          <ul className="mt-2 flex flex-col gap-3">
            {highlights.map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-mint/20 text-brand-mint">
                  <item.icon className="size-4.5" />
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{item.title}</span>
                  <span className="text-xs text-muted-foreground text-pretty">{item.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} CVAT++. Todos os direitos reservados.</p>
      </aside>

      {/* Formulário */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between p-4 md:p-6">
          <span className="lg:hidden">
            <Brand />
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-4 pb-10">
          <div className="flex w-full max-w-sm flex-col gap-8">
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
                Entrar na sua conta
              </h1>
              <p className="text-sm text-muted-foreground text-pretty">
                Informe suas credenciais para acessar o painel.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">E-mail</span>
                <span className="relative flex items-center">
                  <Mail className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    type="email"
                    autoComplete="email"
                    placeholder="voce@cvat.plus"
                    className="h-11 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors focus:border-brand-blue"
                  />
                </span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">Senha</span>
                  <button
                    type="button"
                    className="text-xs font-medium text-brand-blue transition-opacity hover:opacity-80"
                    onClick={() => setError("Contate um administrador para redefinir sua senha.")}
                  >
                    Esqueceu a senha?
                  </button>
                </span>
                <span className="relative flex items-center">
                  <Lock className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="h-11 w-full rounded-lg border border-border bg-background pl-9 pr-10 text-sm outline-none transition-colors focus:border-brand-blue"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    className="absolute right-2 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </span>
              </label>

              {error && (
                <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" className="mt-1 w-full" disabled={submitting}>
                <LogIn className="size-4" />
                {submitting ? "Entrando..." : "Entrar"}
              </Button>
            </form>

            <div className="rounded-lg border border-dashed border-border bg-surface-subtle p-3">
              <p className="text-xs font-medium text-foreground">Credencial inicial local</p>
              <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                <li>
                  Admin: <span className="font-medium text-foreground">admin@cvat.plus</span> / admin123
                </li>
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
