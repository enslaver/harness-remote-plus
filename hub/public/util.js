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
