import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * How an install learns which hub to report to. Three sources, in this precedence:
 *   1. flags        --hub URL --hub-token TOKEN [--hub-name N] [--hub-advertise URL]... [--hub-no-proxy] [--no-hub]
 *   2. environment  HARNESS_REMOTE_HUB_URL / _TOKEN / _NAME / _ADVERTISE / _NO_PROXY
 *   3. state file   <state dir>/hub.json, written after the first successful enrollment
 *
 * The state file is what makes "point it at the hub once" stick: after the first run a bare
 * `harness-remote` reconnects on its own. The enrollment token is only needed to enroll; afterwards the
 * machine holds its own per-machine token and the shared one can be revoked.
 */

const STATE_FILE = "hub.json"
const VALUE_FLAGS = new Set(["--hub", "--hub-token", "--hub-name", "--hub-advertise-name", "--hub-advertise", "--hub-advertise-host"])
const BOOLEAN_FLAGS = new Set(["--hub-no-proxy", "--no-hub"])

export function normalizeHubUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`--hub must be an http(s) URL, got: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--hub must be an http(s) URL, got: ${value}`)
  if (url.username || url.password) throw new Error("--hub must not contain credentials; pass the token with --hub-token or HARNESS_REMOTE_HUB_TOKEN")
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** Splits hub flags out of `args` so the existing option parsers never see (and reject) them. */
export function extractHubArgs(args) {
  const flags = { advertise: [], advertiseHosts: [] }
  const rest = []
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (VALUE_FLAGS.has(option)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`)
      index += 1
      if (option === "--hub") flags.url = value
      else if (option === "--hub-token") flags.token = value
      else if (option === "--hub-name" || option === "--hub-advertise-name") flags.name = value
      else if (option === "--hub-advertise-host") flags.advertiseHosts.push(value)
      else flags.advertise.push(value)
    } else if (BOOLEAN_FLAGS.has(option)) {
      if (option === "--hub-no-proxy") flags.noProxy = true
      else flags.disabled = true
    } else {
      rest.push(option)
    }
  }
  return { flags, rest }
}

function truthy(value) {
  return value === "1" || value === "true" || value === "yes"
}

export async function readHubState(stateDirectory) {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDirectory, STATE_FILE), "utf8"))
    if (parsed && typeof parsed.url === "string" && typeof parsed.machineToken === "string") return parsed
  } catch {
    // Missing or unreadable state simply means "not enrolled yet".
  }
  return null
}

/** Atomic and owner-only: it holds a bearer credential for this machine. */
export async function writeHubState(stateDirectory, state) {
  await mkdir(stateDirectory, { recursive: true })
  const file = path.join(stateDirectory, STATE_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export async function clearHubToken(stateDirectory) {
  const state = await readHubState(stateDirectory)
  if (state) await writeHubState(stateDirectory, { ...state, machineToken: "" })
}

/**
 * Resolves everything the reporter needs, or `null` when this install is not (and should not be)
 * attached to a hub. Throws on a malformed flag so a typo fails at startup, not silently.
 */
export async function resolveHubOptions({ flags, environment = process.env, stateDirectory }) {
  if (flags.disabled) return null
  const saved = await readHubState(stateDirectory)
  const rawUrl = flags.url ?? environment.HARNESS_REMOTE_HUB_URL ?? saved?.url
  if (!rawUrl) return null

  const url = normalizeHubUrl(rawUrl)
  const enrollmentToken = flags.token ?? environment.HARNESS_REMOTE_HUB_TOKEN ?? undefined
  // A saved machine token belongs to the hub that issued it; pointing elsewhere means enrolling afresh.
  const machineToken = saved && saved.url === url && saved.machineToken ? saved.machineToken : undefined
  const list = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  const advertise = flags.advertise.length ? flags.advertise : list(environment.HARNESS_REMOTE_HUB_ADVERTISE)
  // Name and route-back host are remembered with the enrollment, so a bare re-run keeps them.
  const remembered = saved && saved.url === url ? saved : undefined
  // A variable that is set but empty is an answer too ("advertise nothing special"): it is how the desktop's
  // settings form clears a host it saved earlier, so it must not fall back to what was remembered.
  const advertiseHosts = flags.advertiseHosts?.length
    ? flags.advertiseHosts
    : environment.HARNESS_REMOTE_HUB_ADVERTISE_HOST !== undefined ? list(environment.HARNESS_REMOTE_HUB_ADVERTISE_HOST) : remembered?.advertiseHosts ?? []

  const intervalOverride = Number(environment.HARNESS_REMOTE_HUB_INTERVAL_MS)
  return {
    url,
    enrollmentToken,
    machineToken,
    name: (flags.name ?? environment.HARNESS_REMOTE_HUB_ADVERTISE_NAME ?? environment.HARNESS_REMOTE_HUB_NAME ?? remembered?.name)?.trim() || undefined,
    advertise,
    advertiseHosts,
    noProxy: Boolean(flags.noProxy) || truthy(environment.HARNESS_REMOTE_HUB_NO_PROXY),
    intervalMs: Number.isFinite(intervalOverride) && intervalOverride >= 1_000 ? intervalOverride : undefined
  }
}

export const HUB_USAGE = `Hub options (optional, report this machine to a Harness Remote Hub):
  --hub <url>              Hub address, e.g. https://hub.example.com (remembered after the first run)
  --hub-token <token>      Enrollment token from the hub's "Add machine" page (or HARNESS_REMOTE_HUB_TOKEN)
  --hub-advertise-name <name>  Display name for this machine (default: its hostname; --hub-name still works)
  --hub-advertise-host <host>  Host the hub should use to reach this gateway, e.g. jedi.tailnet.ts.net; repeatable.
                           The port is this gateway's own, detected automatically
                           (default: this machine's LAN addresses; use it for a Tailscale/VPN name)
  --hub-advertise <url>    Full address (scheme and port) for the hub to use; repeatable, for unusual setups
  --hub-no-proxy           Report to the hub but keep the gateway password on this machine
                           (the hub then cannot open this machine's web UI)
  --no-hub                 Do not contact the hub this run`
