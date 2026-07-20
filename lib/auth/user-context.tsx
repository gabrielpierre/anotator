"use client"

import * as React from "react"
import { fetchProjects, mockFallbackEnabled } from "@/lib/api/client"
import { formatDateTimePt } from "@/lib/api/status"
import type { BackendProject } from "@/lib/api/types"

export type UserRole = "admin" | "anotador"

export type AppUser = {
  id: string
  name: string
  email: string
  role: UserRole
  avatar?: string
  createdAt: string
}

// Usuários iniciais (camada de simulação no frontend — sem autenticação real ainda).
const seedUsers: AppUser[] = [
  {
    id: "u-gabriel",
    name: "Gabriel",
    email: "gabriel@cvat.plus",
    role: "admin",
    avatar: "/operator-avatar.png",
    createdAt: "01/06/2024 09:00",
  },
  {
    id: "u-mariana",
    name: "Mariana",
    email: "mariana@cvat.plus",
    role: "anotador",
    createdAt: "12/06/2024 14:20",
  },
  {
    id: "u-rafael",
    name: "Rafael Souza",
    email: "rafael@cvat.plus",
    role: "anotador",
    createdAt: "28/06/2024 10:05",
  },
]

// Diretório de projetos — fonte única compartilhada entre as abas Projetos e Usuários.
// (camada de simulação no frontend, com fallback para o backend quando disponível)
export type ProjectRecord = {
  id: string
  name: string
  status: string
  storagePath: string
  quotaGb: number
  usedGb: number
  percent: number
  createdAt: string
  annotatorIds: string[]
}

const mockProjects: ProjectRecord[] = [
  {
    id: "veiculos-cityscapes",
    name: "Veículos - Cityscapes",
    status: "active",
    storagePath: "D:\\datasets\\cityscapes",
    quotaGb: 200,
    usedGb: 128.6,
    percent: 64,
    createdAt: "01/06/2024 09:12",
    annotatorIds: ["u-mariana", "u-rafael"],
  },
  {
    id: "rodovia-2026",
    name: "Rodovia - Tráfego 2026",
    status: "active",
    storagePath: "D:\\datasets\\rodovia-2026",
    quotaGb: 100,
    usedGb: 42.3,
    percent: 42,
    createdAt: "28/06/2024 15:40",
    annotatorIds: ["u-mariana"],
  },
  {
    id: "pedestres-noturno",
    name: "Pedestres - Cenas Noturnas",
    status: "active",
    storagePath: "D:\\datasets\\pedestres-noturno",
    quotaGb: 60,
    usedGb: 12.8,
    percent: 21,
    createdAt: "10/07/2024 11:05",
    annotatorIds: [],
  },
]

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function computePercent(usedGb: number, quotaGb: number) {
  return quotaGb > 0 ? Math.min(100, Math.round((usedGb / quotaGb) * 100)) : 0
}

// Converte um projeto do backend em ProjectRecord, preservando anotadores já associados.
export function projectRecordFromBackend(project: BackendProject, existingAnnotators: string[] = []): ProjectRecord {
  const storage = (project.raw?.storage ?? {}) as Record<string, unknown>
  const quotaGb = numberFromUnknown(storage.quota_gb) ?? 0
  const usedBytes = numberFromUnknown(storage.used_bytes) ?? 0
  const usedGb = usedBytes / 1024 ** 3
  const rawAnnotators = (project.raw?.annotator_ids ?? []) as unknown
  const annotatorIds = Array.isArray(rawAnnotators) ? rawAnnotators.map(String) : existingAnnotators
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    storagePath: String(storage.path ?? "--"),
    quotaGb,
    usedGb,
    percent: computePercent(usedGb, quotaGb),
    createdAt: formatDateTimePt(project.created_at),
    annotatorIds,
  }
}

export type NewUserInput = {
  name: string
  email: string
  role: UserRole
}

type UserContextValue = {
  currentUser: AppUser
  isAdmin: boolean
  users: AppUser[]
  annotators: AppUser[]
  addUser: (input: NewUserInput) => AppUser
  removeUser: (userId: string) => void
  switchUser: (userId: string) => void
  projects: ProjectRecord[]
  addProject: (project: ProjectRecord) => void
  updateProject: (id: string, patch: { name?: string; quotaGb?: number; annotatorIds?: string[] }) => void
  assignUserToProject: (projectId: string, userId: string) => void
  removeUserFromProject: (projectId: string, userId: string) => void
}

const UserContext = React.createContext<UserContextValue | null>(null)

function makeId() {
  return `u-${Math.random().toString(36).slice(2, 9)}`
}

function nowPt() {
  return new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [users, setUsers] = React.useState<AppUser[]>(seedUsers)
  const [currentUserId, setCurrentUserId] = React.useState<string>(seedUsers[0].id)
  const [projects, setProjects] = React.useState<ProjectRecord[]>(mockProjects)

  // Enriquece a lista com os projetos do backend quando ele retorna dados,
  // preservando as associações de anotadores já existentes por id.
  // Sem backend disponível, mantém os projetos de demonstração (camada de simulação).
  React.useEffect(() => {
    const controller = new AbortController()
    fetchProjects(controller.signal)
      .then((data) => {
        if (data.length === 0) return
        setProjects((current) => {
          const annotatorsById = new Map(current.map((project) => [project.id, project.annotatorIds]))
          return data.map((project) =>
            projectRecordFromBackend(project, annotatorsById.get(project.id) ?? []),
          )
        })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  const currentUser = React.useMemo(
    () => users.find((user) => user.id === currentUserId) ?? users[0],
    [users, currentUserId],
  )

  const addUser = React.useCallback((input: NewUserInput) => {
    const user: AppUser = {
      id: makeId(),
      name: input.name.trim(),
      email: input.email.trim(),
      role: input.role,
      createdAt: nowPt(),
    }
    setUsers((current) => [user, ...current])
    return user
  }, [])

  const removeUser = React.useCallback((userId: string) => {
    setUsers((current) => current.filter((user) => user.id !== userId))
    // Remove o usuário de qualquer projeto ao qual estava associado.
    setProjects((current) =>
      current.map((project) => ({
        ...project,
        annotatorIds: project.annotatorIds.filter((id) => id !== userId),
      })),
    )
  }, [])

  const switchUser = React.useCallback((userId: string) => {
    setCurrentUserId(userId)
  }, [])

  const addProject = React.useCallback((project: ProjectRecord) => {
    setProjects((current) => {
      const exists = current.some((item) => item.id === project.id)
      return exists ? current.map((item) => (item.id === project.id ? project : item)) : [project, ...current]
    })
  }, [])

  const updateProject = React.useCallback(
    (id: string, patch: { name?: string; quotaGb?: number; annotatorIds?: string[] }) => {
      setProjects((current) =>
        current.map((project) => {
          if (project.id !== id) return project
          const quotaGb = patch.quotaGb ?? project.quotaGb
          return {
            ...project,
            name: patch.name ?? project.name,
            quotaGb,
            percent: computePercent(project.usedGb, quotaGb),
            annotatorIds: patch.annotatorIds ?? project.annotatorIds,
          }
        }),
      )
    },
    [],
  )

  const assignUserToProject = React.useCallback((projectId: string, userId: string) => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId && !project.annotatorIds.includes(userId)
          ? { ...project, annotatorIds: [...project.annotatorIds, userId] }
          : project,
      ),
    )
  }, [])

  const removeUserFromProject = React.useCallback((projectId: string, userId: string) => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? { ...project, annotatorIds: project.annotatorIds.filter((id) => id !== userId) }
          : project,
      ),
    )
  }, [])

  const value = React.useMemo<UserContextValue>(
    () => ({
      currentUser,
      isAdmin: currentUser.role === "admin",
      users,
      annotators: users.filter((user) => user.role === "anotador"),
      addUser,
      removeUser,
      switchUser,
      projects,
      addProject,
      updateProject,
      assignUserToProject,
      removeUserFromProject,
    }),
    [
      currentUser,
      users,
      addUser,
      removeUser,
      switchUser,
      projects,
      addProject,
      updateProject,
      assignUserToProject,
      removeUserFromProject,
    ],
  )

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>
}

export function useCurrentUser() {
  const context = React.useContext(UserContext)
  if (!context) {
    throw new Error("useCurrentUser deve ser usado dentro de <UserProvider>.")
  }
  return context
}

export const roleLabels: Record<UserRole, string> = {
  admin: "Administrador",
  anotador: "Anotador",
}
