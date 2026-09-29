/**
 * Everything a machine sends is untrusted input from the hub's point of view: a token proves the
 * caller enrolled, not that the payload is well-formed or harmless. These functions normalise it into
 * bounded, plain values before it reaches SQL, Loki labels, or the admin UI.
 */

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ValidationError"
  }
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
const SECRET_KEY_PATTERN = /pass(word)?|secret|token|credential|authorization|api[-_]?key|private/i
const MAX_ENDPOINTS = 8
const MAX_SESSIONS_PER_AGENT = 500
const MAX_SESSIONS = 2_000
const MAX_AGENTS = 32
const MAX_CONFIG_BYTES = 16 * 1024

function text(value, max, fallback = "") {
  if (typeof value !== "string") return fallback
  // Control characters have no business in a name or title and can corrupt terminal/log output.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned
}

function optionalText(value, max) {
  const cleaned = text(value, max)
  return cleaned || null
}

export function machineId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError("machine.id is missing or malformed")
  return value
}

/**
 * Link-local space (169.254.0.0/16, fe80::/10) hosts cloud metadata services and has no legitimate
 * use as a Harness gateway address. Refusing it outright removes the most valuable SSRF target even
 * before the prober's identity check would have rejected it.
 */
export function isForbiddenEndpointHost(hostname) {
  // `metadata.google.internal.` (a trailing dot is the same name) must not slip past an exact match.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "")
  if (FORBIDDEN_NAMES.has(host)) return true
  // The URL parser has already canonicalised decimal/hex/octal IPv4 spellings to dotted quads.
  if (/^169\.254\./.test(host)) return true
  if (!host.includes(":")) return false

  const groups = ipv6Groups(host)
  if (!groups) return true // an IPv6 literal we cannot read is not one we should connect to
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // AWS's IPv6 instance-metadata endpoint, fd00:ec2::254 (the whole fd00:ec2::/32 is AWS's).
  if (groups[0] === 0xfd00 && groups[1] === 0x0ec2) return true
  // IPv4 smuggled inside IPv6: ::ffff:a.b.c.d (mapped, which URL prints as ::ffff:a9fe:a9fe), the
  // deprecated ::a.b.c.d form, NAT64's 64:ff9b::a.b.c.d and its local-use 64:ff9b:1::/48 (both carry the
  // IPv4 address in the last 32 bits), and 6to4's 2002:a.b.c.d::/16 (the address follows the prefix).
  const embedsIPv4 = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && (groups.slice(2, 6).every((group) => group === 0) || groups[2] === 1)
  if ((embedsIPv4 || nat64) && isLinkLocalV4(groups[6], groups[7])) return true
  if (groups[0] === 0x2002 && isLinkLocalV4(groups[1], groups[2])) return true
  return false
}

const FORBIDDEN_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal"
])

function isLinkLocalV4(high, low) {
  return high >> 8 === 169 && (high & 0xff) === 254 && Number.isInteger(low)
}

/** Expands an IPv6 literal into its eight 16-bit groups, or null if it is malformed. */
function ipv6Groups(host) {
  let value = host
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    if ([a, b, c, d].some((octet) => octet > 255)) return null
    value = `${value.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = value.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  return groups.every(Number.isInteger) ? groups : null
}

export function endpointUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== "/" && url.pathname !== "") return null
  if (!url.hostname || isForbiddenEndpointHost(url.hostname)) return null
  return url.origin
}

export function endpointList(value) {
  if (!Array.isArray(value)) return []
  const unique = new Set()
  for (const candidate of value) {
    const normalized = endpointUrl(candidate)
    if (normalized) unique.add(normalized)
    if (unique.size >= MAX_ENDPOINTS) break
  }
  return [...unique]
}

/** Drops anything secret-looking, recursively. The machine is asked not to send secrets; this is the backstop. */
export function scrubConfig(value, depth = 0) {
  if (depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => scrubConfig(item, depth + 1))
  if (value && typeof value === "object") {
    const result = {}
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      if (SECRET_KEY_PATTERN.test(key)) continue
      result[text(key, 64)] = scrubConfig(item, depth + 1)
    }
    return result
  }
  if (typeof value === "string") return text(value, 1_024)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  return null
}

export function configObject(value) {
  const scrubbed = value && typeof value === "object" && !Array.isArray(value) ? scrubConfig(value) : {}
  if (Buffer.byteLength(JSON.stringify(scrubbed), "utf8") > MAX_CONFIG_BYTES) throw new ValidationError("config is too large")
  return scrubbed
}

const AGENT_STATES = new Set(["configured", "available", "unavailable"])

export function agentList(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_AGENTS).flatMap((agent) => {
    const id = text(agent?.id, 64)
    if (!id) return []
    return [{
      id,
      label: text(agent.label, 96) || id,
      backend: text(agent.backend, 64) || id,
      transport: text(agent.transport, 16) || "acp",
      state: AGENT_STATES.has(agent.state) ? agent.state : "configured"
    }]
  })
}

export function statsObject(value) {
  const stats = {}
  if (!value || typeof value !== "object") return stats
  for (const key of ["uptimeSeconds", "rss", "heapUsed", "sseClients", "droppedLogLines"]) {
    if (Number.isFinite(value[key])) stats[key] = Math.max(0, Math.trunc(value[key]))
  }
  return stats
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null
  const date = typeof value === "number" ? new Date(value) : new Date(String(value))
  const ms = date.getTime()
  // 0 is how the bridge reports "the harness gave no timestamp"; storing 1970 would sort it wrong.
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 86_400_000) return null
  return date.toISOString()
}

export function sessionList(value) {
  if (!Array.isArray(value)) return []
  const perAgent = new Map()
  const sessions = []
  for (const session of value) {
    const agentId = text(session?.agentId, 64)
    const id = text(session?.id, 256)
    if (!agentId || !id) continue
    const count = perAgent.get(agentId) ?? 0
    if (count >= MAX_SESSIONS_PER_AGENT) continue
    perAgent.set(agentId, count + 1)
    sessions.push({
      agent_id: agentId,
      session_id: id,
      title: text(session.title, 300),
      directory: text(session.directory, 1_024),
      status: text(session.status, 32) || "unknown",
      created_at: timestamp(session.createdAt),
      updated_at: timestamp(session.updatedAt)
    })
    if (sessions.length >= MAX_SESSIONS) break
  }
  return sessions
}

/**
 * Agents whose Session list this heartbeat carries IN FULL. Only for those may the hub conclude that a
 * Session missing from the list is gone; an agent that was asleep (not listed at all) or whose list was
 * cut short must not have its Sessions marked gone.
 */
export function sessionAgentList(value) {
  if (!Array.isArray(value)) return []
  const ids = new Set()
  for (const candidate of value.slice(0, MAX_AGENTS)) {
    const id = text(candidate, 64)
    if (id) ids.add(id)
  }
  return [...ids]
}

export function credentialsObject(value) {
  if (!value || typeof value !== "object") return null
  const username = typeof value.username === "string" ? value.username : ""
  const password = typeof value.password === "string" ? value.password : ""
  if (!username || !password || username.length > 256 || password.length > 1_024) return null
  return { username, password }
}

/**
 * `partial` is for heartbeats: a field the machine did not mention is `null`, meaning "leave what you
 * already have". Enrollment is complete by definition, so it falls back to the hostname, then the id.
 */
export function machineInfo(value, { partial = false } = {}) {
  const info = value && typeof value === "object" ? value : {}
  const id = machineId(info.id)
  const name = text(info.name, 128) || text(info.hostname, 128)
  return {
    id,
    name: name || (partial ? null : id),
    hostname: optionalText(info.hostname, 255),
    platform: optionalText(info.platform, 32),
    arch: optionalText(info.arch, 32),
    nodeVersion: optionalText(info.nodeVersion, 32),
    clientVersion: optionalText(info.version, 32)
  }
}

export const LOG_STREAMS = new Set(["stdout", "stderr", "event"])
const MAX_LOG_ENTRIES = 1_000
const MAX_LOG_LINE = 8_192

export function logEntries(value, now = Date.now()) {
  if (!Array.isArray(value)) throw new ValidationError("entries must be an array")
  if (value.length > MAX_LOG_ENTRIES) throw new ValidationError(`at most ${MAX_LOG_ENTRIES} entries per batch`)
  const entries = []
  for (const entry of value) {
    const line = typeof entry?.line === "string" ? entry.line : ""
    if (!line) continue
    const parsed = typeof entry.ts === "number" ? entry.ts : Date.parse(entry.ts)
    // A clock that is wildly wrong must not be able to write into next week or a compacted past.
    const ts = Number.isFinite(parsed) && Math.abs(parsed - now) < 6 * 86_400_000 ? parsed : now
    entries.push({
      ts,
      line: line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line,
      stream: LOG_STREAMS.has(entry.stream) ? entry.stream : "stdout",
      source: text(entry.source, 32).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "daemon",
      level: ["debug", "info", "warn", "error"].includes(entry.level) ? entry.level : undefined
    })
  }
  return entries
}

const CLIENT_LEVELS = new Set(["debug", "info", "warn", "error"])

/** Browser-side errors reported by the web app. Bounded hard: this endpoint is reachable from any page script. */
export function clientLogEntries(value, now = Date.now()) {
  if (!Array.isArray(value)) throw new ValidationError("entries must be an array")
  if (value.length > 20) throw new ValidationError("at most 20 entries per batch")
  return value.flatMap((entry) => {
    const message = text(entry?.message, 2_000)
    if (!message) return []
    const strip = (candidate) => text(String(candidate ?? "").split(/[?#]/)[0], 300)
    const line = JSON.stringify({
      message,
      ...(entry.stack ? { stack: text(entry.stack, 4_000) } : {}),
      ...(entry.url ? { url: strip(entry.url) } : {}),
      ...(entry.userAgent ? { userAgent: text(entry.userAgent, 300) } : {}),
      ...(entry.context && typeof entry.context === "object" ? { context: scrubConfig(entry.context) } : {})
    })
    return [{ ts: now, level: CLIENT_LEVELS.has(entry.level) ? entry.level : "error", line: line.length > 8_192 ? line.slice(0, 8_192) : line }]
  })
}
