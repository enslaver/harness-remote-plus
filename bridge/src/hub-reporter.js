import { readFileSync } from "node:fs"
import { hostname, networkInterfaces } from "node:os"
import { collectSessions } from "./hub-inventory.js"
import { clearHubToken, resolveHubOptions, writeHubState } from "./hub-options.js"
import { describeNetworkError, requestJson } from "./http-json.js"
import { LogTee, createRedactor, providerSecretsFromEnvironment } from "./log-tee.js"

const DEFAULT_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000
const LOG_INTERVAL_MS = 2_000
const LOG_BATCH = 500
// The hub refuses bodies over 2 MB; stay well below it however long the lines are.
const LOG_BATCH_BYTES = 1024 * 1024
const HEARTBEAT_MAX_BYTES = 1536 * 1024
const LOG_MAX_BACKOFF_MS = 60_000
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

function packageVersion() {
  for (const relative of ["../../package.json", "../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"))
      if (parsed?.version) return parsed.version
    } catch {
      // try the next candidate
    }
  }
  return "unknown"
}

function lanAddresses(interfaces = networkInterfaces()) {
  const found = []
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) if (address.family === "IPv4" && !address.internal) found.push(address.address)
  }
  return [...new Set(found)]
}

/** Addresses the hub could use to reach this gateway. Loopback is useless to a remote hub, so it is not offered. */
export function advertisedEndpoints({ options, config, lan = lanAddresses }) {
  if (options.advertise.length) {
    return options.advertise.flatMap((value) => {
      try {
        return [new URL(value).origin]
      } catch {
        return []
      }
    })
  }
  const host = config.host
  if (host === "0.0.0.0" || host === "::") return lan().map((address) => `http://${address}:${config.port}`)
  if (LOOPBACK.has(host)) return []
  return [`http://${host.includes(":") ? `[${host}]` : host}:${config.port}`]
}

/** An allow-list, not a copy of `config`: the gateway password must not leave by accident. */
export function describeConfig(config, version) {
  return {
    backend: config.backend,
    host: config.host,
    port: config.port,
    roots: config.roots ?? [],
    corsOrigins: config.corsOrigins ?? [],
    authRequired: Boolean(config.username),
    harnessRemoteVersion: version
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Keeps this machine registered with a hub: enrolls once, then heartbeats (identity, addresses,
 * configuration, agent state, Session inventory) and ships log lines.
 *
 * Design rule: the hub is optional infrastructure. Nothing here may throw into the daemon, block its
 * event loop, or grow memory without bound, whatever the hub does. Every failure path ends in "back off
 * and try again" (or, for a rejected credential, "stop and say so once").
 */
export class HubReporter {
  constructor({
    options, identity, config, snapshot, scoped, tee, stateDirectory,
    request = requestJson, collect = collectSessions, lan = lanAddresses,
    log = (message) => process.stderr.write(`[hub] ${message}\n`), version = packageVersion(), random = Math.random
  }) {
    this.options = options
    this.identity = identity
    this.config = config
    this.snapshot = snapshot
    this.scoped = scoped
    this.tee = tee
    this.stateDirectory = stateDirectory
    this.request = request
    this.collect = collect
    this.lan = lan
    this.log = log
    this.version = version
    this.random = random

    this.machineToken = options.machineToken
    this.enrollmentToken = options.enrollmentToken
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.credentialsSent = false
    this.backoffMs = 0
    this.logBackoffMs = 0
    this.logsDisabled = false
    this.stopped = false
    // null = not yet known. It must not start as false: then a hub that is unreachable from the very
    // first attempt (a typo in --hub, hub not up yet) would never register as a change and stay silent.
    this.connected = null
    this.startedAt = Date.now()
    this.beatTimer = null
    this.nextDelayMs = undefined
    this.logTimer = null
    this.inFlightLogs = null
  }

  #url(path) {
    return `${this.options.url}${path}`
  }

  #machineInfo() {
    return {
      id: this.identity.id,
      name: this.options.name ?? this.identity.name,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      version: this.version
    }
  }

  #shared() {
    const endpoints = advertisedEndpoints({ options: this.options, config: this.config, lan: this.lan })
    const proxy = !this.options.noProxy && Boolean(this.config.username && this.config.password) && endpoints.length > 0
    return { endpoints, proxy, config: describeConfig(this.config, this.version) }
  }

  #credentials() {
    return { username: this.config.username, password: this.config.password }
  }

  async start() {
    this.stopped = false
    this.#scheduleLogs()
    await this.#beat()
  }

  /** One heartbeat now (enrolling first if needed). The regular timer calls the same thing. */
  beat() {
    return this.#beat()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.beatTimer)
    clearTimeout(this.logTimer)
    // Best effort: give the last lines (often the reason for a shutdown) two seconds to leave.
    await Promise.race([this.flushLogs().catch(() => {}), sleep(2_000)])
  }

  #schedule(ms) {
    if (this.stopped) return
    clearTimeout(this.beatTimer)
    const jitter = 1 + (this.random() - 0.5) * 0.2
    this.nextDelayMs = Math.max(1_000, Math.round(ms * jitter))
    this.beatTimer = setTimeout(() => void this.#beat(), this.nextDelayMs)
    this.beatTimer.unref?.()
  }

  /**
   * `retryAfterMs` comes from a header the hub may not have sent: `Number(undefined) * 1000` is NaN, and
   * setTimeout(NaN) fires almost immediately, which would turn a rate-limit into a hot retry loop.
   */
  #failed(retryAfterMs) {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : 5_000)
    const hinted = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_BACKOFF_MS) : 0
    this.#schedule(Math.max(this.backoffMs, hinted))
  }

  #setConnected(connected, detail) {
    if (connected === this.connected) return
    const first = this.connected === null
    this.connected = connected
    // State transitions only: a hub that is down for an hour must produce one line, not 120.
    this.log(connected
      ? `connected to ${this.options.url}${detail ? ` (${detail})` : ""}`
      : `${first ? "could not reach" : "lost contact with"} ${this.options.url}: ${detail}; will keep retrying`)
  }

  #fatal(message) {
    this.log(`${message} Reporting to the hub is stopped for this run; the gateway itself is unaffected.`)
    this.stopped = true
    clearTimeout(this.beatTimer)
    clearTimeout(this.logTimer)
    if (this.tee) this.tee.enabled = false
  }

  async #enroll() {
    const shared = this.#shared()
    const response = await this.request(this.#url("/api/v1/machines/enroll"), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.enrollmentToken}` },
      body: {
        machine: this.#machineInfo(),
        endpoints: shared.endpoints,
        proxy: shared.proxy,
        ...(shared.proxy ? { credentials: this.#credentials() } : {}),
        config: shared.config
      }
    })
    if (response.status === 401) {
      return this.#fatal("The hub rejected the enrollment token (unknown, expired or revoked). Create a new one on the hub's Add machine page and pass it with --hub-token.")
    }
    if (response.status === 429) return this.#failed(Number(response.headers["retry-after"]) * 1_000)
    if (response.status !== 200 || typeof response.json?.token !== "string") {
      this.#setConnected(false, `enrollment failed (HTTP ${response.status})`)
      return this.#failed()
    }
    this.machineToken = response.json.token
    this.credentialsSent = shared.proxy
    if (Number.isFinite(response.json.heartbeatIntervalMs) && !this.options.intervalMs) this.intervalMs = response.json.heartbeatIntervalMs
    await writeHubState(this.stateDirectory, {
      url: this.options.url, machineId: this.identity.id, machineToken: this.machineToken, enrolledAt: new Date().toISOString()
    }).catch((error) => this.log(`could not save hub state (${error.message}); the machine will enroll again on restart`))
    this.backoffMs = 0
    this.#setConnected(true, `enrolled as ${this.options.name ?? this.identity.name}${shared.proxy ? "" : this.options.noProxy ? ", web UI not shared" : ", no reachable address to share"}`)
    return "enrolled"
  }

  async #beat(justEnrolled = false) {
    if (this.stopped) return
    try {
      if (!this.machineToken) {
        if (!this.enrollmentToken) {
          return this.#fatal("This machine is not enrolled and no enrollment token was given. Pass --hub-token (or HARNESS_REMOTE_HUB_TOKEN) from the hub's Add machine page.")
        }
        if ((await this.#enroll()) !== "enrolled") return
      }

      const agents = this.snapshot().agents
      const shared = this.#shared()
      const inventory = await this.collect({ config: this.config, agents, scoped: this.scoped }).catch(() => ({ sessions: [], completeAgents: [] }))
      // An injected collector may still return a bare list; that says nothing about completeness.
      let { sessions, completeAgents } = Array.isArray(inventory) ? { sessions: inventory, completeAgents: [] } : inventory
      const memory = process.memoryUsage()
      // The hub refuses an oversized heartbeat outright, which would make a machine with a huge inventory look
      // offline forever. Better to report no Sessions than to report nothing.
      if (JSON.stringify(sessions).length > HEARTBEAT_MAX_BYTES) {
        sessions = []
        completeAgents = []
      }
      const response = await this.request(this.#url("/api/v1/machines/heartbeat"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.machineToken}` },
        body: {
          machine: this.#machineInfo(),
          endpoints: shared.endpoints,
          proxy: shared.proxy,
          // Credentials ride along only the first time (and when the hub asks): they change on every
          // restart of a launcher-started gateway, but need not travel on every heartbeat.
          ...(shared.proxy && !this.credentialsSent ? { credentials: this.#credentials() } : {}),
          config: shared.config,
          agents: agents.map(({ id, label, backend, transport, state }) => ({ id, label, backend, transport, state })),
          sessions,
          sessionAgents: completeAgents,
          stats: { uptimeSeconds: Math.round(process.uptime()), rss: memory.rss, heapUsed: memory.heapUsed, droppedLogLines: this.tee?.dropped ?? 0 }
        }
      })

      if (response.status === 401) {
        // The hub does not know this token: the machine was forgotten there, or the hub was rebuilt.
        this.machineToken = undefined
        await clearHubToken(this.stateDirectory).catch(() => {})
        if (justEnrolled) {
          // Enrolled a moment ago and already refused: a hub that behaves like this would loop us forever.
          this.#setConnected(false, "the hub rejected a token it had just issued")
          return this.#failed()
        }
        if (this.enrollmentToken) {
          this.log("the hub no longer recognises this machine; enrolling again")
          return await this.#beat(true)
        }
        return this.#fatal("The hub no longer recognises this machine and no enrollment token is available to enroll again.")
      }
      if (response.status !== 200) {
        this.#setConnected(false, `HTTP ${response.status}`)
        return this.#failed(Number(response.headers["retry-after"]) * 1_000)
      }

      if (shared.proxy) this.credentialsSent = !response.json?.needCredentials
      if (Number.isFinite(response.json?.intervalMs) && !this.options.intervalMs) this.intervalMs = response.json.intervalMs
      this.backoffMs = 0
      this.#setConnected(true)
      this.#schedule(this.intervalMs)
    } catch (error) {
      this.#setConnected(false, describeNetworkError(error))
      this.#failed()
    }
  }

  // ---- logs ---------------------------------------------------------------------------------------

  #scheduleLogs(ms = LOG_INTERVAL_MS) {
    if (this.stopped || !this.tee || this.logsDisabled) return
    clearTimeout(this.logTimer)
    this.logTimer = setTimeout(() => void this.flushLogs().catch(() => {}).finally(() => this.#scheduleLogs(this.logBackoffMs || LOG_INTERVAL_MS)), ms)
    this.logTimer.unref?.()
  }

  /** Ships whatever is queued. Concurrent callers share one in-flight request so batches cannot reorder. */
  flushLogs() {
    if (this.inFlightLogs) return this.inFlightLogs
    this.inFlightLogs = this.#shipLogs().finally(() => { this.inFlightLogs = null })
    return this.inFlightLogs
  }

  async #shipLogs() {
    if (!this.tee || this.logsDisabled || !this.machineToken) return
    while (this.tee.size > 0) {
      const batch = this.tee.takeWithin(LOG_BATCH, LOG_BATCH_BYTES)
      let response
      try {
        response = await this.request(this.#url("/api/v1/ingest/logs"), {
          method: "POST",
          headers: { Authorization: `Bearer ${this.machineToken}` },
          body: { entries: batch.map(({ ts, line, stream, source }) => ({ ts, line, stream, source })) }
        })
      } catch {
        this.tee.requeue(batch)
        this.logBackoffMs = Math.min(LOG_MAX_BACKOFF_MS, this.logBackoffMs ? this.logBackoffMs * 2 : 4_000)
        return
      }
      if (response.status === 200) {
        this.logBackoffMs = 0
        continue
      }
      if (response.status === 501) {
        this.logsDisabled = true
        this.tee.enabled = false
        this.tee.take(this.tee.size)
        this.log("this hub has no log storage configured (HUB_LOKI_URL); logs will not be sent")
        return
      }
      if (response.status === 401 || response.status === 429 || response.status >= 500) {
        // Transient, or the heartbeat loop is about to re-enroll: keep the batch and slow down.
        this.tee.requeue(batch)
        this.logBackoffMs = Math.min(LOG_MAX_BACKOFF_MS, this.logBackoffMs ? this.logBackoffMs * 2 : 4_000)
        return
      }
      // Any other 4xx means this batch itself is unacceptable; retrying it would wedge the queue.
      this.tee.dropped += batch.length
    }
  }
}

/**
 * Called early in startup, before the gateway does anything worth logging. Returns `null` when this
 * install is not attached to a hub (nothing is patched, nothing is sent). Otherwise it starts
 * capturing output immediately and hands back a handle whose `start()` begins reporting once the
 * gateway is up and its machine identity is known.
 */
export async function prepareHubReporting({ flags, environment = process.env, config, streams = [process.stdout, process.stderr], log }) {
  const options = await resolveHubOptions({ flags, environment, stateDirectory: config.stateDirectory })
  if (!options) return null
  if (!options.enrollmentToken && !options.machineToken) {
    const message = `--hub ${options.url} was given without a token. Pass --hub-token (or HARNESS_REMOTE_HUB_TOKEN) from the hub's Add machine page. Continuing without the hub.`
    ;(log ?? ((text) => process.stderr.write(`[hub] ${text}\n`)))(message)
    return null
  }

  const redact = createRedactor([config.password, options.enrollmentToken, options.machineToken, ...providerSecretsFromEnvironment(environment)])
  const tee = new LogTee({ redact })
  tee.attach(streams[0], "stdout")
  tee.attach(streams[1], "stderr")

  let reporter = null
  return {
    options,
    tee,
    async start({ identity, snapshot, scoped }) {
      reporter = new HubReporter({ options, identity, config, snapshot, scoped, tee, stateDirectory: config.stateDirectory, log })
      await reporter.start()
      return reporter
    },
    async stop() {
      await reporter?.stop()
      tee.detach()
    }
  }
}
