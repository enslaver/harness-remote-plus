import { requestJson } from "./http-json.js"

const MAX_SESSIONS_PER_AGENT = 200
const REQUEST_TIMEOUT_MS = 5_000

function basic(username, password) {
  return username ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` } : {}
}

function loopbackHost(host) {
  if (!host || host === "0.0.0.0") return "127.0.0.1"
  if (host === "::") return "::1"
  return host
}

export function localBaseUrl(config) {
  const host = loopbackHost(config.host)
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`
}

// The raw status words harnesses use, mapped onto the one vocabulary the app and the hub share.
const ACTIVITY_BY_STATUS = new Map([
  ["busy", "working"], ["retry", "working"], ["running", "working"], ["working", "working"], ["active", "working"],
  ["waiting", "needs_input"], ["blocked", "needs_input"],
  ["idle", "idle"],
  ["done", "completed"], ["completed", "completed"],
  ["failed", "failed"], ["error", "failed"],
  ["stopped", "stopped"], ["cancelled", "stopped"]
])
export function sessionActivity(status) {
  return ACTIVITY_BY_STATUS.get(String(status ?? "").toLowerCase()) ?? "unknown"
}

function statusType(value) {
  if (typeof value === "string") return value
  if (value && typeof value.type === "string") return value.type
  return undefined
}

/**
 * Reads this machine's Session index back from its own gateway, over loopback, using the exact routes
 * the web app uses (`experimental/session` is the lightweight index; the transcript is never read).
 *
 * The one rule that matters: only ask agents that are already running (`state: "available"`).
 * Harnesses start lazily on purpose (a Bun server, an ACP adapter process), and listing a sleeping
 * one would wake it. A monitor that spins up every agent on every machine every 30 seconds would be
 * worse than no monitor. Agents that have not been used simply have no sessions to report yet.
 */
export async function collectSessions({ config, agents, scoped, request = requestJson }) {
  const base = localBaseUrl(config)
  const headers = basic(config.username, config.password)
  const sessions = []
  // Agents whose list came back whole. Only for those can the hub tell "gone" from "not asked".
  const completeAgents = []
  for (const agent of agents) {
    if (agent.state !== "available") continue
    const prefix = scoped ? `/v1/agents/${encodeURIComponent(agent.id)}` : ""
    try {
      const listed = await request(`${base}${prefix}/experimental/session`, { headers, timeoutMs: REQUEST_TIMEOUT_MS })
      if (listed.status !== 200 || !Array.isArray(listed.json)) continue
      // OpenCode's listing omits status; every harness serves /session/status as a separate map.
      const statuses = await request(`${base}${prefix}/session/status`, { headers, timeoutMs: REQUEST_TIMEOUT_MS })
        .then((response) => (response.status === 200 && response.json && typeof response.json === "object" ? response.json : {}))
        .catch(() => ({}))
      if (listed.json.length <= MAX_SESSIONS_PER_AGENT && !listed.headers?.["x-next-cursor"]) completeAgents.push(agent.id)
      for (const session of listed.json.slice(0, MAX_SESSIONS_PER_AGENT)) {
        if (!session || typeof session.id !== "string") continue
        const status = statusType(session.status) ?? statusType(statuses[session.id]) ?? "unknown"
        sessions.push({
          agentId: agent.id,
          id: session.id,
          kind: "session",
          // The hub keeps 300 / 1024 characters; sending more only risks an oversized heartbeat.
          title: typeof session.title === "string" ? session.title.slice(0, 300) : "",
          directory: typeof session.directory === "string" ? session.directory.slice(0, 1024) : "",
          status,
          activity: sessionActivity(status),
          // When it started and when it last ran, as the harness knows them.
          startedAt: session.time?.created,
          lastRanAt: session.time?.updated,
          createdAt: session.time?.created,
          updatedAt: session.time?.updated
        })
      }
    } catch {
      // One agent failing to answer must not hide the others, or stop the heartbeat.
    }
  }

  const claude = await collectClaudeAgents({ base, headers, request })
  if (claude) {
    const merged = new Map(sessions.map((session) => [`${session.agentId}\u0000${session.id}`, session]))
    for (const entry of claude.sessions) {
      const key = `${entry.agentId}\u0000${entry.id}`
      const known = merged.get(key)
      // The CLI's own registry knows what is running right now; the ACP listing knows the title and history.
      merged.set(key, known ? { ...known, ...entry, title: known.title || entry.title, startedAt: known.startedAt ?? entry.startedAt } : entry)
    }
    sessions.length = 0
    sessions.push(...merged.values())
    // "claude" can only be called complete if its ordinary Session list was also complete (or Claude has no
    // ordinary list here because its ACP agent is asleep, in which case nothing is claimed either).
    if (!completeAgents.includes("claude")) claude.complete = false
    if (!claude.complete) {
      const index = completeAgents.indexOf("claude")
      if (index !== -1) completeAgents.splice(index, 1)
    }
  }
  return { sessions, completeAgents }
}

/**
 * Claude Code background agents and running terminal sessions, from the machine's own
 * `/v1/background-agents` route (which asks the `claude` CLI; nothing is started to answer).
 * Returns `undefined` when the machine has none of it (no Claude Code, an older daemon).
 */
async function collectClaudeAgents({ base, headers, request }) {
  try {
    const response = await request(`${base}/v1/background-agents?all=1`, { headers, timeoutMs: REQUEST_TIMEOUT_MS })
    if (response.status !== 200 || !response.json?.available || !Array.isArray(response.json.agents)) return undefined
    const sessions = []
    for (const agent of response.json.agents.slice(0, MAX_SESSIONS_PER_AGENT)) {
      if (!agent || typeof agent.activity !== "string") continue
      const id = typeof agent.sessionId === "string" ? agent.sessionId : agent.key
      if (typeof id !== "string") continue
      sessions.push({
        agentId: "claude",
        id,
        kind: agent.kind === "background" ? "background" : "session",
        title: typeof agent.name === "string" ? agent.name.slice(0, 300) : "",
        directory: typeof agent.directory === "string" ? agent.directory.slice(0, 1024) : "",
        status: typeof agent.rawState === "string" ? agent.rawState : agent.activity,
        activity: agent.activity,
        detail: typeof (agent.needs ?? agent.detail) === "string" ? (agent.needs ?? agent.detail).slice(0, 300) : undefined,
        startedAt: agent.startedAt,
        lastRanAt: agent.updatedAt,
        createdAt: agent.startedAt,
        updatedAt: agent.updatedAt
      })
    }
    return { sessions, complete: response.json.agents.length <= MAX_SESSIONS_PER_AGENT }
  } catch {
    return undefined
  }
}
