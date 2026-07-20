import { AppShell } from "@/components/app/app-shell"
import { JobsView } from "@/components/jobs/jobs-view"

export default function JobsPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Jobs" },
      ]}
    >
      <JobsView />
    </AppShell>
  )
}
