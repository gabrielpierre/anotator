import { AppShell } from "@/components/app/app-shell"
import { ReleasesView } from "@/components/releases/releases-view"

export default function ReleasesPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Releases" },
      ]}
    >
      <ReleasesView />
    </AppShell>
  )
}
