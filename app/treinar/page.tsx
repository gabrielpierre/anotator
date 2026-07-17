import { AppShell } from "@/components/app/app-shell"
import { TrainingList } from "@/components/training/training-list"

export default function TreinarPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Treinamentos" },
      ]}
    >
      <TrainingList />
    </AppShell>
  )
}
