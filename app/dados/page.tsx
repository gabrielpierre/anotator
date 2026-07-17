import { AppShell } from "@/components/app/app-shell"
import { DataView } from "@/components/data/data-view"

export default function DadosPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Dados" },
      ]}
    >
      <DataView />
    </AppShell>
  )
}
