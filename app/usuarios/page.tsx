import { AppShell } from "@/components/app/app-shell"
import { UsersView } from "@/components/users/users-view"

export default function Page() {
  return (
    <AppShell breadcrumb={[{ label: "Usuários", href: "/usuarios" }]}>
      <UsersView />
    </AppShell>
  )
}
