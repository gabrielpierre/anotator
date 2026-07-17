import { AppShell } from "@/components/app/app-shell"
import { TrainingWizard } from "@/components/training/training-wizard"

export default async function NovoTreinamentoPage({
  searchParams,
}: {
  searchParams: Promise<{ release?: string }>
}) {
  const { release = "release_014" } = await searchParams

  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Treinamentos", href: "/treinar" },
        { label: release },
      ]}
    >
      <TrainingWizard release={release} />
    </AppShell>
  )
}
