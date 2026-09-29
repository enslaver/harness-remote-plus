import { ACTIVITY_ORDER, statusTypeForActivity, type AgentActivity } from "./agent-activity"
import { machineRequest } from "./taskClient"
import { nativeSessionConfig, nativeSessionRecords, type NativeSessionRecord } from "./native-session-discovery"
import type { MachineAgentHost, ServerConfig, Session } from "./types"

/**
 * Claude Code background agents (`claude --bg`), as the machine reports them. The machine owns all of it:
 * this file only reads the list, turns entries into the Session rows the rail already draws, and sends the
 * few verbs the daemon exposes (start, stop, continue, remove, logs). Nothing is stored in the browser.
 */
export type BackgroundAgentCapabilities = {
  open: boolean
  /** True only for a finished agent: a live one is driven by its own process. */
  prompt: boolean
  logs: boolean
  stop: boolean
  resume: boolean
  remove: boolean
}

export type BackgroundAgent = {
  key: string
  kind: "background" | "interactive"
  /** The short id `claude attach|logs|stop|rm` take. Absent for a terminal session. */
  id?: string
  sessionId?: string
  pid?: number
  name: string
  directory: string
  activity: AgentActivity
  rawState?: string
  detail?: string
  needs?: string
  startedAt?: number
  updatedAt?: number
  worktree?: { path?: string; branch?: string }
  subagents?: { total: number; running: number; failed: number }
  capabilities: BackgroundAgentCapabilities
}

export type BackgroundAgentList = {
  available: boolean
  reason?: string
  message?: string
  agents: BackgroundAgent[]
}

export type StartBackgroundAgentInput = {
  prompt: string
  directory: string
  name?: string
  model?: string
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto"
}

const EMPTY: BackgroundAgentList = { available: false, agents: [] }

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined
}

/** Reads one entry from the daemon, dropping anything that is not the shape it promises. */
export function parseBackgroundAgent(value: unknown): BackgroundAgent | undefined {
  if (!value || typeof value !== "object") return undefined
  const entry = value as Record<string, unknown>
  const activity = entry.activity
  if (typeof activity !== "string" || !ACTIVITY_ORDER.includes(activity as AgentActivity)) return undefined
  if (typeof entry.key !== "string" || (entry.kind !== "background" && entry.kind !== "interactive")) return undefined
  const capabilities = (entry.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : {}) as Record<string, unknown>
  const subagents = entry.subagents as Record<string, unknown> | undefined
  const worktree = entry.worktree as Record<string, unknown> | undefined
  return {
    key: entry.key,
    kind: entry.kind,
    id: text(entry.id, 16),
    sessionId: text(entry.sessionId, 64),
    pid: finite(entry.pid),
    name: text(entry.name, 200) || "Agent",
    directory: text(entry.directory, 1024) || "",
    activity: activity as AgentActivity,
    rawState: text(entry.rawState, 40),
    detail: text(entry.detail, 500),
    needs: text(entry.needs, 500),
    startedAt: finite(entry.startedAt),
    updatedAt: finite(entry.updatedAt),
    worktree: worktree ? { path: text(worktree.path, 1024), branch: text(worktree.branch, 200) } : undefined,
    subagents: subagents && finite(subagents.total) !== undefined
      ? { total: finite(subagents.total) ?? 0, running: finite(subagents.running) ?? 0, failed: finite(subagents.failed) ?? 0 }
      : undefined,
    capabilities: {
      open: capabilities.open === true,
      prompt: capabilities.prompt === true,
      logs: capabilities.logs === true,
      stop: capabilities.stop === true,
      resume: capabilities.resume === true,
      remove: capabilities.remove === true
    }
  }
}

export function parseBackgroundAgentList(value: unknown): BackgroundAgentList {
  if (!value || typeof value !== "object") return EMPTY
  const payload = value as { available?: unknown; reason?: unknown; message?: unknown; agents?: unknown }
  const agents = Array.isArray(payload.agents) ? payload.agents.map(parseBackgroundAgent).filter((agent): agent is BackgroundAgent => Boolean(agent)) : []
  return {
    available: payload.available === true,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    agents
  }
}

/**
 * Never throws: background agents are extra information layered on the Session list, and a machine
 * without Claude Code, with an older daemon (404), or one that is briefly busy must leave the rest of the
 * list exactly as it was. The daemon itself remembers "no claude here" for minutes, so asking is cheap.
 */
export async function listBackgroundAgents(config: ServerConfig): Promise<BackgroundAgentList> {
  try {
    return parseBackgroundAgentList(await machineRequest<unknown>(config, "/v1/background-agents?all=1"))
  } catch {
    return EMPTY
  }
}

const idPath = (id: string) => `/v1/background-agents/${encodeURIComponent(id)}`

export const backgroundAgentClient = {
  list: listBackgroundAgents,
  async start(config: ServerConfig, input: StartBackgroundAgentInput): Promise<{ id?: string; message?: string }> {
    return machineRequest(config, "/v1/background-agents", { method: "POST", body: input })
  },
  async stop(config: ServerConfig, id: string): Promise<void> {
    await machineRequest(config, `${idPath(id)}/stop`, { method: "POST", body: {} })
  },
  async resume(config: ServerConfig, id: string, prompt: string): Promise<void> {
    await machineRequest(config, `${idPath(id)}/resume`, { method: "POST", body: { prompt } })
  },
  async remove(config: ServerConfig, id: string): Promise<void> {
    await machineRequest(config, idPath(id), { method: "DELETE" })
  },
  async logs(config: ServerConfig, id: string): Promise<{ text: string; truncated: boolean }> {
    const result = await machineRequest<{ text?: unknown; truncated?: unknown }>(config, `${idPath(id)}/logs`)
    return { text: typeof result.text === "string" ? result.text : "", truncated: result.truncated === true }
  }
}

// ---- turning agents into the rows the rail already draws -------------------------------------------------------

/** The Claude harness on a machine, if it has one; background agents open as its Sessions. */
export function claudeAgentHost(agents: readonly MachineAgentHost[]): MachineAgentHost | undefined {
  return agents.find((agent) => agent.id === "claude") ?? agents.find((agent) => agent.backend === "claude")
}

export function backgroundAgentBySession(agents: readonly BackgroundAgent[]): Map<string, BackgroundAgent> {
  const map = new Map<string, BackgroundAgent>()
  for (const agent of agents) if (agent.sessionId) map.set(agent.sessionId, agent)
  return map
}

/**
 * The status the rail should show for a Session that is also a background agent. The CLI's own registry
 * knows what is running right now; the harness listing only knows the last message, so the agent wins.
 */
export function backgroundSessionStatus(agent: BackgroundAgent): NonNullable<NativeSessionRecord["status"]> {
  return { type: statusTypeForActivity(agent.activity), ...(agent.needs || agent.detail ? { message: agent.needs || agent.detail } : {}) }
}

/** A Session-shaped view of an agent whose conversation the harness listing does not (yet) contain. */
export function sessionFromBackgroundAgent(agent: BackgroundAgent): Session {
  const started = agent.startedAt ?? 0
  return {
    id: agent.sessionId ?? agent.key,
    title: agent.name,
    directory: agent.directory,
    time: { created: started, updated: agent.updatedAt ?? started },
    status: backgroundSessionStatus(agent)
  } as Session
}

/**
 * Rows for background agents that the ordinary Claude Session listing did not return (the harness is
 * asleep, or has not indexed the conversation yet). They open as Claude Sessions like any other.
 */
export function syntheticBackgroundRecords(
  agents: readonly BackgroundAgent[],
  knownSessionIds: ReadonlySet<string>,
  claude: MachineAgentHost,
  machineConfig: ServerConfig
): NativeSessionRecord[] {
  const config = nativeSessionConfig(machineConfig, claude)
  const missing = agents.filter((agent) => agent.sessionId && agent.capabilities.open && !knownSessionIds.has(agent.sessionId))
  return nativeSessionRecords(
    claude,
    config,
    missing.map(sessionFromBackgroundAgent),
    Object.fromEntries(missing.map((agent) => [agent.sessionId as string, backgroundSessionStatus(agent)]))
  )
}
