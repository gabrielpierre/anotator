"use client"

import * as React from "react"

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
  switchUser: (userId: string) => void
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

  const switchUser = React.useCallback((userId: string) => {
    setCurrentUserId(userId)
  }, [])

  const value = React.useMemo<UserContextValue>(
    () => ({
      currentUser,
      isAdmin: currentUser.role === "admin",
      users,
      annotators: users.filter((user) => user.role === "anotador"),
      addUser,
      switchUser,
    }),
    [currentUser, users, addUser, switchUser],
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
