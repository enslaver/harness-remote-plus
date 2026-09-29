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
      for (const session of listed.json.slice(0, MAX_SESSIONS_PER_AGENT)) {
        if (!session || typeof session.id !== "string") continue
        sessions.push({
          agentId: agent.id,
          id: session.id,
          title: typeof session.title === "string" ? session.title : "",
          directory: typeof session.directory === "string" ? session.directory : "",
          status: statusType(session.status) ?? statusType(statuses[session.id]) ?? "unknown",
          createdAt: session.time?.created,
          updatedAt: session.time?.updated
        })
      }
    } catch {
      // One agent failing to answer must not hide the others, or stop the heartbeat.
    }
  }
  return sessions
}
