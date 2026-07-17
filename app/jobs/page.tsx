import { AppShell } from "@/components/app/app-shell"
import { JobsView } from "@/components/jobs/jobs-view"

export default function JobsPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/" },
        { label: "Veículos - Cityscapes", href: "/" },
        { label: "Jobs" },
      ]}
    >
      <JobsView />
    </AppShell>
  )
}
