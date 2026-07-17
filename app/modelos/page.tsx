import { AppShell } from "@/components/app/app-shell"
import { ModelsView } from "@/components/models/models-view"

export default function ModelosPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Modelos" },
      ]}
    >
      <ModelsView />
    </AppShell>
  )
}
