import { AppShell } from "@/components/app/app-shell"
import { AnnotateView } from "@/components/annotate/annotate-view"

export default function AnotarPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Anotar" },
      ]}
    >
      <AnnotateView />
    </AppShell>
  )
}
