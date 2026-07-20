import { AppShell } from "@/components/app/app-shell"
import { AuditView } from "@/components/audit/audit-view"

export default function AuditoriaPage() {
  return (
    <AppShell
      breadcrumb={[
        { label: "Projetos", href: "/projetos" },
        { label: "Projeto atual", href: "/" },
        { label: "Auditoria" },
      ]}
    >
      <AuditView />
    </AppShell>
  )
}
