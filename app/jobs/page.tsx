import { AppShell } from "@/components/app/app-shell"
import { JobsView } from "@/components/jobs/jobs-view"

export default function JobsPage() {
  return (
    <AppShell breadcrumb={[{ label: "Jobs" }]}>
      <JobsView />
    </AppShell>
  )
}
