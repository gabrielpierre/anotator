import { AppShell } from "@/components/app/app-shell"
import { ProjectsView } from "@/components/projects/projects-view"

export default function Page() {
  return (
    <AppShell breadcrumb={[{ label: "Projetos", href: "/projetos" }]}>
      <ProjectsView />
    </AppShell>
  )
}
