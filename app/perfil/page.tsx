import { AppShell } from "@/components/app/app-shell"
import { ProfileView } from "@/components/profile/profile-view"

export default function Page() {
  return (
    <AppShell breadcrumb={[{ label: "Meu perfil", href: "/perfil" }]}>
      <ProfileView />
    </AppShell>
  )
}
