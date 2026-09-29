#!/usr/bin/env node
// End-to-end proof of the whole stack, using the REAL pieces and no test doubles between them:
//
//   docker compose stack (hub + Postgres + Loki)  <--HTTP-->  real machine daemon (bridge/src/daemon-cli.js)
//                                                              running a tiny stdio ACP agent
//
// It checks the things a user is actually promised: a machine can be pointed at the hub with one
// command; it shows up with its agents and configuration but not its password; its logs land in Loki and
// are searchable; a Session created through the hub's proxy appears in the inventory; the hub keeps its
// state across a restart; a machine forgotten on the hub enrolls itself again.
//
//   sh deploy/init-env.sh && docker compose up -d --build --wait
//   node hub/scripts/e2e-stack.mjs
//
// Optional:  E2E_GRAFANA=1  also checks the Grafana profile (datasource, dashboard, a query through it)
//            HUB_TLS_URL=https://localhost  also checks the Caddy profile (TLS, Secure cookie, SSE)
//            HUB_URL / HUB_ADMIN_PASSWORD  override what is read from .env

import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..", "..")

const failures = []
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(description, work, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await work()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}${last ? ` (${last.message})` : ""}`)
}

async function dotenv() {
  const values = {}
  try {
    for (const line of (await readFile(path.join(repo, ".env"), "utf8")).split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
      if (match) values[match[1]] = match[2]
    }
  } catch {
    // Everything can come from the environment instead.
  }
  return values
}

const env = { ...(await dotenv()), ...process.env }
const HUB = (env.HUB_URL || `http://127.0.0.1:${env.HUB_PORT || 8080}`).replace(/\/$/, "")
const ADMIN_PASSWORD = env.HUB_ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error("HUB_ADMIN_PASSWORD is required (from .env or the environment)")

// ---- a tiny cookie-carrying client ------------------------------------------------------------------

let cookie = ""
async function api(pathname, { method = "GET", json, base = HUB, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    redirect: "manual",
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined
  })
  const setCookie = response.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0]
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  return { status: response.status, headers: response.headers, text, json: body }
}

function compose(...args) {
  return spawnSync("docker", ["compose", ...args], { cwd: repo, encoding: "utf8" })
}

// ---- 1. the stack is up -------------------------------------------------------------------------------

const ready = await until("the hub to be ready", async () => {
  const response = await api("/readyz")
  return response.status === 200 ? response.json : null
}, { timeoutMs: 120_000 })
check("stack: the hub reports its database and Loki ready", ready.checks.database === true && ready.checks.loki === true, JSON.stringify(ready))

const login = await api("/api/v1/auth/login", { method: "POST", json: { password: ADMIN_PASSWORD } })
check("stack: the admin can sign in", login.status === 200)

const app = await api("/")
check("web app: / serves the built web client", app.status === 200 && /<div id="root">/.test(app.text) && /apple-touch-icon/.test(app.text))
const consolePage = await api("/hub/")
check("console: /hub/ is served under a strict CSP", consolePage.status === 200 && /script-src 'self'/.test(consolePage.headers.get("content-security-policy") ?? ""))
const worker = await api("/sw.js")
check("web app: the service worker is served no-cache and is the v4 build", worker.headers.get("cache-control") === "no-cache" && /harness-remote-v4/.test(worker.text))

const composeConfig = JSON.parse(compose("config", "--format", "json").stdout || "{}")
const published = Object.entries(composeConfig.services ?? {}).filter(([, service]) => (service.ports ?? []).length).map(([name]) => name)
// The hub always publishes one; Grafana and Caddy are opt-in front doors. The databases must never be.
check("isolation: Postgres and Loki publish no port (only the hub, and the optional Grafana/Caddy, do)", published.includes("hub") && published.every((name) => ["hub", "grafana", "caddy"].includes(name)), published.join(", "))
check("isolation: the hub binds loopback unless told otherwise", (composeConfig.services?.hub?.ports ?? []).every((port) => port.host_ip === (env.HUB_BIND || "127.0.0.1")), JSON.stringify(composeConfig.services?.hub?.ports))

// ---- 2. point a REAL machine at it with one command ----------------------------------------------------

const token = (await api("/api/v1/enrollment-tokens", { method: "POST", json: { label: "e2e", expiresInHours: 1 } })).json
check("enrollment: a token can be created in the console", /^hre_/.test(token?.token ?? ""))
const refused = await api("/api/v1/machines/enroll", { method: "POST", json: { machine: { id: "machine_wrong" } }, headers: { Authorization: "Bearer hre_not_a_real_token" } })
check("enrollment: a wrong token is refused", refused.status === 401)

const work = await mkdtemp(path.join(os.tmpdir(), "hub-e2e-"))
const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, "0.0.0.0", () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
const gatewayPassword = `gw-${Math.random().toString(36).slice(2)}-${Date.now()}`
const daemonArgs = [
  path.join(repo, "bridge/src/daemon-cli.js"), "--backend", "omp", "--acp-command", process.execPath, "--acp-arg", path.join(here, "fake-acp-agent.mjs"),
  "--no-opencode", "--host", "0.0.0.0", "--port", String(port), "--username", "harness", "--password", gatewayPassword,
  "--root", work, "--state-dir", path.join(work, "state"),
  "--hub", HUB, "--hub-token", token.token, "--hub-advertise", `http://host.docker.internal:${port}`
]
const daemonOutput = []
const daemon = spawn(process.execPath, daemonArgs, { env: { ...process.env, HARNESS_REMOTE_HUB_INTERVAL_MS: "2000" }, stdio: ["ignore", "pipe", "pipe"] })
daemon.stdout.on("data", (chunk) => daemonOutput.push(String(chunk)))
daemon.stderr.on("data", (chunk) => daemonOutput.push(String(chunk)))

// The stack may already hold machines (a previous run, a real install), so this run finds ITS machine by the
// identity its daemon prints, and tidies up after itself.
let machine
let id
try {
  id = await until("the daemon to print its machine id", async () => /Machine: .* \((machine_[^)\s]+)\)/.exec(daemonOutput.join(""))?.[1], { timeoutMs: 30_000 })
  machine = await until("the machine to appear on the hub", async () => (await api("/api/v1/machines")).json?.machines?.find((candidate) => candidate.id === id), { timeoutMs: 60_000 })
  check("machine: it appears on the hub after one command", Boolean(machine?.id))
  const detail = async () => (await api(`/api/v1/machines/${encodeURIComponent(id)}`)).json

  check("machine: identity, agents and configuration are reported", machine.status === "online" && machine.agents.some((agent) => agent.id === "omp") && machine.config.backend === "omp")
  check("secrets: the gateway password is nowhere in what the hub reports", !JSON.stringify(await detail()).includes(gatewayPassword))
  const listedTokens = JSON.stringify((await api("/api/v1/enrollment-tokens")).json)
  check("secrets: the enrollment token is not listed back", !listedTokens.includes(token.token))

  // ---- 3. the web UI can reach the machine THROUGH the hub -------------------------------------------
  await api(`/api/v1/machines/${encodeURIComponent(id)}/probe`, { method: "POST" })
  const proxied = await until("the proxy to reach the machine", async () => {
    const response = await api(`/m/${encodeURIComponent(id)}/v1/machine`)
    return response.status === 200 ? response : null
  }, { timeoutMs: 45_000 })
  check("proxy: the hub reaches the machine (host.docker.internal from the container) with injected credentials", proxied.json?.machine?.id === id)
  const direct = await fetch(`http://127.0.0.1:${port}/v1/machine`)
  check("proxy: the machine itself still refuses anonymous callers", direct.status === 401)
  const anonymous = await fetch(`${HUB}/m/${encodeURIComponent(id)}/v1/machine`)
  check("proxy: the hub refuses browsers that are not signed in", anonymous.status === 401 && anonymous.headers.get("www-authenticate") === null)

  // ---- 4. logs reach Loki and can be searched ----------------------------------------------------------
  const logs = await until("the machine's logs to reach Loki", async () => {
    const response = await api(`/api/v1/logs?machine=${encodeURIComponent(id)}&kind=log&since=15m&limit=200`)
    return response.json?.entries?.length ? response.json.entries : null
  }, { timeoutMs: 45_000 })
  check("logs: the daemon's startup output is searchable per machine", logs.some((entry) => /Harness daemon ready/.test(entry.line)), logs.slice(0, 3).map((entry) => entry.line).join(" | "))
  check("logs: no secret reached Loki", !JSON.stringify(logs).includes(gatewayPassword) && !JSON.stringify(logs).includes(token.token))
  const events = (await api(`/api/v1/logs?machine=${encodeURIComponent(id)}&kind=event&since=15m`)).json.entries
  check("events: enrollment is recorded as an event", events.some((entry) => /machine\.enrolled/.test(entry.line)))
  const search = (await api(`/api/v1/logs?machine=${encodeURIComponent(id)}&since=15m&q=${encodeURIComponent("Harness daemon ready")}`)).json.entries
  check("logs: server-side search finds the line", search.length >= 1)

  // ---- 5. a Session created through the proxy shows up in the inventory ------------------------------------
  const created = await api(`/m/${encodeURIComponent(id)}/session?directory=${encodeURIComponent(work)}`, { method: "POST", json: { title: "e2e session" } })
  check("sessions: a Session can be created on the machine through the hub", created.status === 200 && Boolean(created.json?.id), `${created.status} ${created.text.slice(0, 120)}`)
  const inventory = await until("the Session to be inventoried", async () => {
    const response = await api(`/api/v1/sessions?machine=${encodeURIComponent(id)}&limit=50`)
    return response.json?.sessions?.length ? response.json.sessions : null
  }, { timeoutMs: 45_000 })
  check("sessions: the hub's inventory lists it, with its machine and agent", inventory.some((session) => session.machineId === id && session.agentId === "omp"), JSON.stringify(inventory[0]))
  const sample = inventory.find((session) => session.machineId === id)
  check("sessions: it has an activity, a start time and a last-ran time", ["working", "needs_input", "idle", "completed", "failed", "stopped", "unknown"].includes(sample?.activity) && Number.isFinite(Date.parse(sample?.startedAt)) && (sample?.lastRanAt === null || Number.isFinite(Date.parse(sample?.lastRanAt))), JSON.stringify(sample))
  const recentSearch = (await api(`/api/v1/sessions?machine=${encodeURIComponent(id)}&startedAfter=1h&q=${encodeURIComponent("e2e")}`)).json
  check("sessions: the hub can search by when it started, and by text", recentSearch.total >= 1 && recentSearch.sessions.some((session) => session.id === sample.id), JSON.stringify(recentSearch).slice(0, 200))
  check("sessions: a start window that excludes it finds nothing", (await api(`/api/v1/sessions?machine=${encodeURIComponent(id)}&startedBefore=2000-01-01`)).json.total === 0)
  check("sessions: a malformed date is refused, not ignored", (await api("/api/v1/sessions?ranAfter=whenever")).status === 400)
  const sessionEvents = await until("the Session event in Loki", async () => {
    const response = await api(`/api/v1/logs?machine=${encodeURIComponent(id)}&kind=event&since=15m&q=session.created`)
    return response.json?.entries?.length ? response.json.entries : null
  }, { timeoutMs: 30_000 })
  check("sessions: its creation is an event in Loki", sessionEvents.length >= 1)
  const agentLogs = (await api(`/api/v1/logs?machine=${encodeURIComponent(id)}&source=omp&since=15m`)).json.entries
  check("logs: the agent's own output is labelled by source", agentLogs.some((entry) => /ready to serve sessions/.test(entry.line)), `${agentLogs.length} lines`)

  // ---- 6. durability and self-healing ---------------------------------------------------------------------
  const restart = compose("restart", "hub")
  check("resilience: the hub container restarts", restart.status === 0, restart.stderr.slice(0, 200))
  await until("the hub to come back", async () => (await api("/readyz")).status === 200, { timeoutMs: 90_000 })
  const afterRestart = await api("/api/v1/machines")
  check("resilience: the sign-in survives a restart (stateless session) and the machine is still registered", afterRestart.status === 200 && afterRestart.json.machines.some((candidate) => candidate.id === id))
  await until("the machine to report online again", async () => (await api("/api/v1/machines")).json.machines.find((candidate) => candidate.id === id)?.status === "online", { timeoutMs: 30_000 })
  check("resilience: the machine is online again after the restart, without any action on it", true)

  const tokenUses = async () => (await api("/api/v1/enrollment-tokens")).json.tokens.find((entry) => entry.id === token.id)?.useCount ?? 0
  const before = await tokenUses()
  await api(`/api/v1/machines/${encodeURIComponent(id)}`, { method: "DELETE" })
  const back = await until("the forgotten machine to enroll itself again", async () => (await api("/api/v1/machines")).json.machines.find((candidate) => candidate.id === id), { timeoutMs: 45_000 })
  const after = await tokenUses()
  check("self-heal: a machine forgotten on the hub enrolls itself again", Boolean(back) && after > before, `uses ${before} -> ${after}`)

  // ---- 7. optional profiles --------------------------------------------------------------------------------------
  if (env.E2E_GRAFANA === "1") {
    const grafana = `http://127.0.0.1:${env.GRAFANA_PORT || 3000}`
    const auth = { Authorization: `Basic ${Buffer.from(`admin:${env.GRAFANA_ADMIN_PASSWORD || ADMIN_PASSWORD}`).toString("base64")}` }
    await until("Grafana to be healthy", async () => (await fetch(`${grafana}/api/health`)).ok, { timeoutMs: 120_000, intervalMs: 2_000 })
    const datasource = await (await fetch(`${grafana}/api/datasources/uid/harness-remote-loki/health`, { headers: auth })).json()
    check("grafana: the provisioned Loki datasource is healthy", datasource.status === "OK", JSON.stringify(datasource))
    const dashboard = await (await fetch(`${grafana}/api/dashboards/uid/harness-remote-fleet`, { headers: auth })).json()
    check("grafana: the fleet dashboard is provisioned", dashboard.dashboard?.title === "Harness Remote - fleet logs" && dashboard.dashboard.panels.length === 4)
    const labels = await (await fetch(`${grafana}/api/datasources/proxy/uid/harness-remote-loki/loki/api/v1/labels`, { headers: auth })).json()
    check("grafana: a query through it reaches Loki and sees the machine label", labels.data?.includes("machine") && labels.data.includes("kind"), JSON.stringify(labels).slice(0, 200))
  }

  if (env.HUB_TLS_URL) {
    const url = new URL(env.HUB_TLS_URL)
    const request = (pathname, { method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = https.request({ host: url.hostname, port: url.port || 443, path: pathname, method, headers, rejectUnauthorized: false }, (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
      })
      req.on("error", reject)
      req.end(body)
    })
    check("tls: the console is served over HTTPS", (await request("/hub/")).status === 200)
    const secure = await request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ password: ADMIN_PASSWORD }), headers: { "Content-Type": "application/json" } })
    check("tls: behind the proxy the session cookie is marked Secure", /;\s*Secure/i.test(String(secure.headers["set-cookie"] ?? "")), `${secure.headers["set-cookie"]} (HUB_TRUST_PROXY=1 is required with the tls profile)`)
    const tlsCookie = String(secure.headers["set-cookie"] ?? "").split(";")[0]
    const streamed = await new Promise((resolve) => {
      const started = Date.now()
      const req = https.request({ host: url.hostname, port: url.port || 443, path: `/m/${encodeURIComponent(id)}/global/event`, headers: { Cookie: tlsCookie }, rejectUnauthorized: false }, (res) => {
        res.once("data", () => { resolve({ status: res.statusCode, ms: Date.now() - started, type: res.headers["content-type"] }); req.destroy() })
      })
      req.on("error", () => resolve(null))
      setTimeout(() => { resolve(null); req.destroy() }, 8_000)
      req.end()
    })
    check("tls: server-sent events pass through the proxy unbuffered", streamed?.status === 200 && /event-stream/.test(streamed.type) && streamed.ms < 5_000, JSON.stringify(streamed))
  }
} catch (error) {
  console.error(`\nERROR: ${error.message}`)
  console.error(`--- daemon output ---\n${daemonOutput.join("").slice(-3_000)}`)
  failures.push(error.message)
} finally {
  daemon.kill("SIGTERM")
  await sleep(500)
  // Leave the stack as it was found: no stale machine, no usable token.
  if (id) await api(`/api/v1/machines/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {})
  if (token?.id) await api(`/api/v1/enrollment-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" }).catch(() => {})
  await rm(work, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("\nAll end-to-end checks passed.")
