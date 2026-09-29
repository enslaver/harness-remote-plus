import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { ENROLLMENT_TOKEN, createTestDatabase, machinePayload, skipDatabase, startFakeMachine, startHub, testConfig } from "./helpers.js"

// Regressions found in review of the proxy: timeouts that were tighter than the machine's real behaviour,
// machine responses served next to the admin console, an address trusted after it stopped verifying,
// and false outage reports when the browser simply went away.

let db
let hub
let machine
let events
let logs
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  machine = await startFakeMachine({ id: "machine_hard", password: "gateway-pass" })
  events = []
  logs = []
  hub = await startHub({
    ...db,
    config: testConfig(),
    // Short clocks so the tests can cross them: connect 150 ms, wait for a response up to 1.5 s.
    proxyOptions: { connectTimeoutMs: 150, headerTimeoutMs: 1_500, idleTimeoutMs: 1_500, log: (message) => logs.push(message) },
    sink: { async machineEvent() {}, async sessionTransitions() {}, async proxyEvent(target, detail) { events.push({ machine: target.id, ...detail }) } }
  })
  await register("machine_hard", machine)
  await hub.login()
})
after(async () => {
  await hub?.close()
  await machine?.close()
  await db?.drop()
})

async function register(id, fake, overrides = {}) {
  const response = await hub.request("/api/v1/machines/enroll", {
    method: "POST",
    auth: ENROLLMENT_TOKEN,
    json: machinePayload({ machine: { id }, endpoints: [fake.url], credentials: fake.credentials, ...overrides })
  })
  assert.equal(response.status, 200)
}

test("a machine that takes longer than the connect limit to ANSWER is not cut off at it", { skip: skipDatabase }, async () => {
  // The first request that wakes a sleeping harness can take a long time; only connecting must be quick.
  const started = Date.now()
  const response = await hub.request("/m/machine_hard/slow?ms=600")
  assert.equal(response.status, 200, `${response.status} ${response.text}`)
  assert.ok(Date.now() - started >= 550, "the response really was slower than the 150 ms connect limit")
  assert.equal(response.json.slow, true)
})

test("a machine that never answers still gets a 504 at the response limit", { skip: skipDatabase }, async () => {
  const started = Date.now()
  const response = await hub.request("/m/machine_hard/hang")
  assert.equal(response.status, 504)
  assert.equal(response.json.error, "machine_timeout")
  assert.ok(Date.now() - started < 4_000)
})

test("everything a machine returns is sandboxed, so HTML from a machine cannot script the admin's origin", { skip: skipDatabase }, async () => {
  const response = await hub.request("/m/machine_hard/html")
  assert.equal(response.status, 200)
  const csp = response.headers.get("content-security-policy") ?? ""
  assert.match(csp, /\bsandbox\b/, "no allow-scripts: the document gets an opaque origin and cannot run script")
  assert.match(csp, /default-src 'none'/)
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  // JSON keeps working; the policy only matters to documents.
  assert.equal((await hub.request("/m/machine_hard/echo")).status, 200)
})

test("an address whose last probe FAILED is proven again before any request is sent to it", { skip: skipDatabase }, async () => {
  // machine_recycled's stored address now belongs to somebody else (a recycled DHCP lease).
  const other = await startFakeMachine({ id: "someone_else", password: "gateway-pass" })
  try {
    await register("machine_recycled", other, { credentials: other.credentials })
    // It verified earlier and was later seen to fail; the stale address is still on record.
    await db.pool.query("update machines set verified_endpoint = $2 where id = $1", ["machine_recycled", other.url])
    await db.store.recordProbe("machine_recycled", { ok: false, error: "a different machine answered" })
    const before = other.requests.length
    const response = await hub.request("/m/machine_recycled/echo")
    assert.equal(response.status, 502)
    assert.match(response.json.message, /different machine/)
    const sent = other.requests.slice(before)
    assert.ok(sent.length > 0 && sent.every((request) => request.url === "/v1/machine"), "only the identity check was sent; the real request and its credentials were held back")
  } finally {
    await other.close()
  }
})

test("a verified address that is still healthy is used directly, without a probe per request", { skip: skipDatabase }, async () => {
  await hub.request("/api/v1/machines/machine_hard/probe", { method: "POST" })
  const before = machine.requests.length
  await hub.request("/m/machine_hard/echo")
  const sent = machine.requests.slice(before)
  assert.deepEqual(sent.map((request) => request.url), ["/echo"])
})

test("a browser that goes away mid-request is not reported as a machine outage", { skip: skipDatabase }, async () => {
  events.length = 0
  logs.length = 0
  const cookie = await (async () => {
    const response = await fetch(`${hub.base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) })
    return response.headers.get("set-cookie").split(";")[0]
  })()
  await new Promise((resolve) => {
    const url = new URL(`${hub.base}/m/machine_hard/slow?ms=1000`)
    const request = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { Cookie: cookie } })
    request.on("error", () => {})
    request.end()
    setTimeout(() => { request.destroy(); resolve() }, 120)
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(events, [], "an aborted GET is not an audit event")
  assert.ok(!logs.some((message) => /failed|unreachable|ECONNRESET/i.test(message)), `no false outage line: ${logs.join(" | ")}`)
})

test("an aborted write is recorded as a client close, not as an outage", { skip: skipDatabase }, async () => {
  events.length = 0
  const cookie = await (async () => {
    const response = await fetch(`${hub.base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) })
    return response.headers.get("set-cookie").split(";")[0]
  })()
  await new Promise((resolve) => {
    const url = new URL(`${hub.base}/m/machine_hard/slow?ms=1000`)
    const request = http.request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: hub.base, "Sec-Fetch-Site": "same-origin" } })
    request.on("error", () => {})
    request.end("{}")
    setTimeout(() => { request.destroy(); resolve() }, 120)
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(events.every((event) => event.status === 499 && event.closed === "client"), JSON.stringify(events))
})
