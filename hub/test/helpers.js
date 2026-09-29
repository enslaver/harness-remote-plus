import { randomBytes } from "node:crypto"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.js"
import { SecretBox, deriveKeys } from "../src/crypto.js"
import { createPool, migrate } from "../src/db.js"
import { createHub } from "../src/server.js"
import { Store } from "../src/store.js"

export const ADMIN_PASSWORD = "correct horse battery staple"
export const SECRET_KEY = "k".repeat(48)
export const ENROLLMENT_TOKEN = "enroll-token-for-tests-0123456789"

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
export const databaseUrl = process.env.HUB_TEST_DATABASE_URL

/**
 * Database suites need Postgres. Locally that is opt-in and they skip with a reason; in CI an absent
 * database is a broken pipeline, not a reason to go green, so `ci-guard.test.js` fails the run.
 */
export const skipDatabase = databaseUrl ? false : "HUB_TEST_DATABASE_URL is not set"

export function testConfig(overrides = {}) {
  return loadConfig({
    HUB_DATABASE_URL: databaseUrl || "postgres://unused/unused",
    HUB_ADMIN_PASSWORD: ADMIN_PASSWORD,
    HUB_SECRET_KEY: SECRET_KEY,
    HUB_ENROLLMENT_TOKEN: ENROLLMENT_TOKEN,
    HUB_MIGRATIONS_DIR: path.join(root, "migrations"),
    ...overrides
  })
}

/** A private schema per suite: suites run in parallel against one database and must not see each other. */
export async function createTestDatabase() {
  const schema = `t_${randomBytes(6).toString("hex")}`
  const admin = createPool({ databaseUrl })
  await admin.query(`create schema ${schema}`)
  const pool = createPool({ databaseUrl, schema })
  await migrate(pool, path.join(root, "migrations"))
  const keys = deriveKeys(SECRET_KEY)
  const store = new Store(pool, new SecretBox(keys.secretbox))
  return {
    pool,
    store,
    keys,
    schema,
    async drop() {
      await pool.end()
      await admin.query(`drop schema ${schema} cascade`)
      await admin.end()
    }
  }
}

/** Runs the real router on an ephemeral port and gives tests a tiny fetch wrapper with a cookie jar. */
export async function startHub({ store, keys, config = testConfig(), sink, loki, prober, now } = {}) {
  const { server, prober: activeProber } = createHub({ config, store, keys, sink, loki, prober, now })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let cookie = ""

  async function request(pathname, { method = "GET", json, headers = {}, body, auth } = {}) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      redirect: "manual",
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: json !== undefined ? JSON.stringify(json) : body
    })
    const setCookie = response.headers.get("set-cookie")
    if (setCookie) cookie = setCookie.split(";")[0].endsWith("=") ? "" : setCookie.split(";")[0]
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    return { status: response.status, headers: response.headers, text, json: parsed }
  }

  return {
    base,
    request,
    prober: activeProber,
    async login(password = ADMIN_PASSWORD) {
      return request("/api/v1/auth/login", { method: "POST", json: { password } })
    },
    forgetCookie() {
      cookie = ""
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

export function machinePayload(overrides = {}) {
  return {
    machine: { id: "machine_aaaa-1111", name: "desk", hostname: "desk.local", platform: "linux", arch: "x64", nodeVersion: "22.1.0", version: "3.1.0", ...overrides.machine },
    endpoints: ["http://192.168.1.20:4097"],
    proxy: true,
    credentials: { username: "harness", password: "s3cret-gateway-pass" },
    config: { backend: "codex", roots: ["/home/me/dev"] },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "machine"))
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function readAll(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/**
 * Stands in for a machine's Harness gateway: Basic auth, the identity route, and a handful of
 * behaviours the proxy has to survive (echo, streaming, uploads, a hung request, a rejected login).
 */
export async function startFakeMachine({ id = "machine_fake", username = "harness", password = "gateway-pass" } = {}) {
  const requests = []
  const sockets = new Set()
  let streamsOpen = 0
  let streamClosed = null
  const closedSignal = () => new Promise((resolve) => { streamClosed = resolve })

  const server = http.createServer(async (req, res) => {
    const body = await readAll(req)
    const record = { method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") }
    requests.push(record)

    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Daemon"' })
      res.end()
      return
    }
    const url = new URL(req.url, "http://machine.local")
    if (url.pathname === "/v1/machine") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ machine: { id, name: "Fake machine" }, agents: [{ id: "codex", label: "Codex", state: "available" }] }))
    } else if (url.pathname === "/echo") {
      res.writeHead(200, { "Content-Type": "application/json", "X-Next-Cursor": "cursor-1", "Set-Cookie": "machine=1", "X-Internal": "secret" })
      res.end(JSON.stringify(record))
    } else if (url.pathname === "/sse") {
      streamsOpen += 1
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write(": connected\n\n")
      let count = 0
      const timer = setInterval(() => res.write(`event: tick\ndata: ${++count}\n\n`), 15)
      // `res`, not `req`: the request body was already consumed above, so req's own 'close' has fired
      // by now; only the response reports the client going away.
      res.on("close", () => {
        clearInterval(timer)
        streamsOpen -= 1
        streamClosed?.()
      })
    } else if (url.pathname === "/hang") {
      // never answers
    } else if (url.pathname === "/forbidden") {
      res.writeHead(403)
      res.end()
    } else if (url.pathname === "/upload") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ bytes: body.length }))
    } else {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Not found" }))
    }
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  const url = await listen(server)
  return {
    url,
    id,
    credentials: { username, password },
    requests,
    get streamsOpen() { return streamsOpen },
    nextStreamClose: closedSignal,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

/** A Loki that records pushes and serves canned query results; `mode` simulates outages and rejections. */
export async function startFakeLoki() {
  const state = { pushes: [], queries: [], mode: "ok", result: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://loki.local")
    if (url.pathname === "/ready") {
      res.writeHead(state.mode === "down" ? 503 : 200)
      res.end(state.mode === "down" ? "not ready" : "ready")
    } else if (url.pathname === "/loki/api/v1/push") {
      const body = await readAll(req)
      if (state.mode === "down") { res.writeHead(503); res.end("unavailable"); return }
      if (state.mode === "reject") { res.writeHead(400); res.end("entry has timestamp too old"); return }
      state.pushes.push(JSON.parse(body.toString("utf8")))
      res.writeHead(204)
      res.end()
    } else if (url.pathname === "/loki/api/v1/query_range") {
      state.queries.push(Object.fromEntries(url.searchParams))
      if (state.mode === "down") { res.writeHead(503); res.end("unavailable"); return }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "success", data: { resultType: "streams", result: state.result } }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  const url = await listen(server)
  return { url, state, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }) }
}
