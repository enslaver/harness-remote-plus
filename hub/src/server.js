import http from "node:http"
import { AdminAuth, AttemptThrottle } from "./auth.js"
import { generateToken, hashToken, safeEqual } from "./crypto.js"
import { nullSink } from "./events.js"
import { parseTime } from "./loki.js"
import {
  HttpError, Router, bearerToken, clientAddress, machineToken, isSafeMethod, isSameSiteRequest, publicUrl, readJson, sendError, sendJson
} from "./http.js"
import { bootstrapMachine, publicMachine, publicSession } from "./present.js"
import { Prober } from "./prober.js"
import { createMachineProxy, parseProxyPath } from "./proxy.js"
import { createStaticServer } from "./static.js"
import {
  ValidationError, agentList, sessionQuery, sessionAgentList, clientLogEntries, configObject, credentialsObject, endpointList, logEntries, machineInfo, sessionList, statsObject
} from "./validate.js"

export const HEARTBEAT_INTERVAL_MS = 30_000
const VERSION = "0.1.0"

// The console is first-party static files with no inline script or style, so it can run under a strict
// policy. The app (Vite build) uses inline styles at runtime, so it only gets the framing restriction.
const CONSOLE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const APP_CSP = "frame-ancestors 'none'"

const WEB_NOT_BUILT = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness Remote Hub</title>
<body style="font:16px system-ui;padding:24px;max-width:36em;margin:auto"><h1>Web app not built</h1>
<p>This hub was started without the web client bundle. Build it with <code>npm run build</code> in <code>web/</code> and point <code>HUB_WEB_DIR</code> at <code>web/dist</code>, or use the Docker image, which includes it.</p>
<p><a href="/hub/">Open the hub console</a></p>`

function limit(value, fallback, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

function validated(work) {
  try {
    return work()
  } catch (error) {
    if (error instanceof ValidationError) throw new HttpError(400, "invalid_payload", error.message)
    throw error
  }
}

/**
 * Builds the HTTP surface. Dependencies are injected so tests can run the real router against a real
 * database without any process-level state.
 */
export function createHub({ config, store, auth, keys, sink = nullSink, loki, prober, now = () => Date.now(), proxyOptions = {} }) {
  const adminAuth = auth ?? new AdminAuth({ config, keys, now })
  const loginThrottle = new AttemptThrottle({ max: 10, windowMs: 5 * 60_000, now })
  // Failed enrollment tokens and failed machine tokens share one budget per address.
  const machineThrottle = new AttemptThrottle({ max: 20, windowMs: 5 * 60_000, now })
  const clientLogThrottle = new AttemptThrottle({ max: 120, windowMs: 60_000, now })
  const router = new Router()
  const consoleStatic = createStaticServer({ root: config.publicDir, headers: { "Content-Security-Policy": CONSOLE_CSP } })
  const appStatic = createStaticServer({ root: config.webDir, spa: true, headers: { "Content-Security-Policy": APP_CSP }, fallbackHtml: WEB_NOT_BUILT })
  const activeProber = prober ?? new Prober({ store, sink, config })
  const proxy = createMachineProxy({ store, config, sink, prober: activeProber, log: (message) => process.stderr.write(`[hub] ${message}\n`), ...proxyOptions })
  const presentOptions = () => ({ offlineAfterMs: config.offlineAfterMs, now: now() })

  /** Browser/admin routes. No WWW-Authenticate header: the SPA handles 401 itself, never a native prompt. */
  const admin = (handler) => async (ctx) => {
    const session = adminAuth.authenticate(ctx.req)
    if (!session) throw new HttpError(401, "unauthenticated", "Sign in required")
    if (!isSafeMethod(ctx.req.method) && !isSameSiteRequest(ctx.req, config)) {
      throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed")
    }
    if (session.refresh) ctx.res.setHeader("Set-Cookie", session.refresh)
    return handler(ctx)
  }

  /** Resolves the machine a request's token belongs to, or throws; failures share one throttle budget per address. */
  const authenticateMachine = async (req) => {
    const address = clientAddress(req, config.trustProxy)
    const wait = machineThrottle.retryAfter(address)
    if (wait) throw new HttpError(429, "too_many_attempts", "Too many failed attempts", { "Retry-After": String(wait) })
    const token = machineToken(req)
    const row = token ? await store.machineByTokenHash(hashToken(token)) : undefined
    if (!row) {
      machineThrottle.fail(address)
      throw new HttpError(401, "invalid_token", "Unknown or revoked machine token")
    }
    return row
  }

  /** Machine routes, authenticated by the per-machine bearer token issued at enrollment. */
  const machine = (handler) => async (ctx) => handler({ ...ctx, machine: await authenticateMachine(ctx.req) })

  const proxyableMachines = async () => (await store.listMachines()).filter((row) => row.proxy_enabled && row.credentials_enc)

  // ---- liveness / readiness -----------------------------------------------------------------

  router.add("GET", "/healthz", async ({ res }) => sendJson(res, 200, { ok: true }))
  router.add("GET", "/readyz", async ({ res }) => {
    const checks = { database: false }
    try {
      await store.ping()
      checks.database = true
    } catch {}
    // Loki is optional, but if it is configured a dead one is worth surfacing (logs would be lost).
    if (loki) checks.loki = await loki.ready()
    const ok = Object.values(checks).every((value) => value !== false)
    sendJson(res, ok ? 200 : 503, { ok, checks })
  })

  // ---- admin session ------------------------------------------------------------------------

  router.add("POST", "/api/v1/auth/login", async ({ req, res }) => {
    if (!isSameSiteRequest(req, config)) throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed")
    const address = clientAddress(req, config.trustProxy)
    const wait = loginThrottle.retryAfter(address)
    if (wait) throw new HttpError(429, "too_many_attempts", "Too many failed sign-in attempts", { "Retry-After": String(wait) })
    const body = await readJson(req, 4 * 1024)
    if (!adminAuth.verifyPassword(body.password)) {
      loginThrottle.fail(address)
      await sink.machineEvent(null, "auth.login_failed", { address })
      throw new HttpError(401, "invalid_credentials", "Incorrect password")
    }
    loginThrottle.succeed(address)
    sendJson(res, 200, { ok: true }, { "Set-Cookie": adminAuth.issue(req) })
  })

  router.add("POST", "/api/v1/auth/logout", async ({ req, res }) => {
    if (!isSameSiteRequest(req, config)) throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed")
    sendJson(res, 200, { ok: true }, { "Set-Cookie": adminAuth.clear(req) })
  })

  router.add("GET", "/api/v1/auth/me", admin(async ({ res }) => sendJson(res, 200, { ok: true })))

  // ---- bootstrap for the web app ------------------------------------------------------------

  // "Who am I?" is a question, not a failure, so a signed-out caller gets 200 + `authenticated: false`
  // (a 401 here would log a red error in every browser console on every first visit). `hub: true` is how
  // the web app tells "this origin is a hub, sign in" from "this is a plain static host".
  router.add("GET", "/api/v1/bootstrap", async ({ req, res }) => {
    const session = adminAuth.authenticate(req)
    if (!session) {
      sendJson(res, 200, { hub: true, authenticated: false, name: config.name })
      return
    }
    const rows = await proxyableMachines()
    sendJson(
      res,
      200,
      {
        hub: true,
        authenticated: true,
        name: config.name,
        version: VERSION,
        publicUrl: publicUrl(req, config),
        installCommand: config.installCommand,
        machines: rows.map((row) => bootstrapMachine(row, presentOptions()))
      },
      session.refresh ? { "Set-Cookie": session.refresh } : {}
    )
  })

  // ---- machine-facing API -------------------------------------------------------------------

  // The fleet as an enrolled client sees it: the same machine list the signed-in web app gets, read with
  // the per-machine token. Enrolled machines are trusted peers, so they may also open each other through
  // the proxy (see the dispatch below); revoke a machine's token to cut it off.
  router.add("GET", "/api/v1/fleet", machine(async ({ res }) => {
    const rows = await proxyableMachines()
    sendJson(res, 200, { hub: true, authenticated: true, name: config.name, machines: rows.map((row) => bootstrapMachine(row, presentOptions())) })
  }))

  router.add("POST", "/api/v1/machines/enroll", async ({ req, res }) => {
    const address = clientAddress(req, config.trustProxy)
    const wait = machineThrottle.retryAfter(address)
    if (wait) throw new HttpError(429, "too_many_attempts", "Too many failed attempts", { "Retry-After": String(wait) })

    const token = bearerToken(req)
    let via = null
    if (token) {
      if (config.enrollmentToken && safeEqual(token, config.enrollmentToken)) via = "env"
      else via = (await store.consumeEnrollmentToken(hashToken(token)))?.id ?? null
    }
    if (!via) {
      machineThrottle.fail(address)
      throw new HttpError(401, "invalid_enrollment_token", "Unknown, expired or revoked enrollment token")
    }

    const body = await readJson(req, 64 * 1024)
    const { info, endpoints, credentials, config: machineConfig } = validated(() => ({
      info: machineInfo(body.machine),
      endpoints: endpointList(body.endpoints),
      credentials: credentialsObject(body.credentials),
      config: configObject(body.config)
    }))
    const machineToken = generateToken("hrm")
    const row = await store.enrollMachine({
      info,
      endpoints,
      credentials,
      proxyEnabled: body.proxy === true && credentials !== null,
      config: machineConfig,
      tokenHash: hashToken(machineToken),
      enrolledVia: via
    })
    await sink.machineEvent(row, "machine.enrolled", { via: via === "env" ? "env" : "token", endpoints: endpoints.length, proxy: row.proxy_enabled })
    sendJson(res, 200, {
      machineId: row.id,
      token: machineToken,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      hub: { name: config.name, version: VERSION }
    })
  })

  router.add("POST", "/api/v1/machines/heartbeat", machine(async ({ req, res, machine: row }) => {
    const body = await readJson(req, 2 * 1024 * 1024)
    if (body.machine?.id !== undefined && body.machine.id !== row.id) {
      throw new HttpError(400, "machine_mismatch", "This token belongs to a different machine")
    }
    const update = validated(() => ({
      info: machineInfo({ ...body.machine, id: row.id }, { partial: true }),
      endpoints: endpointList(body.endpoints),
      credentials: credentialsObject(body.credentials) ?? undefined,
      proxyEnabled: body.proxy === true ? true : body.proxy === false ? false : undefined,
      config: configObject(body.config),
      agents: agentList(body.agents),
      stats: statsObject(body.stats),
      sessions: sessionList(body.sessions),
      sessionAgents: sessionAgentList(body.sessionAgents)
    }))
    // If anything was cut from the list on the way in, "not listed" no longer means "gone".
    if (Array.isArray(body.sessions) && body.sessions.length > update.sessions.length) update.sessionAgents = []
    const result = await store.recordHeartbeat(row.id, update)
    if (!result) throw new HttpError(401, "invalid_token", "Unknown or revoked machine token")
    if (result.transitions.length) await sink.sessionTransitions(row, result.transitions)
    if (result.configChanged) await sink.machineEvent(row, "machine.config_changed", {})

    const wantsProxy = update.proxyEnabled ?? row.proxy_enabled
    sendJson(res, 200, {
      ok: true,
      serverTime: new Date(now()).toISOString(),
      intervalMs: HEARTBEAT_INTERVAL_MS,
      // Lets a machine recover after the hub lost or could not read its stored credentials.
      needCredentials: Boolean(wantsProxy) && !(await store.machineCredentials(row.id))
    })
  }))

  router.add("POST", "/api/v1/ingest/logs", machine(async ({ req, res, machine: row }) => {
    // 501, not a silent 204: the machine needs to know shipping can never succeed and stop buffering.
    if (!loki) throw new HttpError(501, "logs_disabled", "This hub has no Loki configured")
    const body = await readJson(req, 2 * 1024 * 1024)
    const entries = validated(() => logEntries(body.entries, now()))
    if (!entries.length) return sendJson(res, 200, { accepted: 0 })
    try {
      sendJson(res, 200, { accepted: await sink.ingestLogs(row, entries) })
    } catch (error) {
      // Retryable failures (Loki down/overloaded) tell the machine to keep its buffer; a rejected
      // batch (4xx) would fail forever, so it is acknowledged and dropped rather than wedging the queue.
      if (error?.retryable === false) return sendJson(res, 200, { accepted: 0, dropped: entries.length, reason: error.message })
      throw new HttpError(503, "logs_unavailable", "Log storage is unavailable; retry later", { "Retry-After": "15" })
    }
  }))

  // ---- admin API ----------------------------------------------------------------------------

  router.add("GET", "/api/v1/stats", admin(async ({ res }) => sendJson(res, 200, await store.stats())))

  router.add("GET", "/api/v1/machines", admin(async ({ res }) => {
    const rows = await store.listMachines()
    sendJson(res, 200, { machines: rows.map((row) => publicMachine(row, presentOptions())) })
  }))

  router.add("GET", "/api/v1/machines/:id", admin(async ({ res, params }) => {
    const row = await store.getMachine(params.id)
    if (!row) throw new HttpError(404, "not_found", "Unknown machine")
    const [sessions, history] = await Promise.all([
      store.listSessions({ machineId: row.id, limit: 200 }),
      store.configHistory(row.id)
    ])
    sendJson(res, 200, {
      machine: publicMachine(row, presentOptions()),
      sessions: sessions.map(publicSession),
      configHistory: history.map((entry) => ({ config: entry.config, changedAt: entry.changed_at }))
    })
  }))

  router.add("PATCH", "/api/v1/machines/:id", admin(async ({ req, res, params }) => {
    const body = await readJson(req, 4 * 1024)
    const raw = body.displayName
    if (raw !== null && typeof raw !== "string") throw new HttpError(400, "invalid_payload", "displayName must be a string or null")
    const displayName = typeof raw === "string" ? raw.trim().slice(0, 128) || null : null
    if (!(await store.setDisplayName(params.id, displayName))) throw new HttpError(404, "not_found", "Unknown machine")
    sendJson(res, 200, { ok: true })
  }))

  router.add("DELETE", "/api/v1/machines/:id", admin(async ({ res, params }) => {
    const row = await store.getMachine(params.id)
    if (!row || !(await store.deleteMachine(params.id))) throw new HttpError(404, "not_found", "Unknown machine")
    await sink.machineEvent(row, "machine.removed", {})
    sendJson(res, 200, { ok: true })
  }))

  router.add("POST", "/api/v1/machines/:id/probe", admin(async ({ res, params }) => {
    if (!(await store.getMachine(params.id))) throw new HttpError(404, "not_found", "Unknown machine")
    sendJson(res, 200, await activeProber.probeMachine(params.id))
  }))

  router.add("GET", "/api/v1/logs", admin(async ({ res, url }) => {
    if (!loki) throw new HttpError(501, "logs_disabled", "This hub has no Loki configured")
    const params = url.searchParams
    const current = now()
    let start
    let end
    try {
      start = parseTime(params.get("since"), current, current - 3_600_000)
      end = parseTime(params.get("until"), current, current)
    } catch (error) {
      throw new HttpError(400, "invalid_query", error.message)
    }
    if (end <= start) throw new HttpError(400, "invalid_query", "until must be after since")
    if (current - start > 31 * 86_400_000) throw new HttpError(400, "invalid_query", "since is beyond the 31-day retention")
    const filters = { machine_id: params.get("machine"), kind: params.get("kind"), source: params.get("source"), level: params.get("level"), stream: params.get("stream") }
    try {
      const entries = await loki.query({
        filters,
        contains: (params.get("q") || "").slice(0, 200) || undefined,
        start,
        end,
        limit: limit(params.get("limit"), 200, 1_000),
        direction: params.get("direction") === "forward" ? "forward" : "backward"
      })
      sendJson(res, 200, { entries })
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, "invalid_query", error.message)
      throw new HttpError(502, "logs_unavailable", "Log storage did not answer")
    }
  }))

  router.add("POST", "/api/v1/client-logs", admin(async ({ req, res }) => {
    if (!loki) return sendJson(res, 202, { accepted: 0 })
    const address = clientAddress(req, config.trustProxy)
    const wait = clientLogThrottle.retryAfter(address)
    if (wait) throw new HttpError(429, "too_many_requests", "Slow down", { "Retry-After": String(wait) })
    clientLogThrottle.fail(address)
    const body = await readJson(req, 64 * 1024)
    const entries = validated(() => clientLogEntries(body.entries, now()))
    try {
      if (entries.length) await sink.clientLogs(entries)
    } catch {
      throw new HttpError(503, "logs_unavailable", "Log storage is unavailable")
    }
    sendJson(res, 202, { accepted: entries.length })
  }))

  router.add("GET", "/api/v1/sessions", admin(async ({ res, url }) => {
    const query = validated(() => sessionQuery(url.searchParams, now()))
    const { rows, total } = await store.searchSessions(query)
    sendJson(res, 200, { sessions: rows.map(publicSession), total, limit: query.limit, offset: query.offset })
  }))

  router.add("GET", "/api/v1/enrollment-tokens", admin(async ({ res }) => {
    sendJson(res, 200, { tokens: (await store.listEnrollmentTokens()).map(presentToken), staticToken: Boolean(config.enrollmentToken) })
  }))

  router.add("POST", "/api/v1/enrollment-tokens", admin(async ({ req, res }) => {
    const body = await readJson(req, 4 * 1024)
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : ""
    if (!label) throw new HttpError(400, "invalid_payload", "label is required")
    const hours = body.expiresInHours === undefined || body.expiresInHours === null ? null : Number(body.expiresInHours)
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) {
      throw new HttpError(400, "invalid_payload", "expiresInHours must be between 0 and 8760")
    }
    const token = generateToken("hre")
    const row = await store.createEnrollmentToken({
      label,
      tokenHash: hashToken(token),
      expiresAt: hours === null ? null : new Date(now() + hours * 3_600_000)
    })
    // The plaintext exists only in this response; the database keeps a hash.
    sendJson(res, 201, { ...presentToken(row), token })
  }))

  router.add("DELETE", "/api/v1/enrollment-tokens/:id", admin(async ({ res, params }) => {
    if (!/^[0-9a-f-]{36}$/i.test(params.id) || !(await store.revokeEnrollmentToken(params.id))) {
      throw new HttpError(404, "not_found", "Unknown or already revoked token")
    }
    sendJson(res, 200, { ok: true })
  }))

  // ---- dispatch -----------------------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    try {
      const target = req.url ?? "/"
      // Concatenate rather than resolve: `new URL("//x/y", base)` would read a leading "//" as a host.
      if (!target.startsWith("/")) throw new HttpError(400, "bad_request", "Unsupported request target")
      const url = new URL(`http://hub.local${target}`)

      const proxied = url.pathname.startsWith("/m/") ? parseProxyPath(url.pathname) : null
      if (proxied) {
        const session = adminAuth.authenticate(req)
        if (session) {
          if (!isSafeMethod(req.method ?? "GET") && !isSameSiteRequest(req, config)) {
            throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed")
          }
          if (session.refresh) res.setHeader("Set-Cookie", session.refresh)
        } else if (machineToken(req)) {
          // A bearer credential is not ambient like a cookie, so there is no cross-site check to make.
          await authenticateMachine(req)
        } else {
          throw new HttpError(401, "unauthenticated", "Sign in required")
        }
        await proxy({ req, res, url, ...proxied })
        return
      }

      const match = router.match(req.method ?? "GET", url.pathname)
      if (match) {
        await match.handler({ req, res, url, params: match.params })
        return
      }
      // An unknown API path must stay a JSON 404: answering it with the SPA's HTML would make a typo look like success.
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found", "Not found")
      if (url.pathname === "/hub") {
        res.writeHead(301, { Location: "/hub/" })
        res.end()
        return
      }
      if (url.pathname.startsWith("/hub/")) {
        await consoleStatic(req, res, url.pathname.slice("/hub".length))
        return
      }
      await appStatic(req, res, url.pathname)
    } catch (error) {
      if (!(error instanceof HttpError)) process.stderr.write(`[hub] ${req.method} ${req.url} failed: ${error?.stack ?? error}\n`)
      sendError(res, error)
    }
  })
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))

  return { server, router, auth: adminAuth, prober: activeProber }
}

function presentToken(row) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count
  }
}
