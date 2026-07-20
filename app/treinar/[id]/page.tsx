import { AppShell } from "@/components/app/app-shell"
import { TrainingDetail } from "@/components/training/training-detail"

export default async function TrainingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Treinamentos", href: "/treinar" },
        { label: `Treinamento #${id}` },
      ]}
    >
      <TrainingDetail id={id} />
    </AppShell>
  )
}
