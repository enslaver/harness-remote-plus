// Pure helpers for the admin UI. Nothing here touches the DOM at import time, so Node can test it.
// Written for iOS 15+ Safari: no Array.prototype.at, Object.hasOwn, replaceAll or AbortSignal.timeout.

/** Builds an element. `props.on*` attach listeners; everything else becomes an attribute. Text is never parsed as HTML. */
export function h(tag, props, ...children) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (name.slice(0, 2) === "on" && typeof value === "function") element.addEventListener(name.slice(2), value)
    else if (name === "class") element.className = value
    else if (name === "text") element.textContent = value
    else element.setAttribute(name, value === true ? "" : String(value))
  }
  append(element, children)
  return element
}

function append(parent, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue
    if (Array.isArray(child)) append(parent, child)
    else parent.appendChild(typeof child === "object" && child.nodeType ? child : document.createTextNode(String(child)))
  }
}

export function ago(value, now) {
  if (!value) return "never"
  const time = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(time)) return "unknown"
  const seconds = Math.max(0, Math.round(((now === undefined ? Date.now() : now) - time) / 1000))
  if (seconds < 45) return "just now"
  if (seconds < 90) return "1 min ago"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + " min ago"
  const hours = Math.round(minutes / 60)
  if (hours < 36) return hours + " h ago"
  return Math.round(hours / 24) + " d ago"
}

export function clock(ms) {
  const date = new Date(ms)
  const pad = (n) => (n < 10 ? "0" : "") + n
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
}

export function clip(text, max) {
  const value = String(text === undefined || text === null ? "" : text)
  return value.length > max ? value.slice(0, max - 1) + "…" : value
}

/** Session status -> a small vocabulary the CSS knows. `waiting` needs a human, so it is its own tone. */
export function sessionTone(status) {
  if (status === "busy" || status === "retry") return "busy"
  if (status === "waiting") return "attention"
  if (status === "idle") return "idle"
  return "unknown"
}

// ---- what a Session is doing ---------------------------------------------------------------------------------
// The hub stores one vocabulary for every harness (see src/activity.js); these are its names and colours.

export const ACTIVITY_LABELS = {
  working: "Working", needs_input: "Needs you", idle: "Idle", completed: "Completed", failed: "Failed", stopped: "Stopped", gone: "Gone", unknown: "Unknown"
}
/** The order groups appear in when grouped by status: what needs a look first. */
export const ACTIVITY_ORDER = ["needs_input", "working", "failed", "completed", "stopped", "idle", "unknown", "gone"]
const ACTIVITY_TONE = { working: "busy", needs_input: "attention", completed: "ok", failed: "bad", stopped: "idle", idle: "idle", gone: "off", unknown: "unknown" }

export function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] || ACTIVITY_LABELS.unknown
}

export function activityTone(activity) {
  return ACTIVITY_TONE[activity] || "unknown"
}

export const GROUP_BY_LABELS = { none: "No grouping", status: "Status", machine: "Machine", project: "Project", agent: "Agent" }

function timeOf(value) {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : 0
}

function projectOf(session) {
  const directory = String(session.directory || "")
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return { key: session.machineId + ":" + directory, label: parts.length ? parts[parts.length - 1] : "No folder" }
}

/**
 * Splits already-fetched Sessions into groups: a plain recent feed, or by status, machine, project (folder) or
 * agent. Newest run first inside a group; groups ordered by their newest run (status groups by urgency).
 */
export function groupSessions(sessions, by) {
  const ranAt = (session) => timeOf(session.lastRanAt) || timeOf(session.startedAt) || timeOf(session.updatedAt)
  const sorted = sessions.slice().sort((a, b) => ranAt(b) - ranAt(a))
  if (by === "none" || !by) return sorted.length ? [{ key: "recent", label: "Recent", sessions: sorted, ranAt: ranAt(sorted[0]) }] : []
  const groups = []
  const index = new Map()
  for (const session of sorted) {
    let key, label
    if (by === "status") { key = session.activity || "unknown"; label = activityLabel(key) }
    else if (by === "machine") { key = session.machineId; label = session.machineName || session.machineId }
    else if (by === "agent") { key = session.agentId; label = session.agentId }
    else { const project = projectOf(session); key = project.key; label = project.label }
    if (!index.has(key)) { index.set(key, groups.length); groups.push({ key, label, activity: by === "status" ? key : undefined, sessions: [], ranAt: ranAt(session) }) }
    groups[index.get(key)].sessions.push(session)
  }
  if (by === "status") return groups.sort((a, b) => ACTIVITY_ORDER.indexOf(a.key) - ACTIVITY_ORDER.indexOf(b.key))
  return groups.sort((a, b) => b.ranAt - a.ranAt || String(a.label).localeCompare(String(b.label)))
}

export const RAN_WINDOWS = [["", "Any time"], ["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"]]
export const STARTED_WINDOWS = [["", "Any time"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]

/** The query the Sessions API takes, from the console's filter controls. Empty controls add nothing. */
export function sessionSearchParams(filters) {
  const params = new URLSearchParams()
  const set = (name, value) => { if (value) params.set(name, value) }
  set("q", String(filters.q || "").trim())
  set("activity", filters.activity)
  set("machine", filters.machine)
  set("agent", filters.agent)
  set("kind", filters.kind)
  set("ranAfter", filters.ranWithin)
  set("startedAfter", filters.startedWithin)
  set("sort", filters.sort === "started" ? "started" : "")
  params.set("limit", String(filters.limit || 200))
  return params
}

export function proxyState(machine) {
  const proxy = machine.proxy
  if (!proxy.enabled || !proxy.hasCredentials) return { tone: "off", label: "Web UI off", detail: "This machine kept its credentials; it can be seen here but not opened through the hub." }
  if (proxy.reachable === true) return { tone: "ok", label: "Web UI ready", detail: proxy.endpoint ? "Reached at " + proxy.endpoint + (proxy.latencyMs !== null && proxy.latencyMs !== undefined ? " (" + proxy.latencyMs + " ms)" : "") : "" }
  if (proxy.reachable === false) return { tone: "warn", label: "Not reachable", detail: proxy.error || "The hub could not reach this machine." }
  return { tone: "pending", label: "Checking…", detail: "The hub has not tried to reach this machine yet." }
}

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Quote for POSIX sh. A token or URL with a quote or `$(...)` in it must stay one inert word. */
export function shellQuote(value) {
  const text = String(value)
  return SAFE_SHELL_WORD.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'"
}

/** PowerShell single-quoted strings only need the quote doubled. */
export function powershellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** The one-liners shown on the Add machine page. The token rides in the environment, not argv, so it stays out of `ps`. */
export function installCommands({ installCommand, publicUrl, token }) {
  return {
    posix: "HARNESS_REMOTE_HUB_TOKEN=" + shellQuote(token) + " " + installCommand + " --hub " + shellQuote(publicUrl),
    powershell: "$env:HARNESS_REMOTE_HUB_TOKEN=" + powershellQuote(token) + "; " + installCommand + " --hub " + powershellQuote(publicUrl)
  }
}

export function pretty(value) {
  return JSON.stringify(value, null, 2)
}

export function parseRoute(hash) {
  const parts = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent)
  if (parts[0] === "machines" && parts[1]) return { name: "machine", id: parts[1] }
  if (["sessions", "logs", "enroll"].indexOf(parts[0]) >= 0) return { name: parts[0] }
  return { name: "machines" }
}

/**
 * Where to go after signing in, from `?next=`. Only a same-origin path: `//host`, `/\host`, absolute URLs
 * and `javascript:` all lead off-site, and a login page that redirects anywhere is an open redirect.
 * The console itself is excluded so a bad link cannot bounce the user in a circle.
 */
export function safeNext(search) {
  const value = new URLSearchParams(search || "").get("next")
  if (!value || value.charAt(0) !== "/" || value.charAt(1) === "/" || value.charAt(1) === "\\") return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  if (value === "/hub" || value.indexOf("/hub/") === 0 || value.indexOf("/hub?") === 0) return null
  return value
}
