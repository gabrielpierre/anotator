import { AppShell } from "@/components/app/app-shell"
import { ProjectOverview } from "@/components/overview/project-overview"

export default function Page() {
  return (
    <AppShell breadcrumb={[{ label: "Projetos", href: "/" }, { label: "Veículos - Cityscapes" }]}>
      <ProjectOverview />
    </AppShell>
  )
}
