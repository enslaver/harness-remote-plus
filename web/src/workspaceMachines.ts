import { normalizeServerConfig } from "./serverConfig"
import type { ServerConfig } from "./types"

export const WORKSPACE_MACHINES_STORAGE_KEY = "harness-remote.workspace.machines.v1"
export const DESKTOP_LOCAL_MACHINE_ID = "desktop-local-runtime"
/** Machines a hub lists are projected into the workspace under this id prefix and never stored. */
export const HUB_MACHINE_ID_PREFIX = "hub:"

export type WorkspaceMachine = {
  id: string
  name: string
  config: ServerConfig
}

function machineID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `machine-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function isDesktopLocalMachine(machine: Pick<WorkspaceMachine, "id">): boolean {
  return machine.id === DESKTOP_LOCAL_MACHINE_ID
}

export function isHubMachine(machine: Pick<WorkspaceMachine, "id">): boolean {
  return machine.id.startsWith(HUB_MACHINE_ID_PREFIX)
}

/**
 * A machine whose configuration belongs to something other than the user's saved list: the desktop
 * app's own runtime, or a hub. Neither is persisted, edited or removed from here; the owner decides.
 */
export function isRuntimeOwnedMachine(machine: Pick<WorkspaceMachine, "id">): boolean {
  return isDesktopLocalMachine(machine) || isHubMachine(machine)
}

function normalizeMachine(value: unknown): WorkspaceMachine | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as {
    id?: unknown
    name?: unknown
    config?: Partial<ServerConfig>
  }
  const config = candidate.config
  if (!config || typeof config.host !== "string" || typeof config.port !== "number") return null
  if (typeof config.username !== "string" || typeof config.password !== "string") return null
  const normalized = normalizeServerConfig({
    backend: "opencode",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password
  })
  if (!normalized) return null

  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : machineID()
  // Runtime-owned ids are never valid in storage: a stale or hand-edited entry must not be able to
  // masquerade as (or shadow) a machine the runtime or the hub owns.
  if (id === DESKTOP_LOCAL_MACHINE_ID || id.startsWith(HUB_MACHINE_ID_PREFIX)) return null
  return {
    id,
    name: typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : normalized.host,
    config: {
      ...normalized,
      backend: "opencode",
      agentId: undefined
    }
  }
}

export function loadWorkspaceMachines(): WorkspaceMachine[] {
  try {
    const raw = localStorage.getItem(WORKSPACE_MACHINES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      const machine = normalizeMachine(value)
      return machine ? [machine] : []
    })
  } catch {
    return []
  }
}

export function persistWorkspaceMachines(machines: WorkspaceMachine[]): void {
  const normalized = machines.flatMap((machine) => {
    if (isRuntimeOwnedMachine(machine)) return []
    const next = normalizeMachine(machine)
    return next ? [next] : []
  })
  localStorage.setItem(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify(normalized))
}

export function createWorkspaceMachine(): WorkspaceMachine {
  return {
    id: machineID(),
    name: "New machine",
    config: {
      backend: "opencode",
      host: "",
      port: 4097,
      username: "harness",
      password: ""
    }
  }
}