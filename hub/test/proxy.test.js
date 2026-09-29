import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { ENROLLMENT_TOKEN, createTestDatabase, machinePayload, skipDatabase, startFakeMachine, startHub, testConfig } from "./helpers.js"
import { parseProxyPath, upstreamUrl } from "../src/proxy.js"

let db
let hub
let machine
let events
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  machine = await startFakeMachine({ id: "machine_px", password: "gateway-pass" })
  events = []
  hub = await startHub({
    ...db,
    config: testConfig({ HUB_PROXY_MAX_BODY_BYTES: "10000" }),
    sink: { async machineEvent() {}, async sessionTransitions() {}, async proxyEvent(target, detail) { events.push({ machine: target.id, ...detail }) } }
  })
  await register("machine_px", machine)
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

test("parseProxyPath splits machine id and remainder", () => {
  assert.deepEqual(parseProxyPath("/m/machine_a/v1/machine"), { id: "machine_a", rest: "/v1/machine" })
  assert.deepEqual(parseProxyPath("/m/machine_a"), { id: "machine_a", rest: "/" })
  assert.deepEqual(parseProxyPath("/m/machine_a/"), { id: "machine_a", rest: "/" })
  assert.deepEqual(parseProxyPath("/m/a%20b/x"), { id: "a b", rest: "/x" })
  assert.equal(parseProxyPath("/m/"), null)
  assert.equal(parseProxyPath("/api/v1/machines"), null)
  assert.equal(parseProxyPath("/m/%E0%A4%A/x"), null)
})

test("upstreamUrl can never leave the verified origin", () => {
  const base = "http://192.168.1.20:4097"
  assert.equal(upstreamUrl(base, "/v1/machine", "?a=1").href, "http://192.168.1.20:4097/v1/machine?a=1")
  for (const attack of ["//evil.example/x", "///evil.example", "/\\evil.example", "/@evil.example", "/%2f%2fevil.example", "/../../etc/passwd", "/a/../../b"]) {
    assert.equal(upstreamUrl(base, attack, "").origin, "http://192.168.1.20:4097", attack)
  }
  assert.throws(() => upstreamUrl(base, "@evil.example/x", ""), (error) => error.status === 400 || error instanceof TypeError, "no leading slash is a malformed target")
})

test("the proxy needs a signed-in browser session", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  const response = await hub.request("/m/machine_px/v1/machine")
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("www-authenticate"), null)
  assert.equal(machine.requests.filter((request) => request.url === "/v1/machine" && request.headers.authorization).length, 0, "nothing reached the machine")
})

test("forwards the request with the machine's credentials, not the browser's", { skip: skipDatabase }, async () => {
  await hub.login()
  const response = await hub.request("/m/machine_px/echo?directory=%2Frepo&x=1", {
    headers: { Authorization: "Bearer browser-token", "X-Harness-Backend": "codex", "X-Evil": "1", Accept: "application/json" }
  })
  assert.equal(response.status, 200)
  const seen = response.json
  assert.equal(seen.url, "/echo?directory=%2Frepo&x=1", "path and query preserved byte-for-byte")
  assert.equal(seen.headers.authorization, `Basic ${Buffer.from("harness:gateway-pass").toString("base64")}`)
  assert.equal(seen.headers["x-harness-backend"], "codex")
  assert.equal(seen.headers["x-evil"], undefined, "unknown request headers are not forwarded")
  assert.equal(seen.headers.cookie, undefined, "the hub session cookie never reaches a machine")
  assert.ok(!JSON.stringify(seen.headers).includes("browser-token"))
})

test("relays selected response headers and drops cookies and internals", { skip: skipDatabase }, async () => {
  await hub.login()
  const response = await hub.request("/m/machine_px/echo")
  assert.equal(response.headers.get("x-next-cursor"), "cursor-1")
  assert.equal(response.headers.get("set-cookie"), null, "a machine cannot set cookies on the hub origin")
  assert.equal(response.headers.get("x-internal"), null)
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
})

test("forwards methods and bodies (POST JSON)", { skip: skipDatabase }, async () => {
  await hub.login()
  const response = await hub.request("/m/machine_px/echo", { method: "POST", json: { hello: "world" } })
  assert.equal(response.json.method, "POST")
  assert.equal(JSON.parse(response.json.body).hello, "world")
  assert.equal(response.json.headers["content-type"], "application/json")
})

test("path tricks cannot redirect the request to another host", { skip: skipDatabase }, async () => {
  await hub.login()
  const attacker = await new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => { seen.push(req.url); res.end("pwned") })
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }))
  })
  try {
    for (const path of [`//127.0.0.1:${attacker.port}/x`, `/\\127.0.0.1:${attacker.port}/x`, `/@127.0.0.1:${attacker.port}/x`]) {
      const before = machine.requests.length
      await hub.request(`/m/machine_px${path}`)
      // Whatever happened, the machine's own server (not the attacker's) saw it, as an ordinary path.
      assert.equal(attacker.seen.length, 0, `request leaked to attacker via ${path}`)
      assert.equal(machine.requests.length - before, 1)
    }
  } finally {
    attacker.server.close()
  }
})

test("a machine's 401 becomes a 502 with no WWW-Authenticate (no native password prompt)", { skip: skipDatabase }, async () => {
  const wrong = await startFakeMachine({ id: "machine_badcreds", password: "actual-password" })
  try {
    await register("machine_badcreds", wrong, { credentials: { username: "harness", password: "stale-password" } })
    await hub.login()
    const response = await hub.request("/m/machine_badcreds/echo")
    // The address cannot even be verified with the stale credentials, so it fails at the first hurdle.
    assert.equal(response.status, 502)
    assert.equal(response.headers.get("www-authenticate"), null)
    assert.match(response.json.message, /rejected the stored credentials|cannot reach/i)
  } finally {
    await wrong.close()
  }
})

test("credentials that stop working after verification map to machine_auth_failed", { skip: skipDatabase }, async () => {
  await hub.login()
  const response = await hub.request("/m/machine_px/forbidden")
  assert.equal(response.status, 502)
  assert.equal(response.json.error, "machine_auth_failed")
  assert.equal(response.headers.get("www-authenticate"), null)
})

test("relays a machine's own 4xx (not found) unchanged", { skip: skipDatabase }, async () => {
  await hub.login()
  const response = await hub.request("/m/machine_px/no/such/route")
  assert.equal(response.status, 404)
  assert.equal(response.json.error, "Not found")
})

test("streams server-sent events incrementally and closes the upstream when the browser leaves", { skip: skipDatabase }, async () => {
  await hub.login()
  const cookie = (await hub.request("/api/v1/auth/me")).status === 200 ? undefined : undefined
  void cookie
  const controller = new AbortController()
  const closed = machine.nextStreamClose()
  // Use a raw fetch with the session cookie: the helper buffers whole responses.
  const login = await fetch(`${hub.base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) })
  const sessionCookie = login.headers.get("set-cookie").split(";")[0]
  const response = await fetch(`${hub.base}/m/machine_px/sse`, { headers: { Cookie: sessionCookie }, signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  assert.equal(response.headers.get("content-length"), null)
  assert.match(response.headers.get("cache-control"), /no-cache/)

  const reader = response.body.getReader()
  let text = ""
  const started = Date.now()
  while (!/data: 3/.test(text)) {
    const { value, done } = await reader.read()
    assert.ok(!done, "stream ended early")
    text += Buffer.from(value).toString("utf8")
    assert.ok(Date.now() - started < 5_000, "events must arrive as they are produced, not when the stream ends")
  }
  assert.match(text, /: connected/)
  assert.match(text, /event: tick\ndata: 1/)

  controller.abort()
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream was not closed")), 3_000))])
  assert.equal(machine.streamsOpen, 0)
})

test("uploads under the limit pass; over the limit are refused before the machine sees them", { skip: skipDatabase }, async () => {
  await hub.login()
  const small = await hub.request("/m/machine_px/upload", { method: "POST", body: Buffer.alloc(5_000, 1), headers: { "Content-Type": "application/octet-stream" } })
  assert.equal(small.json.bytes, 5_000)

  const before = machine.requests.length
  const big = await hub.request("/m/machine_px/upload", { method: "POST", body: Buffer.alloc(20_000, 1), headers: { "Content-Type": "application/octet-stream" } })
  assert.equal(big.status, 413)
  assert.equal(machine.requests.length, before, "an oversized body must not be forwarded")
})

test("state-changing proxied requests must be same-site", { skip: skipDatabase }, async () => {
  await hub.login()
  const before = machine.requests.length
  const forged = await hub.request("/m/machine_px/echo", { method: "POST", json: {}, headers: { "Sec-Fetch-Site": "cross-site" } })
  assert.equal(forged.status, 403)
  assert.equal(machine.requests.length, before)
  const read = await hub.request("/m/machine_px/echo", { headers: { "Sec-Fetch-Site": "cross-site" } })
  assert.equal(read.status, 200, "plain reads carry no ambient-authority risk the cookie policy does not already cover")
})

test("unknown machine is 404; a machine that kept its credentials is 409", { skip: skipDatabase }, async () => {
  await hub.login()
  assert.equal((await hub.request("/m/machine_missing/v1/machine")).status, 404)
  const closedBook = await startFakeMachine({ id: "machine_private" })
  try {
    await register("machine_private", closedBook, { proxy: false })
    const response = await hub.request("/m/machine_private/v1/machine")
    assert.equal(response.status, 409)
    assert.equal(response.json.error, "proxy_disabled")
    assert.equal(closedBook.requests.length, 0)
  } finally {
    await closedBook.close()
  }
})

test("an unreachable machine is a clean 502, not a hang or a crash", { skip: skipDatabase }, async () => {
  const gone = await startFakeMachine({ id: "machine_gone_px" })
  await register("machine_gone_px", gone)
  await hub.login()
  assert.equal((await hub.request("/m/machine_gone_px/echo")).status, 200, "reachable at first")
  await gone.close()
  const response = await hub.request("/m/machine_gone_px/echo")
  assert.equal(response.status, 502)
  assert.equal(response.json.error, "machine_unreachable")
})

test("a request to an address that is a different machine is never proxied", { skip: skipDatabase }, async () => {
  // Registration claims `machine_impostor` lives where `machine_px` actually lives.
  await hub.request("/api/v1/machines/enroll", {
    method: "POST", auth: ENROLLMENT_TOKEN,
    json: machinePayload({ machine: { id: "machine_impostor" }, endpoints: [machine.url], credentials: machine.credentials })
  })
  await hub.login()
  const before = machine.requests.length
  const response = await hub.request("/m/machine_impostor/echo")
  assert.equal(response.status, 502)
  assert.match(response.json.message, /different machine/)
  assert.ok(machine.requests.slice(before).every((request) => request.url === "/v1/machine"), "only the identity check was sent, never the real request")
})

test("writes and failures are audited; routine successful reads are not", { skip: skipDatabase }, async () => {
  await hub.login()
  events.length = 0
  await hub.request("/m/machine_px/echo")
  await hub.request("/m/machine_px/echo", { method: "POST", json: { a: 1 } })
  await hub.request("/m/machine_px/no/such/route")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(events.map((event) => [event.method, event.path, event.status]), [["POST", "/echo", 200], ["GET", "/no/such/route", 404]])
  assert.ok(events.every((event) => event.machine === "machine_px" && Number.isFinite(event.ms)))
  assert.ok(events.every((event) => !("query" in event) && !JSON.stringify(event).includes("Authorization")))
})
