import { AppShell } from "@/components/app/app-shell"
import { TrainingList } from "@/components/training/training-list"

export default function TreinarPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Treinamentos" },
      ]}
    >
      <TrainingList />
    </AppShell>
  )
}
