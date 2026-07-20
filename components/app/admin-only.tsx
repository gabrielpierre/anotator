"use client"

import * as React from "react"
import { Lock } from "lucide-react"
import { Card, CardContent } from "@/components/snowui/card"
import { useCurrentUser } from "@/lib/auth/user-context"

/**
 * Envolve conteúdo restrito a administradores. Para anotadores, exibe um aviso
 * de acesso restrito no lugar do conteúdo.
 */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useCurrentUser()

  if (isAdmin) return <>{children}</>

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Lock className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-foreground">Acesso restrito</p>
            <p className="max-w-sm text-sm text-muted-foreground text-pretty">
              Esta área é exclusiva para administradores. Fale com um administrador caso precise de acesso.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
