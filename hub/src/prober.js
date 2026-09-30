/**
 * Decides which address, if any, the hub may use to reach a machine.
 *
 * A machine merely *claims* endpoints. Before the proxy sends a request with that machine's
 * credentials to one of them, the prober proves that the address really is that machine: an
 * authenticated `GET /v1/machine` must answer with the same machine id. That single check is what
 * stops a mistyped LAN address, a recycled DHCP lease, or a hostile registration from pointing the
 * hub at somebody else's service (Loki, Postgres, a router) and having the proxy talk to it.
 *
 * It deliberately calls `/v1/machine`, never `/v1/health`: the health route starts the machine's ACP
 * harness process, and a monitoring probe must not wake agents that were left asleep on purpose.
 */

import http from "node:http"
import https from "node:https"

const PROBE_TIMEOUT_MS = 4_000
const CONCURRENCY = 8
const MAX_PROBE_BYTES = 64 * 1024

export function basicAuthorization({ username, password }) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

/**
 * `node:http` rather than `fetch`: fetch refuses the WHATWG "bad ports" list (6000, 6665-6669, 4045,
 * ...) and reports it only as "fetch failed", which would leave a machine started with such a
 * `--port` unprobeable with no usable explanation. It also never follows redirects, which is what we
 * want: a redirect would resend the Authorization header to wherever it points.
 */
function getOnce(url, { headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === "https:" ? https : http
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn(value)
    }
    const request = transport.request(url, { method: "GET", headers, agent: false }, (response) => {
      const chunks = []
      let size = 0
      response.on("data", (chunk) => {
        size += chunk.length
        // A gateway's identity answer is a few hundred bytes. Something that keeps talking is not one, and
        // reading it to the end would let a hostile address stall the probe with a slow endless body.
        if (size > MAX_PROBE_BYTES) return request.destroy(Object.assign(new Error("response too large"), { code: "E2BIG" }))
        chunks.push(chunk)
      })
      response.on("end", () => done(resolve, { status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", (error) => done(reject, error))
    })
    // One wall-clock deadline for the whole exchange. `timeout` on the request only measures silence, so a
    // server dripping a byte a second would keep the probe (and, through `running`, every later probe
    // cycle) alive forever.
    const deadline = setTimeout(() => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), timeoutMs)
    request.on("error", (error) => done(reject, error))
    request.end()
  })
}

function describe(error) {
  if (error?.code === "ETIMEDOUT") return "timed out"
  if (error?.code === "E2BIG") return "not a Harness gateway (response too large)"
  return error?.code ? String(error.code) : (error?.message ?? "unreachable")
}

export async function verifyEndpoint({ endpoint, machineId, credentials, timeoutMs = PROBE_TIMEOUT_MS }) {
  const started = Date.now()
  try {
    const { status, body } = await getOnce(`${endpoint}/v1/machine`, {
      headers: { Authorization: basicAuthorization(credentials), Accept: "application/json" },
      timeoutMs
    })
    if (status === 401 || status === 403) return { ok: false, error: "the machine rejected the stored credentials" }
    if (status < 200 || status >= 300) return { ok: false, error: `not a Harness gateway (HTTP ${status})` }
    let reported
    try {
      reported = JSON.parse(body)?.machine?.id
    } catch {}
    if (typeof reported !== "string") return { ok: false, error: "not a Harness gateway (no machine identity)" }
    if (reported !== machineId) return { ok: false, error: `a different machine answered (${reported.slice(0, 40)})` }
    return { ok: true, endpoint, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}

export class Prober {
  constructor({ store, sink, config, log = () => {} }) {
    this.store = store
    this.sink = sink
    this.config = config
    this.log = log
    this.timer = null
    this.running = false
  }

  /** Probes one machine; safe to call ad hoc (proxy on first use, the admin "check now" button). */
  async probeMachine(id) {
    const machine = await this.store.getMachine(id)
    if (!machine) return { ok: false, error: "unknown machine" }
    const credentials = await this.store.machineCredentials(id)
    if (!machine.proxy_enabled || !credentials) return { ok: false, error: "the machine did not share credentials with the hub" }

    // Sticky first: the address that worked last time, then the rest together. Alternating between two
    // working addresses would only add noise to the history.
    const known = machine.verified_endpoint && machine.endpoints.includes(machine.verified_endpoint) ? machine.verified_endpoint : null
    const others = machine.endpoints.filter((endpoint) => endpoint !== known)
    const attempt = (endpoint) => verifyEndpoint({ endpoint, machineId: id, credentials })

    let result = known ? await attempt(known) : { ok: false, error: "no verified address yet" }
    if (!result.ok && others.length) {
      const results = await Promise.all(others.map(attempt))
      result = results.find((candidate) => candidate.ok) ?? (known ? result : results[0])
    }
    if (!machine.endpoints.length) result = { ok: false, error: "the machine advertised no addresses" }

    await this.store.recordProbe(id, result)
    if (result.ok !== (machine.last_probe_ok ?? undefined)) {
      await this.sink.machineEvent(machine, result.ok ? "machine.reachable" : "machine.unreachable", result.ok ? { endpoint: result.endpoint, ms: result.ms } : { error: result.error })
    }
    return result
  }

  async probeAll() {
    if (this.running) return
    this.running = true
    try {
      const queue = (await this.store.proxyTargets()).map((target) => target.id)
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            await this.probeMachine(id)
          } catch (error) {
            this.log(`probe of ${id} failed: ${error.message}`)
          }
        }
      })
      await Promise.all(workers)
    } finally {
      this.running = false
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.probeAll().catch((error) => this.log(`probe cycle failed: ${error.message}`)), this.config.probeIntervalMs)
    this.timer.unref?.()
    void this.probeAll().catch(() => {})
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }
}
