import { AppShell } from "@/components/app/app-shell"
import { ReviewWorkspace } from "@/components/review/review-workspace"

export default function RevisarPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Revisão" },
      ]}
    >
      <ReviewWorkspace />
    </AppShell>
  )
}
