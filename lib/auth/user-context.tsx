"use client"

import * as React from "react"
import {
  authToken,
  createUser,
  deleteProject,
  deactivateUser,
  fetchCurrentUser,
  fetchProjectMembers,
  fetchProjects,
  fetchUsers,
  loginBackend,
  logoutBackend,
  putProjectMembers,
  updateUser,
} from "@/lib/api/client"
import { formatDateTimePt } from "@/lib/api/status"
import type { BackendProject, BackendUser } from "@/lib/api/types"

export type UserRole = "admin" | "anotador"

export type AppUser = {
  id: string
  name: string
  email: string
  role: UserRole
  avatar?: string
  createdAt: string
}

export type ProjectRecord = {
  id: string
  externalId: string
  name: string
  status: string
  storagePath: string
  quotaGb: number
  usedGb: number
  percent: number
  createdAt: string
  annotatorIds: string[]
}

export type NewUserInput = {
  name: string
  email: string
  role: UserRole
  password?: string
}

export type ProfileUpdate = {
  name?: string
  email?: string
  avatar?: string
}

export type LoginResult = { ok: true } | { ok: false; error: string }

export const DEFAULT_PASSWORD = "cvat123"

type UserContextValue = {
  currentUser: AppUser
  isAuthenticated: boolean
  authReady: boolean
  isAdmin: boolean
  users: AppUser[]
  annotators: AppUser[]
  login: (email: string, password: string) => Promise<LoginResult>
  logout: () => Promise<void>
  updateProfile: (patch: ProfileUpdate) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<LoginResult>
  addUser: (input: NewUserInput) => Promise<AppUser>
  removeUser: (userId: string) => Promise<void>
  switchUser: (userId: string) => void
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  activeProjectId: string | null
  setActiveProjectId: (projectId: string | null) => void
  addProject: (project: ProjectRecord) => Promise<void>
  updateProject: (id: string, patch: { name?: string; storagePath?: string; quotaGb?: number; annotatorIds?: string[] }) => Promise<void>
  removeProject: (id: string) => Promise<void>
  assignUserToProject: (projectId: string, userId: string) => Promise<void>
  removeUserFromProject: (projectId: string, userId: string) => Promise<void>
}

const emptyUser: AppUser = {
  id: "",
  name: "Carregando",
  email: "",
  role: "anotador",
  createdAt: "",
}

const UserContext = React.createContext<UserContextValue | null>(null)
const ACTIVE_PROJECT_ID_KEY = "cvat.active_project_id"

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

export function projectRecordFromBackend(project: BackendProject, existingAnnotators: string[] = []): ProjectRecord {
  const storage = (project.raw?.storage ?? {}) as Record<string, unknown>
  const quotaGb = numberFromUnknown(storage.quota_gb) ?? 0
  const usedBytes = numberFromUnknown(storage.used_bytes) ?? 0
  const usedGb = usedBytes / 1024 ** 3
  const rawAnnotators = (project.raw?.annotator_ids ?? []) as unknown
  const annotatorIds = Array.isArray(rawAnnotators) ? rawAnnotators.map(String) : existingAnnotators
  return {
    id: project.id,
    externalId: project.external_id,
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

function userFromBackend(user: BackendUser): AppUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar_url ?? undefined,
    createdAt: formatDateTimePt(user.created_at),
  }
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = React.useState<AppUser>(emptyUser)
  const [authReady, setAuthReady] = React.useState(false)
  const [users, setUsers] = React.useState<AppUser[]>([])
  const [projects, setProjects] = React.useState<ProjectRecord[]>([])
  const [activeProjectId, setActiveProjectIdState] = React.useState<string | null>(() => {
    if (typeof window === "undefined") return null
    return window.sessionStorage.getItem(ACTIVE_PROJECT_ID_KEY)
  })

  const refreshDirectory = React.useCallback(async (user: AppUser) => {
    const projectRows = await fetchProjects()
    const records = projectRows.map((project) => projectRecordFromBackend(project))
    if (user.role === "admin") {
      const [userRows, memberRows] = await Promise.all([
        fetchUsers().catch(() => [] as BackendUser[]),
        Promise.all(
          records.map((project) =>
            fetchProjectMembers(project.id)
              .then((members) => [project.id, members.map((member) => member.user_id)] as const)
              .catch(() => [project.id, project.annotatorIds] as const),
          ),
        ),
      ])
      const membersByProject = new Map(memberRows)
      setUsers(userRows.map(userFromBackend))
      setProjects(
        records.map((project) => ({
          ...project,
          annotatorIds: membersByProject.get(project.id) ?? project.annotatorIds,
        })),
      )
    } else {
      setUsers([user])
      setProjects(records)
    }
  }, [])

  React.useEffect(() => {
    let active = true
    async function hydrate() {
      const token = authToken()
      if (!token) {
        if (active) setAuthReady(true)
        return
      }
      try {
        const backendUser = await fetchCurrentUser()
        if (!active) return
        const appUser = userFromBackend(backendUser)
        setCurrentUser(appUser)
        await refreshDirectory(appUser)
      } catch {
        if (active) {
          setCurrentUser(emptyUser)
          setUsers([])
          setProjects([])
        }
      } finally {
        if (active) setAuthReady(true)
      }
    }
    void hydrate()
    return () => {
      active = false
    }
  }, [refreshDirectory])

  const login = React.useCallback<UserContextValue["login"]>(
    async (email, password) => {
      try {
        const session = await loginBackend(email, password)
        const appUser = userFromBackend(session.user)
        setCurrentUser(appUser)
        await refreshDirectory(appUser)
        return { ok: true }
      } catch {
        return { ok: false, error: "E-mail ou senha inválidos." }
      }
    },
    [refreshDirectory],
  )

  const logout = React.useCallback(async () => {
    await logoutBackend()
    setCurrentUser(emptyUser)
    setUsers([])
    setProjects([])
  }, [])

  const updateProfile = React.useCallback<UserContextValue["updateProfile"]>(
    async (patch) => {
      if (!currentUser.id) return
      const updated = await updateUser(currentUser.id, {
        name: patch.name?.trim(),
        email: patch.email?.trim(),
        avatar_url: patch.avatar,
      })
      const appUser = userFromBackend(updated)
      setCurrentUser(appUser)
      setUsers((current) => current.map((user) => (user.id === appUser.id ? appUser : user)))
    },
    [currentUser.id],
  )

  const changePassword = React.useCallback<UserContextValue["changePassword"]>(
    async (currentPassword, newPassword) => {
      if (!currentUser.id) return { ok: false, error: "Sessão expirada." }
      if (newPassword.length < 6) return { ok: false, error: "A nova senha deve ter ao menos 6 caracteres." }
      try {
        await updateUser(currentUser.id, { current_password: currentPassword, password: newPassword })
        return { ok: true }
      } catch {
        return { ok: false, error: "Senha atual inválida ou sessão sem permissão." }
      }
    },
    [currentUser.id],
  )

  const addUser = React.useCallback<UserContextValue["addUser"]>(async (input) => {
    const created = await createUser({
      name: input.name.trim(),
      email: input.email.trim(),
      role: input.role,
      password: input.password?.trim() || DEFAULT_PASSWORD,
    })
    const user = userFromBackend(created)
    setUsers((current) => [user, ...current.filter((item) => item.id !== user.id)])
    return user
  }, [])

  const removeUser = React.useCallback<UserContextValue["removeUser"]>(async (userId) => {
    await deactivateUser(userId)
    setUsers((current) => current.filter((user) => user.id !== userId))
    setProjects((current) =>
      current.map((project) => ({
        ...project,
        annotatorIds: project.annotatorIds.filter((id) => id !== userId),
      })),
    )
  }, [])

  const switchUser = React.useCallback((_userId: string) => {
    return
  }, [])

  const setActiveProjectId = React.useCallback((projectId: string | null) => {
    setActiveProjectIdState(projectId)
    if (typeof window === "undefined") return
    if (projectId) window.sessionStorage.setItem(ACTIVE_PROJECT_ID_KEY, projectId)
    else window.sessionStorage.removeItem(ACTIVE_PROJECT_ID_KEY)
  }, [])

  const syncProjectMembers = React.useCallback(async (projectId: string, annotatorIds: string[]) => {
    await putProjectMembers(projectId, annotatorIds)
  }, [])

  const addProject = React.useCallback<UserContextValue["addProject"]>(
    async (project) => {
      setProjects((current) => {
        const exists = current.some((item) => item.id === project.id)
        return exists ? current.map((item) => (item.id === project.id ? project : item)) : [project, ...current]
      })
      await syncProjectMembers(project.id, project.annotatorIds)
    },
    [syncProjectMembers],
  )

  const updateProjectRecord = React.useCallback<UserContextValue["updateProject"]>(
    async (id, patch) => {
      let nextAnnotators: string[] | null = null
      setProjects((current) =>
        current.map((project) => {
          if (project.id !== id) return project
          const quotaGb = patch.quotaGb ?? project.quotaGb
          const annotatorIds = patch.annotatorIds ?? project.annotatorIds
          nextAnnotators = annotatorIds
          return {
            ...project,
            name: patch.name ?? project.name,
            storagePath: patch.storagePath ?? project.storagePath,
            quotaGb,
            percent: computePercent(project.usedGb, quotaGb),
            annotatorIds,
          }
        }),
      )
      if (nextAnnotators) await syncProjectMembers(id, nextAnnotators)
    },
    [syncProjectMembers],
  )

  const removeProject = React.useCallback<UserContextValue["removeProject"]>(
    async (id) => {
      await deleteProject(id)
      setProjects((current) => current.filter((project) => project.id !== id))
      if (activeProjectId === id) setActiveProjectId(null)
    },
    [activeProjectId, setActiveProjectId],
  )

  const assignUserToProject = React.useCallback<UserContextValue["assignUserToProject"]>(
    async (projectId, userId) => {
      const project = projects.find((item) => item.id === projectId)
      const next = project && !project.annotatorIds.includes(userId) ? [...project.annotatorIds, userId] : project?.annotatorIds
      if (!next) return
      setProjects((current) =>
        current.map((item) => (item.id === projectId ? { ...item, annotatorIds: next } : item)),
      )
      await syncProjectMembers(projectId, next)
    },
    [projects, syncProjectMembers],
  )

  const removeUserFromProject = React.useCallback<UserContextValue["removeUserFromProject"]>(
    async (projectId, userId) => {
      const project = projects.find((item) => item.id === projectId)
      if (!project) return
      const next = project.annotatorIds.filter((id) => id !== userId)
      setProjects((current) =>
        current.map((item) => (item.id === projectId ? { ...item, annotatorIds: next } : item)),
      )
      await syncProjectMembers(projectId, next)
    },
    [projects, syncProjectMembers],
  )

  React.useEffect(() => {
    if (projects.length === 0) {
      if (activeProjectId !== null) setActiveProjectId(null)
      return
    }
    if (activeProjectId && projects.some((project) => project.id === activeProjectId)) return
    setActiveProjectId(projects[0].id)
  }, [activeProjectId, projects, setActiveProjectId])

  const isAuthenticated = Boolean(currentUser.id && authToken())
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null
  const value = React.useMemo<UserContextValue>(
    () => ({
      currentUser,
      isAuthenticated,
      authReady,
      isAdmin: currentUser.role === "admin",
      users,
      annotators: users.filter((user) => user.role === "anotador"),
      login,
      logout,
      updateProfile,
      changePassword,
      addUser,
      removeUser,
      switchUser,
      projects,
      activeProject,
      activeProjectId: activeProject?.id ?? null,
      setActiveProjectId,
      addProject,
      updateProject: updateProjectRecord,
      removeProject,
      assignUserToProject,
      removeUserFromProject,
    }),
    [
      currentUser,
      isAuthenticated,
      authReady,
      users,
      login,
      logout,
      updateProfile,
      changePassword,
      addUser,
      removeUser,
      switchUser,
      projects,
      activeProject,
      setActiveProjectId,
      addProject,
      updateProjectRecord,
      removeProject,
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
