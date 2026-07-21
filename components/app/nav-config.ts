import {
  LayoutGrid,
  FolderKanban,
  Database,
  PenLine,
  CheckSquare,
  Cpu,
  Boxes,
  GitBranch,
  Users,
  type LucideIcon,
} from "lucide-react"

export type NavEntry = {
  label: string
  href: string
  icon: LucideIcon
  badge?: number
  // Quando true, a entrada só aparece para administradores.
  adminOnly?: boolean
}

export const navEntries: NavEntry[] = [
  { label: "Visão geral", href: "/", icon: LayoutGrid },
  { label: "Projetos", href: "/projetos", icon: FolderKanban, adminOnly: true },
  { label: "Dados", href: "/dados", icon: Database },
  { label: "Anotar", href: "/anotar", icon: PenLine },
  { label: "Revisar", href: "/revisar", icon: CheckSquare },
  { label: "Treinar", href: "/treinar", icon: Cpu },
  { label: "Modelos", href: "/modelos", icon: Boxes },
  { label: "Releases", href: "/releases", icon: GitBranch },
  { label: "Usuários", href: "/usuarios", icon: Users, adminOnly: true },
]
