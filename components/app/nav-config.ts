import {
  LayoutGrid,
  Database,
  PenLine,
  CheckSquare,
  Cpu,
  Boxes,
  GitBranch,
  type LucideIcon,
} from "lucide-react"

export type NavEntry = {
  label: string
  href: string
  icon: LucideIcon
  badge?: number
}

export const navEntries: NavEntry[] = [
  { label: "Visão geral", href: "/", icon: LayoutGrid },
  { label: "Dados", href: "/dados", icon: Database },
  { label: "Anotar", href: "/anotar", icon: PenLine },
  { label: "Revisar", href: "/revisar", icon: CheckSquare, badge: 93 },
  { label: "Treinar", href: "/treinar", icon: Cpu },
  { label: "Modelos", href: "/modelos", icon: Boxes },
  { label: "Releases", href: "/releases", icon: GitBranch },
]
