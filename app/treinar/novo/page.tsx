import { AppShell } from "@/components/app/app-shell"
import { TrainingWizard } from "@/components/training/training-wizard"
import { Card, CardContent } from "@/components/snowui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export default async function NovoTreinamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ release?: string }>
}) {
  const { release } = await searchParams

  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Treinamentos", href: "/treinar" },
        { label: release ?? "Novo treinamento" },
      ]}
    >
      {release ? (
        <TrainingWizard release={release} />
      ) : (
        <div className="p-4 md:p-6">
          <Card>
            <CardContent className="flex flex-col items-start gap-3 p-6">
              <h1 className="text-xl font-semibold text-foreground">Selecione um dataset release</h1>
              <p className="text-sm text-muted-foreground">
                Um treinamento precisa de um release real preparado pelo backend.
              </p>
              <Button nativeButton={false} render={<Link href="/treinar" />}>
                Voltar para treinamentos
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  )
}
