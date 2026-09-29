import http from "node:http"
import { AdminAuth, AttemptThrottle } from "./auth.js"
import { generateToken, hashToken, safeEqual } from "./crypto.js"
import {
  HttpError, Router, bearerToken, clientAddress, isSafeMethod, isSameSiteRequest, publicUrl, readJson, sendError, sendJson
} from "./http.js"
import { bootstrapMachine, publicMachine, publicSession } from "./present.js"
import {
  ValidationError, agentList, configObject, credentialsObject, endpointList, machineInfo, sessionList, statsObject
} from "./validate.js"

export const HEARTBEAT_INTERVAL_MS = 30_000
const VERSION = "0.1.0"

/** Receives the things worth recording in Loki. The default drops them; main.js wires the real sink. */
export const nullSink = Object.freeze({
  async machineEvent() {},
  async sessionTransitions() {}
})

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
export function createHub({ config, store, auth, keys, sink = nullSink, now = () => Date.now() }) {
  const adminAuth = auth ?? new AdminAuth({ config, keys, now })
  const loginThrottle = new AttemptThrottle({ max: 10, windowMs: 5 * 60_000, now })
  // Failed enrollment tokens and failed machine tokens share one budget per address.
  const machineThrottle = new AttemptThrottle({ max: 20, windowMs: 5 * 60_000, now })
  const router = new Router()
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

  /** Machine routes, authenticated by the per-machine bearer token issued at enrollment. */
  const machine = (handler) => async (ctx) => {
    const address = clientAddress(ctx.req, config.trustProxy)
    const wait = machineThrottle.retryAfter(address)
    if (wait) throw new HttpError(429, "too_many_attempts", "Too many failed attempts", { "Retry-After": String(wait) })
    const token = bearerToken(ctx.req)
    const row = token ? await store.machineByTokenHash(hashToken(token)) : undefined
    if (!row) {
      machineThrottle.fail(address)
      throw new HttpError(401, "invalid_token", "Unknown or revoked machine token")
    }
    return handler({ ...ctx, machine: row })
  }

  // ---- liveness / readiness -----------------------------------------------------------------

  router.add("GET", "/healthz", async ({ res }) => sendJson(res, 200, { ok: true }))
  router.add("GET", "/readyz", async ({ res }) => {
    const checks = { database: false }
    try {
      await store.ping()
      checks.database = true
    } catch {}
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

  // Deliberately answers 401 *with* `hub: true`: that is how the web app tells "this origin is a hub
  // and I must sign in" from "this origin is a plain static host".
  router.add("GET", "/api/v1/bootstrap", async ({ req, res }) => {
    const session = adminAuth.authenticate(req)
    if (!session) {
      sendJson(res, 401, { error: "unauthenticated", message: "Sign in required", hub: true, name: config.name })
      return
    }
    const rows = (await store.listMachines()).filter((row) => row.proxy_enabled && row.credentials_enc)
    sendJson(
      res,
      200,
      {
        hub: true,
        name: config.name,
        version: VERSION,
        publicUrl: publicUrl(req, config),
        machines: rows.map((row) => bootstrapMachine(row, presentOptions()))
      },
      session.refresh ? { "Set-Cookie": session.refresh } : {}
    )
  })

  // ---- machine-facing API -------------------------------------------------------------------

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
      info: machineInfo({ ...body.machine, id: row.id }),
      endpoints: endpointList(body.endpoints),
      credentials: credentialsObject(body.credentials) ?? undefined,
      proxyEnabled: body.proxy === true ? true : body.proxy === false ? false : undefined,
      config: configObject(body.config),
      agents: agentList(body.agents),
      stats: statsObject(body.stats),
      sessions: sessionList(body.sessions)
    }))
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

  router.add("GET", "/api/v1/sessions", admin(async ({ res, url }) => {
    const rows = await store.listSessions({
      machineId: url.searchParams.get("machine") || undefined,
      status: url.searchParams.get("status") || undefined,
      query: (url.searchParams.get("q") || "").slice(0, 200) || undefined,
      limit: limit(url.searchParams.get("limit"), 100, 500)
    })
    sendJson(res, 200, { sessions: rows.map(publicSession) })
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
      const url = new URL(req.url ?? "/", "http://hub.local")
      const match = router.match(req.method ?? "GET", url.pathname)
      if (!match) throw new HttpError(404, "not_found", "Not found")
      await match.handler({ req, res, url, params: match.params })
    } catch (error) {
      if (!(error instanceof HttpError)) process.stderr.write(`[hub] ${req.method} ${req.url} failed: ${error?.stack ?? error}\n`)
      sendError(res, error)
    }
  })
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))

  return { server, router, auth: adminAuth }
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
