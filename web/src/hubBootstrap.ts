import type { WorkspaceMachine } from "./workspaceMachines"
import { HUB_MACHINE_ID_PREFIX } from "./workspaceMachines"

/**
 * When this app is served by a Harness Remote Hub, the hub already knows the user's machines and can
 * reach them; the browser only has to ask. On any other host (GitHub Pages, `vite dev`, a file, the
 * desktop and Android shells) the question simply gets a "no", and nothing changes.
 *
 * The hub answers `GET api/v1/bootstrap` with `{ hub: true, authenticated, ... }`. That `hub: true`
 * marker is deliberate: a static host with an SPA fallback happily answers any path with `200 text/html`,
 * so "the request succeeded" cannot be what identifies a hub.
 */

export type HubBootstrap =
  | { kind: "none" }
  /** Definitely a hub, but the visitor has not signed in. */
  | { kind: "signin"; name: string }
  | { kind: "ready"; name: string; machines: WorkspaceMachine[] }
  /** Could not tell (network error, timeout, 5xx). Worth asking again; not proof of anything. */
  | { kind: "unavailable" }

export type PageLocation = { protocol: string; hostname: string; port: string }

const BOOTSTRAP_PATH = "api/v1/bootstrap"
const BASE_PATH = /^\/m\/[^/?#]+$/

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80
}

/** One machine as the hub describes it -> a workspace machine that talks to it through the hub's proxy. */
export function hubMachineFromPayload(entry: unknown, location: PageLocation): WorkspaceMachine | null {
  if (!entry || typeof entry !== "object") return null
  const candidate = entry as { id?: unknown; name?: unknown; basePath?: unknown }
  if (typeof candidate.id !== "string" || !candidate.id || typeof candidate.basePath !== "string") return null
  // The prefix must be exactly the hub's proxy route for one machine; anything else is not ours to trust.
  if (!BASE_PATH.test(candidate.basePath)) return null
  const protocol = location.protocol === "https:" ? "https:" : "http:"
  const port = location.port ? Number(location.port) : defaultPort(protocol)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return {
    id: `${HUB_MACHINE_ID_PREFIX}${candidate.id}`,
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : candidate.id,
    config: {
      backend: "opencode",
      host: `${protocol}//${location.hostname}`,
      port,
      // The hub authenticates the browser with its session cookie and injects the machine's own
      // credentials server-side, so there is nothing to store or send here.
      username: "",
      password: "",
      basePath: candidate.basePath
    }
  }
}

export function parseHubBootstrap(payload: unknown, location: PageLocation): HubBootstrap {
  if (!payload || typeof payload !== "object") return { kind: "none" }
  const body = payload as { hub?: unknown; authenticated?: unknown; name?: unknown; machines?: unknown }
  if (body.hub !== true) return { kind: "none" }
  const name = typeof body.name === "string" && body.name ? body.name : "Harness Remote Hub"
  if (body.authenticated !== true) return { kind: "signin", name }
  const machines = (Array.isArray(body.machines) ? body.machines : []).flatMap((entry) => {
    const machine = hubMachineFromPayload(entry, location)
    return machine ? [machine] : []
  })
  return { kind: "ready", name, machines }
}

export type FetchHubBootstrapOptions = {
  fetchImpl?: typeof fetch
  /** Vite's BASE_URL: "/" on a hub. On GitHub Pages it is "/repo/", where the probe is a harmless 404. */
  baseUrl?: string
  location?: PageLocation
  timeoutMs?: number
}

/** Never throws: every failure is a `HubBootstrap` value the caller can act on. */
export async function fetchHubBootstrap(options: FetchHubBootstrapOptions = {}): Promise<HubBootstrap> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL
  const location = options.location ?? window.location
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000)
  try {
    const response = await fetchImpl(`${baseUrl}${BOOTSTRAP_PATH}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal
    })
    // A definitive "this is not a hub": not found, or anything that is not JSON (an SPA fallback page).
    if (response.status === 404 || response.status === 405) return { kind: "none" }
    if (response.status >= 500) return { kind: "unavailable" }
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return { kind: "none" }
    return parseHubBootstrap(await response.json(), location)
  } catch {
    return { kind: "unavailable" }
  } finally {
    clearTimeout(timer)
  }
}

/** Same machines in the same order with the same connection, so a poll that changed nothing changes nothing. */
export function sameHubMachines(left: WorkspaceMachine[], right: WorkspaceMachine[]): boolean {
  return left.length === right.length && left.every((machine, index) => {
    const other = right[index]
    return machine.id === other.id && machine.name === other.name && machine.config.basePath === other.config.basePath
      && machine.config.host === other.config.host && machine.config.port === other.config.port
  })
}
