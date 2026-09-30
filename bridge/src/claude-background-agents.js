import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Claude Code background agents (`claude --bg`), driven through the user's own `claude` CLI.
 *
 * This is deliberately separate from the ACP adapter the "claude" harness uses for interactive
 * Sessions: background agents are owned and supervised by the Claude CLI (a registry under
 * ~/.claude, a per-agent state file, terminal output you can attach to). The bridge does not
 * re-implement any of that. It asks the CLI what exists (`claude agents --json`), enriches it
 * with the agent's own state file, and forwards the few management verbs the CLI already has:
 * start (`--bg`), logs, stop, resume and remove. The conversation itself is an ordinary Claude
 * Session, so "attaching" from the workspace is opening that Session.
 *
 * Nothing here is stored. The CLI's registry is the single source of truth, which is what keeps
 * an agent started from a terminal, from the CLI's own agent view, or from this app the same agent.
 */

export const AGENT_ACTIVITIES = Object.freeze(["working", "needs_input", "idle", "completed", "failed", "stopped"])
/** Activities in which nothing is running any more. */
export const TERMINAL_ACTIVITIES = Object.freeze(["completed", "failed", "stopped"])

const SHORT_ID = /^[a-f0-9]{8}$/
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Wide enough for what other providers call a model: Bedrock inference-profile ARNs, Vertex's
// `claude-sonnet-4@20250514`, and a gateway's own names. It is a single argv element, never a shell
// string, so the one real hazard - a leading `-` read as a flag - is what the anchor rules out.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+=,\-[\]]{0,255}$/
// `bypassPermissions` is deliberately absent: a remote screen must not be able to start an
// unattended agent with every safety check off.
export const BACKGROUND_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "plan", "auto"])
const MAX_PROMPT_CHARS = 30_000 // stays under the Windows command-line limit
const MAX_NAME_CHARS = 80
const MAX_STATE_FILE_BYTES = 512 * 1024
const LIST_TIMEOUT_MS = 15_000
const ACTION_TIMEOUT_MS = 30_000
const LIST_MAX_BYTES = 4 * 1024 * 1024
const ACTION_MAX_BYTES = 512 * 1024
const LOGS_MAX_CHARS = 64 * 1024
const LIST_CACHE_MS = 3_000
const UNAVAILABLE_CACHE_MS = 5 * 60_000

const TERMINAL_STATES = new Map([
  ["done", "completed"],
  ["success", "completed"],
  ["succeeded", "completed"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["errored", "failed"],
  ["stopped", "stopped"],
  ["cancelled", "stopped"],
  ["canceled", "stopped"],
  ["killed", "stopped"]
])
const BLOCKED_STATES = new Set(["blocked", "waiting", "needs_input", "needs-input", "needs_you", "asked", "requires_action", "paused"])
const WORKING_STATES = new Set(["running", "working", "active", "busy", "shell", "starting", "queued", "in_progress", "in-progress"])

// Variables that identify the Claude session this process happens to be running inside (or its
// remote-control plumbing). A child `claude` that inherited them would attach to, and write into,
// the parent's session instead of managing its own agents. Credentials and CLAUDE_CONFIG_DIR are
// untouched: the child must still be able to sign in and find the same registry.
const PARENT_SESSION_ENV = /^(?:CLAUDE_CODE_(?:SESSION|REMOTE|MESSAGING|CONTAINER|WORKER|CHILD|SYNC_SESSION|POST_FOR_SESSION|USE_CCR|TEE_SDK|ENTRYPOINT|ENVIRONMENT_RUNNER|HOLD_|EXECPATH|DIAGNOSTICS)[A-Z0-9_]*|CLAUDE_PID|CLAUDECODE|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_SESSION_INGRESS_TOKEN_FILE)$/

export function childEnvironment(environment = process.env) {
  const cleaned = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || PARENT_SESSION_ENV.test(name)) continue
    cleaned[name] = value
  }
  return cleaned
}

function serviceError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

export function stripAnsi(text) {
  return String(text)
    // CSI sequences (colours, cursor movement) and OSC sequences (window titles, hyperlinks).
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "")
    .replace(/\r(?!\n)/g, "\n")
}

function text(value, limit) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, limit) : undefined
}

function epochMillis(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value)
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * One vocabulary for "what is this agent doing", shared with the workspace and the hub:
 * working, needs_input (blocked on a question or permission), idle (alive, waiting for the
 * next message), and the three ways an agent ends: completed, failed, stopped.
 *
 * Terminal states win over everything else: a state file can still say `tempo: active` for a
 * moment after the agent has finished, and "still working" on a finished agent is the worst
 * possible misreading.
 */
export function agentActivity({ state, status, tempo, needs, needsYou } = {}) {
  const rawState = typeof state === "string" ? state.trim().toLowerCase() : ""
  const rawStatus = typeof status === "string" ? status.trim().toLowerCase() : ""
  const terminal = TERMINAL_STATES.get(rawState) ?? TERMINAL_STATES.get(rawStatus)
  if (terminal) return terminal
  if (needsYou === true || (typeof needs === "string" && needs.trim()) || tempo === "blocked" || BLOCKED_STATES.has(rawState) || BLOCKED_STATES.has(rawStatus)) {
    return "needs_input"
  }
  if (WORKING_STATES.has(rawState) || WORKING_STATES.has(rawStatus) || tempo === "active") return "working"
  return "idle"
}

function capabilitiesFor(kind, activity, { hasSession, shortId }) {
  const terminal = TERMINAL_ACTIVITIES.includes(activity)
  const live = !terminal
  const background = kind === "background" && Boolean(shortId)
  return {
    // The conversation is an ordinary Claude Session: opening it is always possible when its id is known.
    open: hasSession,
    // Only an agent that is not running may be written to. A live one is being driven by its own
    // process; a second writer on the same transcript would fork it.
    prompt: hasSession && terminal,
    logs: background,
    stop: background && live,
    resume: background && hasSession && terminal,
    remove: background && terminal
  }
}

/**
 * Turns one entry of `claude agents --json` (plus the optional state file the CLI keeps for a
 * background agent) into the shape the workspace and the hub consume. Anything unrecognised is
 * dropped rather than guessed at; unknown extra fields are ignored so a newer CLI cannot break it.
 */
export function normalizeAgent(entry, { job, registry } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const kind = entry.kind === "background" || entry.kind === "bg" ? "background" : entry.kind === "interactive" ? "interactive" : undefined
  // `daemon` / `daemon-worker` are the CLI's own supervisor processes, not agents anyone asked for.
  if (!kind) return undefined

  const sessionId = typeof entry.sessionId === "string" && SESSION_ID.test(entry.sessionId) ? entry.sessionId.toLowerCase() : undefined
  const shortId = kind === "background"
    ? (typeof entry.id === "string" && SHORT_ID.test(entry.id) ? entry.id : sessionId?.slice(0, 8))
    : undefined
  const pid = Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : undefined
  if (kind === "background" && !shortId) return undefined
  if (kind === "interactive" && !sessionId && !pid) return undefined

  const enrichment = job ?? {}
  const activity = agentActivity({
    state: entry.state ?? enrichment.state,
    status: entry.status,
    tempo: enrichment.tempo,
    needs: enrichment.needs,
    needsYou: enrichment.needsYou
  })
  const startedAt = epochMillis(entry.startedAt) ?? epochMillis(enrichment.createdAt)
  const updatedAt = epochMillis(enrichment.lastTerminalAt) ?? epochMillis(enrichment.updatedAt) ?? epochMillis(registry?.updatedAt) ?? startedAt
  const name = text(entry.name, 200) || text(enrichment.intent, 200) || (sessionId ? `Agent ${sessionId.slice(0, 8)}` : "Agent")

  return {
    key: kind === "background" ? `background:${shortId}` : `interactive:${sessionId ?? pid}`,
    kind,
    id: shortId,
    sessionId,
    pid,
    name,
    directory: text(entry.cwd, 1024) ?? "",
    activity,
    rawState: text(entry.state ?? entry.status, 40),
    detail: text(enrichment.detail, 500) || undefined,
    needs: text(enrichment.needs, 500) || undefined,
    startedAt,
    updatedAt,
    worktree: enrichment.worktreePath ? { path: text(enrichment.worktreePath, 1024), branch: text(enrichment.worktreeBranch, 200) } : undefined,
    subagents: enrichment.subagents,
    capabilities: capabilitiesFor(kind, activity, { hasSession: Boolean(sessionId), shortId })
  }
}

/** `claude agents --json` prints a JSON array. Tolerate an `{ agents: [...] }` envelope as well. */
export function parseAgentsJson(output) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    throw serviceError("unsupported_output", "`claude agents --json` did not print JSON")
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : Array.isArray(parsed?.sessions) ? parsed.sessions : undefined
  if (!entries) throw serviceError("unsupported_output", "`claude agents --json` did not print a list")
  return entries
}

function summarizeFan(fan) {
  if (!Array.isArray(fan) || fan.length === 0) return undefined
  const agents = fan.filter((item) => item && typeof item === "object" && (item.kind === "agent" || item.kind === undefined))
  if (agents.length === 0) return undefined
  const failed = agents.filter((item) => item.failed === true).length
  const running = agents.filter((item) => item.failed !== true && !item.doneAt).length
  return { total: agents.length, running, failed }
}

/** The subset of an agent's own state file that is safe and useful to show. */
export function parseJobState(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return {
    state: typeof value.state === "string" ? value.state : undefined,
    tempo: value.tempo === "active" || value.tempo === "idle" || value.tempo === "blocked" ? value.tempo : undefined,
    detail: value.detail,
    needs: value.needs,
    needsYou: value.needs_you === true,
    intent: value.intent,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastTerminalAt: value.lastTerminalAt ?? value.firstTerminalAt ?? undefined,
    worktreePath: typeof value.worktreePath === "string" ? value.worktreePath : undefined,
    worktreeBranch: typeof value.worktreeBranch === "string" ? value.worktreeBranch : undefined,
    subagents: summarizeFan(value.fan)
  }
}

// Windows installs `claude` either as a native claude.exe or, via npm, as a .cmd shim that has to be
// run through cmd.exe. cmd.exe re-parses its arguments, so free text (a prompt) cannot be passed
// through a shim safely; refuse that instead of trying to escape it.
const SHIM_SAFE_ARGUMENT = /^[A-Za-z0-9_.:=+,/\\[\]@-]*$/

export function claudeInvocation(command, args, { platform = process.platform, environment = process.env } = {}) {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(command)) return { command, args }
  const unsafe = args.find((argument) => !SHIM_SAFE_ARGUMENT.test(argument))
  if (unsafe !== undefined) {
    throw serviceError(
      "unsafe_command",
      "This Claude installation is a .cmd shim, which cannot safely take free text. Point HARNESS_REMOTE_CLAUDE_COMMAND at claude.exe (the native install) to start or resume agents from here.",
      { status: 409 }
    )
  }
  return { command: environment.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
}

/** Runs a command to completion with a hard time and output limit. Never uses a shell. */
export function runCommand(command, args, { cwd, environment, timeoutMs = ACTION_TIMEOUT_MS, maxBytes = ACTION_MAX_BYTES, platform, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let invocation
    try {
      invocation = claudeInvocation(command, args, { platform, environment: environment ?? process.env })
    } catch (error) {
      resolve({ error })
      return
    }
    let child
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment(environment ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      })
    } catch (error) {
      resolve({ error })
      return
    }
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, truncated, timedOut, ...result })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    timer.unref?.()
    const collect = (name) => (chunk) => {
      const room = maxBytes - stdout.length - stderr.length
      if (room <= 0) {
        truncated = true
        child.kill("SIGKILL")
        return
      }
      const piece = String(chunk).slice(0, room)
      if (piece.length < String(chunk).length) truncated = true
      if (name === "stdout") stdout += piece
      else stderr += piece
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", collect("stdout"))
    child.stderr?.on("data", collect("stderr"))
    child.on("error", (error) => finish({ error }))
    child.on("close", (code, signal) => finish({ code, signal }))
  })
}

// On Windows a command that is not a native .exe is run through cmd.exe, which does not fail with ENOENT when
// the program is missing: it prints this and exits 1 (or 9009 from some shells). Without recognising it, "Claude
// Code is not installed" would look like a failure, and the "not installed" answer would never be remembered.
const CMD_NOT_RECOGNIZED = /is not recognized as an internal or external command/i

export function commandNotFound(result) {
  if (result?.error?.code === "ENOENT") return true
  if (!result || result.error) return false
  if (result.code === 9009) return true
  return result.code !== 0 && CMD_NOT_RECOGNIZED.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)
}

const AUTH_FAILURE = /not logged in|please run \/?login|invalid api key|invalid x-api-key|authentication[_ ]error|ExpiredToken|security token.*expired|unable to locate credentials|could not load credentials|credentials? (?:are |is )?(?:missing|not found|expired)|\b40[13]\b.*(?:unauthorized|forbidden)/i

function failureFrom(result, fallbackMessage) {
  if (commandNotFound(result)) {
    return serviceError("claude_not_found", "The `claude` command was not found on this machine. Install Claude Code, or set HARNESS_REMOTE_CLAUDE_COMMAND.", { status: 503 })
  }
  if (result.error?.code && result.error.code !== "ENOENT" && typeof result.error.status === "number") return result.error
  if (result.error) return serviceError("claude_failed", result.error.message || fallbackMessage, { status: 502 })
  if (result.timedOut) return serviceError("claude_timeout", `${fallbackMessage} (timed out)`, { status: 504 })
  const detail = stripAnsi(result.stderr || result.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400)
  // Whatever the provider - a `claude login`, an API key, Bedrock, Vertex, a gateway - the CLI says
  // when it cannot authenticate. Naming that lets the app say "sign in" instead of "failed".
  if (AUTH_FAILURE.test(detail)) return serviceError("claude_unauthenticated", detail, { status: 401 })
  return serviceError("claude_failed", detail || fallbackMessage, { status: 502 })
}

export function createBackgroundAgentService({
  command = process.env.HARNESS_REMOTE_CLAUDE_COMMAND || "claude",
  configDirectory = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  environment = process.env,
  run = runCommand,
  readText = (file) => readFile(file, "utf8"),
  now = Date.now,
  isAllowedDirectory
} = {}) {
  let cache = new Map()
  let unavailable

  const invoke = (args, options = {}) => run(command, args, { environment, ...options })

  async function readJob(shortId) {
    try {
      const raw = await readText(path.join(configDirectory, "jobs", shortId, "state.json"))
      if (typeof raw !== "string" || raw.length > MAX_STATE_FILE_BYTES) return undefined
      return parseJobState(raw)
    } catch {
      return undefined
    }
  }

  async function readRegistry(pid) {
    try {
      const value = JSON.parse(await readText(path.join(configDirectory, "sessions", `${pid}.json`)))
      return { updatedAt: value?.statusUpdatedAt ?? value?.updatedAt }
    } catch {
      return undefined
    }
  }

  async function fetchList(all) {
    const result = await invoke(["agents", "--json", ...(all ? ["--all"] : [])], { timeoutMs: LIST_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES })
    if (commandNotFound(result)) return { available: false, reason: "claude_not_found", agents: [] }
    if (result.error || result.timedOut || result.code !== 0) {
      const failure = failureFrom(result, "`claude agents --json` failed")
      // An older Claude Code has no `agents` command. That is "not supported here", not an outage.
      return { available: false, reason: /unknown command|unrecognized|did not match|invalid command/i.test(`${result.stderr}${result.stdout}`) ? "unsupported_version" : failure.code, message: failure.message, agents: [] }
    }
    let entries
    try {
      entries = parseAgentsJson(result.stdout)
    } catch (error) {
      return { available: false, reason: error.code, message: error.message, agents: [] }
    }
    const agents = []
    for (const entry of entries.slice(0, 500)) {
      const base = normalizeAgent(entry)
      if (!base) continue
      const job = base.kind === "background" ? await readJob(base.id) : undefined
      const registry = base.kind === "interactive" && base.pid ? await readRegistry(base.pid) : undefined
      agents.push(normalizeAgent(entry, { job, registry }))
    }
    agents.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    return { available: true, agents }
  }

  async function list({ all = true, force = false } = {}) {
    const stamp = now()
    if (unavailable && stamp - unavailable.at < UNAVAILABLE_CACHE_MS && !force) return unavailable.value
    const key = all ? "all" : "active"
    const cached = cache.get(key)
    if (cached && !force && (cached.pending || stamp - cached.at < LIST_CACHE_MS)) return cached.pending ?? cached.value
    const pending = fetchList(all).then((value) => {
      cache.set(key, { at: now(), value })
      if (!value.available && value.reason === "claude_not_found") unavailable = { at: now(), value }
      else unavailable = undefined
      return value
    }, (error) => {
      cache.delete(key)
      throw error
    })
    cache.set(key, { at: stamp, pending })
    return pending
  }

  const invalidate = () => {
    cache = new Map()
    unavailable = undefined
  }

  /** Directory problems are the caller's to fix, not server faults: say which kind. */
  async function resolveDirectory(directory) {
    if (!isAllowedDirectory) return directory
    try {
      return await isAllowedDirectory(directory)
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw serviceError("invalid_request", "That directory does not exist on this machine", { status: 400 })
      }
      throw serviceError("directory_not_allowed", error instanceof Error ? error.message : "Directory not allowed", { status: 403 })
    }
  }

  function requireShortId(id) {
    if (typeof id !== "string" || !SHORT_ID.test(id)) throw serviceError("invalid_request", "A background agent id is 8 lowercase hex characters", { status: 400 })
    return id
  }

  async function ensureAvailable() {
    const listed = await list({ all: false })
    if (!listed.available) {
      throw serviceError(
        listed.reason === "claude_not_found" ? "claude_not_found" : "background_unavailable",
        listed.reason === "claude_not_found"
          ? "The `claude` command was not found on this machine. Install Claude Code, or set HARNESS_REMOTE_CLAUDE_COMMAND."
          : listed.message || "This version of Claude Code does not support background agents. Update Claude Code.",
        { status: 503 }
      )
    }
  }

  function promptText(value) {
    const prompt = typeof value === "string" ? value.trim() : ""
    if (!prompt) throw serviceError("invalid_request", "A prompt is required", { status: 400 })
    if (prompt.length > MAX_PROMPT_CHARS) throw serviceError("invalid_request", `A prompt can be at most ${MAX_PROMPT_CHARS} characters`, { status: 400 })
    return prompt
  }

  function startOptions(input) {
    const args = []
    if (input.name !== undefined && input.name !== null && input.name !== "") {
      const name = text(input.name, MAX_NAME_CHARS)
      if (!name) throw serviceError("invalid_request", "The agent name is not valid", { status: 400 })
      args.push("--name", name)
    }
    if (input.model !== undefined && input.model !== null && input.model !== "") {
      if (typeof input.model !== "string" || !MODEL_NAME.test(input.model)) throw serviceError("invalid_request", "The model name is not valid", { status: 400 })
      args.push("--model", input.model)
    }
    if (input.permissionMode !== undefined && input.permissionMode !== null && input.permissionMode !== "") {
      if (!BACKGROUND_PERMISSION_MODES.includes(input.permissionMode)) {
        throw serviceError("invalid_request", `Permission mode must be one of ${BACKGROUND_PERMISSION_MODES.join(", ")}`, { status: 400 })
      }
      args.push("--permission-mode", input.permissionMode)
    }
    return args
  }

  function announcedId(result) {
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    return /\b([a-f0-9]{8})\b/.exec(output)?.[1]
  }

  return {
    command,
    list,
    invalidate,

    async get(id) {
      requireShortId(id)
      const listed = await list({ all: true })
      return listed.agents.find((agent) => agent.kind === "background" && agent.id === id)
    },

    /** Starts a background agent in `directory` (which must be inside the configured roots). */
    async start(input = {}) {
      const prompt = promptText(input.prompt)
      const directory = typeof input.directory === "string" && input.directory ? input.directory : ""
      if (!directory) throw serviceError("invalid_request", "A directory is required", { status: 400 })
      const allowed = await resolveDirectory(directory)
      const options = startOptions(input)
      await ensureAvailable()
      // `--` ends option parsing, so a prompt that starts with a dash is still just a prompt.
      const result = await invoke(["--bg", ...options, "--", prompt], { cwd: allowed })
      if (result.error || result.timedOut || result.code !== 0) throw failureFrom(result, "Claude could not start the background agent")
      invalidate()
      const id = announcedId(result)
      return { id, message: stripAnsi(result.stdout).trim().slice(0, 500) }
    },

    /** Continues a finished agent's conversation in the background under the same id. */
    async resume(id, input = {}) {
      requireShortId(id)
      const prompt = promptText(input.prompt)
      const agent = await this.get(id)
      if (!agent) throw serviceError("unknown_agent", `Unknown background agent: ${id}`, { status: 404 })
      if (!agent.capabilities.resume) throw serviceError("agent_active", "Only a finished agent can be continued in the background. Stop it first.", { status: 409 })
      const allowed = agent.directory ? await resolveDirectory(agent.directory) : undefined
      const result = await invoke(["--bg", ...startOptions(input), "--resume", agent.sessionId, "--", prompt], { cwd: allowed })
      if (result.error || result.timedOut || result.code !== 0) throw failureFrom(result, "Claude could not continue the background agent")
      invalidate()
      return { id: announcedId(result) ?? id, message: stripAnsi(result.stdout).trim().slice(0, 500) }
    },

    async stop(id) {
      requireShortId(id)
      const agent = await this.get(id)
      if (!agent) throw serviceError("unknown_agent", `Unknown background agent: ${id}`, { status: 404 })
      if (!agent.capabilities.stop) throw serviceError("agent_finished", "That agent has already finished", { status: 409 })
      const result = await invoke(["stop", id])
      if (result.error || result.timedOut || result.code !== 0) throw failureFrom(result, "Claude could not stop the agent")
      invalidate()
      return { id }
    },

    /**
     * Deletes a finished agent. The CLI refuses when its worktree still holds unpushed work and tells
     * you which extra flag would override that; those flags are never passed from here, so a remote
     * click can never discard someone's unpushed commits.
     */
    async remove(id) {
      requireShortId(id)
      const agent = await this.get(id)
      if (!agent) throw serviceError("unknown_agent", `Unknown background agent: ${id}`, { status: 404 })
      if (!agent.capabilities.remove) throw serviceError("agent_active", "Stop the agent before removing it", { status: 409 })
      const result = await invoke(["rm", id])
      if (result.error || result.timedOut || result.code !== 0) {
        const failure = failureFrom(result, "Claude could not remove the agent")
        failure.status = failure.status === 502 ? 409 : failure.status
        throw failure
      }
      invalidate()
      return { id }
    },

    /** The agent's recent terminal output, colour codes removed, newest part kept. */
    async logs(id) {
      requireShortId(id)
      const result = await invoke(["logs", id], { timeoutMs: LIST_TIMEOUT_MS, maxBytes: ACTION_MAX_BYTES })
      if (result.error || result.timedOut || result.code !== 0) throw failureFrom(result, "Claude could not read the agent's output")
      const cleaned = stripAnsi(result.stdout)
      const truncated = result.truncated || cleaned.length > LOGS_MAX_CHARS
      return { id, text: truncated ? cleaned.slice(-LOGS_MAX_CHARS) : cleaned, truncated }
    }
  }
}
