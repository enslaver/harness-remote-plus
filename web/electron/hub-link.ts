import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DesktopHubMachine, DesktopHubState } from "./ipc-contract.js"

/** The user sent with Basic auth so the stock request transport can carry a hub machine token. */
export const HUB_MACHINE_BASIC_USER = "hub-machine"
export const HUB_PROFILE_PREFIX = "hub:"
const POLL_MS = 30_000
const RETRY_MS = 10_000
const FETCH_TIMEOUT_MS = 5_000
const BASE_PATH = /^\/m\/[^/?#]+$/

export type HubLinkSettings = { url: string; enrollmentToken: string }

/** `host:port`, `host` or a full http(s) URL -> the hub's origin, or throws a message fit for the form. */
export function normalizeHubAddress(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) throw new Error("Enter the hub address, for example hub.local:8080")
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error("That is not a valid hub address")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The hub address must be http or https")
  if (url.username || url.password) throw new Error("Do not put credentials in the hub address; use the enrollment token field")
  if (url.search || url.hash) throw new Error("The hub address must not include a query or fragment")
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

export function validateEnrollmentToken(input: unknown): string {
  const token = typeof input === "string" ? input.trim() : ""
  if (token.length < 16) throw new Error("The enrollment token is at least 16 characters")
  if (token.length > 512 || /[\u0000- \u007f]/.test(token)) throw new Error("The enrollment token is invalid")
  return token
}

/** One machine as the hub lists it -> a registry profile reached through the hub's proxy. */
export function hubMachineProfile(entry: unknown, hubUrl: string, machineToken: string): { profile: Record<string, unknown>; machine: DesktopHubMachine } | null {
  if (!entry || typeof entry !== "object") return null
  const candidate = entry as { id?: unknown; name?: unknown; status?: unknown; basePath?: unknown; proxyReady?: unknown }
  if (typeof candidate.id !== "string" || !candidate.id || typeof candidate.basePath !== "string" || !BASE_PATH.test(candidate.basePath)) return null
  const url = new URL(hubUrl)
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  const profileId = `${HUB_PROFILE_PREFIX}${candidate.id}`
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : candidate.id
  const prefix = url.pathname.replace(/\/+$/, "")
  return {
    profile: {
      id: profileId,
      backend: "opencode",
      host: `${url.protocol}//${url.hostname}`,
      port,
      username: HUB_MACHINE_BASIC_USER,
      password: machineToken,
      basePath: `${prefix}${candidate.basePath}`
    },
    machine: {
      profileId,
      name,
      status: typeof candidate.status === "string" ? candidate.status : "unknown",
      host: `${url.protocol}//${url.hostname}`,
      port,
      basePath: `${prefix}${candidate.basePath}`
    }
  }
}

type SavedHubState = { url?: unknown; machineId?: unknown; machineToken?: unknown }

export type HubLinkOptions = {
  /** Where the desktop keeps its own settings (the saved address and enrollment token). */
  settingsPath: string
  /** The embedded daemon's state directory; its `hub.json` holds the token it got when it enrolled. */
  daemonStateDirectory: string
  environment: () => NodeJS.ProcessEnv
  /** Install (or, with null, remove) a main-owned profile. */
  setProfile: (id: string, profile: Record<string, unknown> | null) => void
  /** The embedded daemon has to be restarted to pick up a new address or token. */
  restartDaemon: () => Promise<void>
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export class HubLink {
  private settings: HubLinkSettings | null = null
  private machines: DesktopHubMachine[] = []
  private installed = new Set<string>()
  private status: DesktopHubState["status"] = "off"
  private error: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private stopped = false

  constructor(private readonly options: HubLinkOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private environmentSettings(): HubLinkSettings | null {
    const env = this.options.environment()
    const url = env.HARNESS_REMOTE_HUB_URL?.trim()
    if (!url) return null
    try {
      return { url: normalizeHubAddress(url), enrollmentToken: env.HARNESS_REMOTE_HUB_TOKEN?.trim() ?? "" }
    } catch {
      return null
    }
  }

  /** The environment wins: whoever set it there meant it, and the form must not silently disagree. */
  private effective(): { settings: HubLinkSettings | null; source: DesktopHubState["source"] } {
    const fromEnvironment = this.environmentSettings()
    if (fromEnvironment) return { settings: fromEnvironment, source: "environment" }
    if (this.settings) return { settings: this.settings, source: "saved" }
    // This computer's runtime is already enrolled with a hub (it ran `--hub` once, or is the hub's own host):
    // the app follows it, with no form to fill in. The daemon holds the token; the app needs none of its own.
    if (this.daemonState) return { settings: { url: this.daemonState.url, enrollmentToken: "" }, source: "daemon" }
    return { settings: null, source: "none" }
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as { url?: unknown; enrollmentToken?: unknown }
      this.settings = { url: normalizeHubAddress(parsed.url), enrollmentToken: validateEnrollmentToken(parsed.enrollmentToken) }
    } catch {
      this.settings = null
    }
    await this.refreshDaemonState()
  }

  /** What the embedded daemon should be started with, on top of its own environment. */
  daemonEnvironment(): NodeJS.ProcessEnv {
    if (this.environmentSettings() || !this.settings) return {}
    return { HARNESS_REMOTE_HUB_URL: this.settings.url, HARNESS_REMOTE_HUB_TOKEN: this.settings.enrollmentToken }
  }

  state(): DesktopHubState {
    const { settings, source } = this.effective()
    return {
      configured: settings !== null,
      url: settings?.url ?? null,
      source,
      // The token never leaves main; the form only learns whether one is in place.
      tokenSet: Boolean(settings?.enrollmentToken) || this.daemonState !== null,
      status: settings ? this.status : "off",
      ...(this.error ? { error: this.error } : {}),
      machines: [...this.machines]
    }
  }

  async configure(input: { url: unknown; token: unknown }): Promise<DesktopHubState> {
    if (this.environmentSettings()) throw new Error("The hub is set by HARNESS_REMOTE_HUB_URL in this app's environment; change it there")
    const settings = { url: normalizeHubAddress(input.url), enrollmentToken: validateEnrollmentToken(input.token) }
    await this.save(settings)
    this.settings = settings
    return this.reconfigured()
  }

  async clear(): Promise<DesktopHubState> {
    if (this.effective().source === "daemon") throw new Error("This computer's runtime is enrolled with the hub on its own; stop it with --no-hub or delete the machine in the hub console")
    if (this.environmentSettings()) throw new Error("The hub is set by HARNESS_REMOTE_HUB_URL in this app's environment; unset it there")
    await writeFile(this.options.settingsPath, "{}\n", { mode: 0o600 }).catch(() => undefined)
    this.settings = null
    return this.reconfigured()
  }

  private async save(settings: HubLinkSettings): Promise<void> {
    await mkdir(dirname(this.options.settingsPath), { recursive: true })
    const temporary = `${this.options.settingsPath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 })
    await rename(temporary, this.options.settingsPath)
  }

  private async reconfigured(): Promise<DesktopHubState> {
    this.dropMachines()
    this.status = this.effective().settings ? "enrolling" : "off"
    this.error = undefined
    try {
      await this.options.restartDaemon()
    } catch (error) {
      this.options.log?.(`hub: could not restart the local runtime: ${error instanceof Error ? error.message : "unknown error"}`)
    }
    this.schedule(0)
    return this.state()
  }

  /** Cached copy of the daemon's `hub.json`, refreshed on every poll. */
  private daemonState: { url: string; machineId?: string; machineToken: string } | null = null

  private async refreshDaemonState(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.options.daemonStateDirectory, "hub.json"), "utf8")) as SavedHubState
      this.daemonState = typeof saved.url === "string" && typeof saved.machineToken === "string" && saved.machineToken
        ? { url: saved.url, machineToken: saved.machineToken, ...(typeof saved.machineId === "string" ? { machineId: saved.machineId } : {}) }
        : null
    } catch {
      this.daemonState = null
    }
  }

  private dropMachines(): void {
    for (const id of this.installed) this.options.setProfile(id, null)
    this.installed.clear()
    this.machines = []
  }

  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    clearTimeout(this.timer)
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => void this.poll(), delay)
  }

  /** Never throws; every failure becomes a status the form can show, and the next poll tries again. */
  async poll(): Promise<void> {
    const generation = ++this.generation
    const { settings } = this.effective()
    if (!settings) {
      this.dropMachines()
      this.status = "off"
      this.error = undefined
      return
    }
    await this.refreshDaemonState()
    const daemon = this.daemonState
    // The daemon enrolls on its own, a moment after it starts; until it has, there is no token to ask with.
    if (!daemon || daemon.url !== settings.url) {
      this.status = "enrolling"
      this.schedule(RETRY_MS / 2)
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(`${settings.url}/api/v1/fleet`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${daemon.machineToken}` },
        redirect: "manual",
        signal: controller.signal
      })
      if (generation !== this.generation) return
      if (response.status === 401) throw new Error("The hub no longer accepts this machine's token. Re-enter the enrollment token.")
      if (!response.ok) throw new Error(`The hub answered HTTP ${response.status}`)
      const body = await response.json() as { hub?: unknown; machines?: unknown }
      if (body.hub !== true || !Array.isArray(body.machines)) throw new Error("That address is not a Harness Remote Hub")
      const next = new Map<string, { profile: Record<string, unknown>; machine: DesktopHubMachine }>()
      for (const entry of body.machines) {
        const mapped = hubMachineProfile(entry, settings.url, daemon.machineToken)
        // This machine is already the app's local runtime; listing it twice would be noise.
        if (mapped && (entry as { id: string }).id !== daemon.machineId) next.set(mapped.machine.profileId, mapped)
      }
      for (const id of this.installed) if (!next.has(id)) this.options.setProfile(id, null)
      this.installed = new Set(next.keys())
      for (const [id, { profile }] of next) this.options.setProfile(id, profile)
      this.machines = [...next.values()].map((item) => item.machine)
      this.status = "connected"
      this.error = undefined
      this.schedule(POLL_MS)
    } catch (error) {
      if (generation !== this.generation) return
      this.status = "error"
      this.error = error instanceof DOMException && error.name === "AbortError" ? "The hub did not answer in time" : error instanceof Error ? error.message : "Could not reach the hub"
      this.options.log?.(`hub: ${this.error}`)
      this.schedule(RETRY_MS)
    } finally {
      clearTimeout(timeout)
    }
  }
}
