import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { Prober, basicAuthorization, verifyEndpoint } from "../src/prober.js"
import { hashToken } from "../src/crypto.js"
import { machineInfo } from "../src/validate.js"
import { createTestDatabase, skipDatabase, startFakeMachine, testConfig } from "./helpers.js"

let db
before(async () => { if (!skipDatabase) db = await createTestDatabase() })
after(async () => db?.drop())

test("basicAuthorization encodes UTF-8 credentials", () => {
  assert.equal(basicAuthorization({ username: "u", password: "p" }), `Basic ${Buffer.from("u:p").toString("base64")}`)
  assert.equal(basicAuthorization({ username: "harness", password: "pässwörd" }), `Basic ${Buffer.from("harness:pässwörd", "utf8").toString("base64")}`)
})

test("verifyEndpoint accepts only the machine it expects", async () => {
  const machine = await startFakeMachine({ id: "machine_v", password: "pw" })
  try {
    const ok = await verifyEndpoint({ endpoint: machine.url, machineId: "machine_v", credentials: { username: "harness", password: "pw" } })
    assert.equal(ok.ok, true)
    assert.ok(ok.ms >= 0)

    const wrongId = await verifyEndpoint({ endpoint: machine.url, machineId: "machine_other", credentials: { username: "harness", password: "pw" } })
    assert.equal(wrongId.ok, false)
    assert.match(wrongId.error, /different machine answered \(machine_v\)/)

    const wrongPassword = await verifyEndpoint({ endpoint: machine.url, machineId: "machine_v", credentials: { username: "harness", password: "nope" } })
    assert.match(wrongPassword.error, /rejected the stored credentials/)
  } finally {
    await machine.close()
  }
})

function serve(handler) {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => { seen.push(req.url); handler(req, res) })
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }) }))
  })
}

test("verifyEndpoint rejects things that are not a Harness gateway", async () => {
  const credentials = { username: "harness", password: "pw" }
  const html = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>router admin</html>") })
  const missing = await serve((_req, res) => { res.writeHead(404); res.end() })
  try {
    assert.match((await verifyEndpoint({ endpoint: html.url, machineId: "x", credentials })).error, /no machine identity/)
    assert.match((await verifyEndpoint({ endpoint: missing.url, machineId: "x", credentials })).error, /not a Harness gateway \(HTTP 404\)/)
  } finally {
    await html.close()
    await missing.close()
  }
})

test("verifyEndpoint explains dead and hung addresses", async () => {
  const credentials = { username: "a", password: "b" }
  const refused = await verifyEndpoint({ endpoint: "http://127.0.0.1:1", machineId: "x", credentials })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, "ECONNREFUSED")
  const hung = await serve(() => {})
  try {
    assert.equal((await verifyEndpoint({ endpoint: hung.url, machineId: "x", credentials, timeoutMs: 80 })).error, "timed out")
  } finally {
    await hung.close()
  }
})

test("ports that fetch() refuses outright (WHATWG bad ports) can still be probed", async () => {
  // 6000 (X11) is on the blocklist; a machine started with --port 6000 must not become unreachable.
  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ machine: { id: "machine_bad_port" } })) })
  const listening = await new Promise((resolve) => { server.once("error", () => resolve(false)); server.listen(6000, "127.0.0.1", () => resolve(true)) })
  try {
    if (!listening) return // port taken on this machine; the property is covered by the ECONNREFUSED case above
    const result = await verifyEndpoint({ endpoint: "http://127.0.0.1:6000", machineId: "machine_bad_port", credentials: { username: "a", password: "b" } })
    assert.equal(result.ok, true)
  } finally {
    server.close()
  }
})

test("verifyEndpoint does not follow redirects (the Authorization header would follow them)", async () => {
  const target = await serve((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ machine: { id: "x" } })) })
  const redirector = await serve((_req, res) => { res.writeHead(302, { Location: `${target.url}/v1/machine` }); res.end() })
  try {
    const result = await verifyEndpoint({ endpoint: redirector.url, machineId: "x", credentials: { username: "a", password: "b" } })
    assert.equal(result.ok, false)
    assert.match(result.error, /HTTP 302/)
    assert.equal(target.seen.length, 0, "the redirect target never received the credentials")
  } finally {
    await redirector.close()
    await target.close()
  }
})

async function enrolled(store, id, endpoints, { proxyEnabled = true } = {}) {
  await store.enrollMachine({
    info: machineInfo({ id, name: id }), endpoints, credentials: { username: "harness", password: "pw" }, proxyEnabled,
    config: {}, tokenHash: hashToken(`t-${id}`), enrolledVia: "env"
  })
}

function prober(events = []) {
  return new Prober({
    store: db.store,
    config: testConfig(),
    sink: { async machineEvent(machine, type, detail) { events.push({ machine: machine.id, type, detail }) } }
  })
}

test("probeMachine picks the working address among several and remembers it", { skip: skipDatabase }, async () => {
  const machine = await startFakeMachine({ id: "machine_multi", password: "pw" })
  try {
    await enrolled(db.store, "machine_multi", ["http://127.0.0.1:1", machine.url])
    const events = []
    const result = await prober(events).probeMachine("machine_multi")
    assert.equal(result.ok, true)
    assert.equal(result.endpoint, machine.url)
    const row = await db.store.getMachine("machine_multi")
    assert.equal(row.verified_endpoint, machine.url)
    assert.equal(row.last_probe_ok, true)
    assert.deepEqual(events.map((event) => event.type), ["machine.reachable"])

    // Sticky: the known-good address is tried first and alone while it keeps working.
    const before = machine.requests.length
    await prober(events).probeMachine("machine_multi")
    assert.equal(machine.requests.length - before, 1)
    assert.equal(events.length, 1, "no event when nothing changed")
  } finally {
    await machine.close()
  }
})

test("probeMachine records the failure, emits once, and recovers", { skip: skipDatabase }, async () => {
  const machine = await startFakeMachine({ id: "machine_flap", password: "pw" })
  await enrolled(db.store, "machine_flap", [machine.url])
  const events = []
  const p = prober(events)
  assert.equal((await p.probeMachine("machine_flap")).ok, true)

  await machine.close()
  const down = await p.probeMachine("machine_flap")
  assert.equal(down.ok, false)
  assert.match(down.error, /ECONNREFUSED|ECONNRESET/)
  await p.probeMachine("machine_flap")
  const row = await db.store.getMachine("machine_flap")
  assert.equal(row.last_probe_ok, false)
  assert.equal(row.verified_endpoint, machine.url, "the last good address is kept for when it comes back")
  assert.deepEqual(events.map((event) => event.type), ["machine.reachable", "machine.unreachable"], "one event per state change, not per probe")
})

test("machines without shared credentials or addresses are not probed as reachable", { skip: skipDatabase }, async () => {
  await enrolled(db.store, "machine_private_p", ["http://127.0.0.1:1"], { proxyEnabled: false })
  assert.match((await prober().probeMachine("machine_private_p")).error, /did not share credentials/)
  await enrolled(db.store, "machine_noaddr", [])
  assert.match((await prober().probeMachine("machine_noaddr")).error, /advertised no addresses/)
  assert.match((await prober().probeMachine("machine_ghost")).error, /unknown machine/)
})

test("probeAll checks every proxyable machine and tolerates individual failures", { skip: skipDatabase }, async () => {
  const one = await startFakeMachine({ id: "machine_all_1", password: "pw" })
  const two = await startFakeMachine({ id: "machine_all_2", password: "pw" })
  try {
    await enrolled(db.store, "machine_all_1", [one.url])
    await enrolled(db.store, "machine_all_2", [two.url])
    await enrolled(db.store, "machine_all_dead", ["http://127.0.0.1:1"])
    await prober().probeAll()
    assert.equal((await db.store.getMachine("machine_all_1")).last_probe_ok, true)
    assert.equal((await db.store.getMachine("machine_all_2")).last_probe_ok, true)
    assert.equal((await db.store.getMachine("machine_all_dead")).last_probe_ok, false)
  } finally {
    await one.close()
    await two.close()
  }
})

test("probeAll does not overlap itself", { skip: skipDatabase }, async () => {
  const p = prober()
  let concurrent = 0
  let peak = 0
  const original = p.store.proxyTargets.bind(p.store)
  p.store.proxyTargets = async () => { concurrent += 1; peak = Math.max(peak, concurrent); await new Promise((resolve) => setTimeout(resolve, 30)); concurrent -= 1; return original() }
  await Promise.all([p.probeAll(), p.probeAll(), p.probeAll()])
  assert.equal(peak, 1)
})
