import { AppShell } from "@/components/app/app-shell"
import { ReviewWorkspace } from "@/components/review/review-workspace"

export default function RevisarPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Lote 3/10" },
        { label: "Revisão" },
      ]}
    >
      <ReviewWorkspace />
    </AppShell>
  )
}
