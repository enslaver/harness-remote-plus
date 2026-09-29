import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { ADMIN_PASSWORD, ENROLLMENT_TOKEN, createTestDatabase, machinePayload, skipDatabase, startHub, testConfig } from "./helpers.js"

let db
let hub
const events = []
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  hub = await startHub({
    ...db,
    sink: {
      async machineEvent(machine, type, detail) { events.push({ machine: machine?.id ?? null, type, detail }) },
      async sessionTransitions(machine, transitions) { events.push({ machine: machine.id, type: "transitions", transitions }) }
    }
  })
})
after(async () => {
  await hub?.close()
  await db?.drop()
})

async function enroll(payload = machinePayload(), token = ENROLLMENT_TOKEN) {
  return hub.request("/api/v1/machines/enroll", { method: "POST", json: payload, auth: token })
}

test("liveness is public; readiness reports the database", { skip: skipDatabase }, async () => {
  assert.deepEqual((await hub.request("/healthz")).json, { ok: true })
  const ready = await hub.request("/readyz")
  assert.equal(ready.status, 200)
  assert.equal(ready.json.checks.database, true)
})

test("admin API refuses anonymous callers without inviting a native auth prompt", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  for (const [method, path] of [
    ["GET", "/api/v1/machines"], ["GET", "/api/v1/machines/x"], ["DELETE", "/api/v1/machines/x"], ["PATCH", "/api/v1/machines/x"],
    ["GET", "/api/v1/sessions"], ["GET", "/api/v1/stats"], ["GET", "/api/v1/enrollment-tokens"], ["POST", "/api/v1/enrollment-tokens"],
    ["DELETE", "/api/v1/enrollment-tokens/00000000-0000-0000-0000-000000000000"], ["GET", "/api/v1/auth/me"]
  ]) {
    const response = await hub.request(path, { method, json: method === "GET" ? undefined : {} })
    assert.equal(response.status, 401, `${method} ${path}`)
    assert.equal(response.json.error, "unauthenticated")
    assert.equal(response.headers.get("www-authenticate"), null, "a WWW-Authenticate header would pop a browser password dialog")
  }
})

test("unknown routes are 404 and wrong methods 405", { skip: skipDatabase }, async () => {
  assert.equal((await hub.request("/api/v1/nope")).status, 404)
  assert.equal((await hub.request("/healthz", { method: "POST" })).status, 405)
})

test("responses carry hardening headers", { skip: skipDatabase }, async () => {
  const response = await hub.request("/healthz")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.equal(response.headers.get("x-frame-options"), "DENY")
  assert.equal(response.headers.get("cache-control"), "no-store")
})

test("login: wrong password is 401, right password sets a cookie that unlocks the API", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  const wrong = await hub.login("nope")
  assert.equal(wrong.status, 401)
  assert.equal(wrong.headers.get("set-cookie"), null)

  const ok = await hub.login()
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get("set-cookie"), /HttpOnly/)
  assert.equal((await hub.request("/api/v1/auth/me")).status, 200)

  await hub.request("/api/v1/auth/logout", { method: "POST" })
  assert.equal((await hub.request("/api/v1/auth/me")).status, 401, "logout clears the cookie")
})

test("login is throttled after repeated failures, even for the right password", { skip: skipDatabase }, async () => {
  const isolated = await startHub({ ...db })
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await isolated.login("wrong")).status, 401)
    const blocked = await isolated.login(ADMIN_PASSWORD)
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get("retry-after")) > 0)
  } finally {
    await isolated.close()
  }
})

test("cross-site state-changing requests are rejected even with a valid cookie", { skip: skipDatabase }, async () => {
  await hub.login()
  const forged = await hub.request("/api/v1/enrollment-tokens", { method: "POST", json: { label: "evil" }, headers: { "Sec-Fetch-Site": "cross-site" } })
  assert.equal(forged.status, 403)
  const wrongOrigin = await hub.request("/api/v1/enrollment-tokens", { method: "POST", json: { label: "evil" }, headers: { Origin: "https://evil.example" } })
  assert.equal(wrongOrigin.status, 403)
  const loginForged = await hub.request("/api/v1/auth/login", { method: "POST", json: { password: ADMIN_PASSWORD }, headers: { "Sec-Fetch-Site": "cross-site" } })
  assert.equal(loginForged.status, 403)
  const legit = await hub.request("/api/v1/enrollment-tokens", { method: "POST", json: { label: "ok" }, headers: { "Sec-Fetch-Site": "same-origin" } })
  assert.equal(legit.status, 201)
})

test("enrollment: bad or missing token is refused; the env token and DB tokens both work", { skip: skipDatabase }, async () => {
  assert.equal((await enroll(machinePayload(), "wrong-token-value")).status, 401)
  assert.equal((await hub.request("/api/v1/machines/enroll", { method: "POST", json: machinePayload() })).status, 401)

  const viaEnv = await enroll(machinePayload({ machine: { id: "machine_env" } }))
  assert.equal(viaEnv.status, 200)
  assert.match(viaEnv.json.token, /^hrm_/)
  assert.equal(viaEnv.json.machineId, "machine_env")
  assert.ok(viaEnv.json.heartbeatIntervalMs > 0)

  await hub.login()
  const created = await hub.request("/api/v1/enrollment-tokens", { method: "POST", json: { label: "phone", expiresInHours: 1 } })
  assert.equal(created.status, 201)
  assert.match(created.json.token, /^hre_/)
  const viaDb = await enroll(machinePayload({ machine: { id: "machine_db" } }), created.json.token)
  assert.equal(viaDb.status, 200)

  const listed = (await hub.request("/api/v1/enrollment-tokens")).json
  const entry = listed.tokens.find((token) => token.id === created.json.id)
  assert.equal(entry.useCount, 1)
  assert.equal(listed.staticToken, true)
  assert.ok(!JSON.stringify(listed).includes(created.json.token), "the plaintext token is shown once, at creation")

  assert.equal((await hub.request(`/api/v1/enrollment-tokens/${created.json.id}`, { method: "DELETE" })).status, 200)
  assert.equal((await enroll(machinePayload({ machine: { id: "machine_db2" } }), created.json.token)).status, 401, "revoked")
})

test("enrollment rejects malformed machine payloads", { skip: skipDatabase }, async () => {
  assert.equal((await enroll({ machine: { name: "no id" } })).status, 400)
  assert.equal((await enroll({ machine: { id: "../../etc" } })).status, 400)
  assert.equal((await hub.request("/api/v1/machines/enroll", { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" }, auth: ENROLLMENT_TOKEN })).status, 400)
  assert.equal((await hub.request("/api/v1/machines/enroll", { method: "POST", body: "[]", headers: { "Content-Type": "application/json" }, auth: ENROLLMENT_TOKEN })).status, 400)
})

test("oversized bodies are refused before parsing", { skip: skipDatabase }, async () => {
  const huge = JSON.stringify({ machine: { id: "machine_big" }, config: { pad: "x".repeat(100_000) } })
  assert.equal((await hub.request("/api/v1/machines/enroll", { method: "POST", body: huge, headers: { "Content-Type": "application/json" }, auth: ENROLLMENT_TOKEN })).status, 413)
})

test("link-local endpoints are dropped at enrollment", { skip: skipDatabase }, async () => {
  const response = await enroll(machinePayload({ machine: { id: "machine_ssrf" }, endpoints: ["http://169.254.169.254", "http://[::ffff:a9fe:a9fe]", "http://10.1.1.1:4097"] }))
  assert.equal(response.status, 200)
  await hub.login()
  const { machine } = (await hub.request("/api/v1/machines/machine_ssrf")).json
  assert.deepEqual(machine.endpoints, ["http://10.1.1.1:4097"])
})

test("heartbeat: token authenticates, sessions are stored, transitions reach the sink", { skip: skipDatabase }, async () => {
  const { json: { token } } = await enroll(machinePayload({ machine: { id: "machine_hb" } }))
  const beat = (body) => hub.request("/api/v1/machines/heartbeat", { method: "POST", json: body, auth: token })

  const first = await beat({
    machine: { id: "machine_hb", name: "workstation" },
    endpoints: ["http://10.0.0.7:4097"],
    config: { backend: "codex" },
    agents: [{ id: "codex", label: "Codex", state: "available" }],
    stats: { uptimeSeconds: 42 },
    sessions: [{ agentId: "codex", id: "s1", title: "Add tests", directory: "/repo", status: "busy", updatedAt: Date.now() }]
  })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.needCredentials, false)
  assert.ok(events.some((event) => event.type === "transitions" && event.machine === "machine_hb" && event.transitions[0].type === "session.created"))

  await hub.login()
  const detail = (await hub.request("/api/v1/machines/machine_hb")).json
  assert.equal(detail.machine.name, "workstation")
  assert.equal(detail.machine.status, "online")
  assert.equal(detail.machine.agents[0].state, "available")
  assert.equal(detail.machine.stats.uptimeSeconds, 42)
  assert.deepEqual(detail.machine.sessions, { total: 1, active: 1 })
  assert.equal(detail.sessions[0].title, "Add tests")
  assert.ok(detail.configHistory.length >= 1)

  const sessions = (await hub.request("/api/v1/sessions?status=active&q=tests")).json.sessions
  assert.deepEqual(sessions.map((session) => session.id), ["s1"])
  assert.equal(sessions[0].machineName, "workstation")
})

test("heartbeat token is bound to its machine and admin cookies are not machine tokens", { skip: skipDatabase }, async () => {
  const { json: { token } } = await enroll(machinePayload({ machine: { id: "machine_bound" } }))
  const wrong = await hub.request("/api/v1/machines/heartbeat", { method: "POST", json: { machine: { id: "someone_else" } }, auth: token })
  assert.equal(wrong.status, 400)
  assert.equal(wrong.json.error, "machine_mismatch")

  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/machines/heartbeat", { method: "POST", json: {} })).status, 401)
  assert.equal((await hub.request("/api/v1/machines/heartbeat", { method: "POST", json: {}, auth: "hrm_forged" })).status, 401)
  await hub.login()
  assert.equal((await hub.request("/api/v1/machines/heartbeat", { method: "POST", json: {} })).status, 401, "a browser session is not a machine identity")
  // ...and a machine token is not an admin session.
  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/machines", { auth: token })).status, 401)
})

test("heartbeat asks for credentials again when the hub has none", { skip: skipDatabase }, async () => {
  const { json: { token } } = await enroll(machinePayload({ machine: { id: "machine_need" } }))
  await db.pool.query("update machines set credentials_enc = null where id = 'machine_need'")
  const beat = (body = {}) => hub.request("/api/v1/machines/heartbeat", { method: "POST", json: { machine: { id: "machine_need" }, proxy: true, ...body }, auth: token })
  assert.equal((await beat()).json.needCredentials, true)
  assert.equal((await beat({ credentials: { username: "harness", password: "fresh-password" } })).json.needCredentials, false)
})

test("deleting a machine revokes its token immediately", { skip: skipDatabase }, async () => {
  const { json: { token } } = await enroll(machinePayload({ machine: { id: "machine_gone" } }))
  await hub.login()
  assert.equal((await hub.request("/api/v1/machines/machine_gone", { method: "DELETE" })).status, 200)
  assert.equal((await hub.request("/api/v1/machines/machine_gone", { method: "DELETE" })).status, 404)
  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/machines/heartbeat", { method: "POST", json: {}, auth: token })).status, 401)
  assert.ok(events.some((event) => event.type === "machine.removed" && event.machine === "machine_gone"))
})

test("no API response ever contains credentials, token hashes or sealed blobs", { skip: skipDatabase }, async () => {
  await enroll(machinePayload({ machine: { id: "machine_leak" }, credentials: { username: "harness", password: "UNIQUE-LEAK-CANARY-9931" } }))
  await hub.login()
  const created = (await hub.request("/api/v1/enrollment-tokens", { method: "POST", json: { label: "canary" } })).json
  const bodies = [
    (await hub.request("/api/v1/machines")).text,
    (await hub.request("/api/v1/machines/machine_leak")).text,
    (await hub.request("/api/v1/sessions")).text,
    (await hub.request("/api/v1/bootstrap")).text,
    (await hub.request("/api/v1/enrollment-tokens")).text
  ].join("\n")
  for (const secret of ["UNIQUE-LEAK-CANARY-9931", "token_hash", "credentials_enc", "tokenHash", ENROLLMENT_TOKEN]) {
    assert.ok(!bodies.includes(secret), `leaked: ${secret}`)
  }
  assert.ok(!bodies.includes(created.token), "enrollment token plaintext appears only in the creation response")
})

test("rename via PATCH shows in the machine name; blank resets it", { skip: skipDatabase }, async () => {
  await enroll(machinePayload({ machine: { id: "machine_rename", name: "reported" } }))
  await hub.login()
  await hub.request("/api/v1/machines/machine_rename", { method: "PATCH", json: { displayName: "  Living room Mac  " } })
  let machine = (await hub.request("/api/v1/machines/machine_rename")).json.machine
  assert.equal(machine.name, "Living room Mac")
  assert.equal(machine.reportedName, "reported")
  await hub.request("/api/v1/machines/machine_rename", { method: "PATCH", json: { displayName: "   " } })
  machine = (await hub.request("/api/v1/machines/machine_rename")).json.machine
  assert.equal(machine.name, "reported")
  assert.equal((await hub.request("/api/v1/machines/machine_rename", { method: "PATCH", json: { displayName: 5 } })).status, 400)
  assert.equal((await hub.request("/api/v1/machines/ghost", { method: "PATCH", json: { displayName: "x" } })).status, 404)
})

test("machines report offline once heartbeats stop", { skip: skipDatabase }, async () => {
  let time = Date.now()
  const clocked = await startHub({ ...db, config: testConfig({ HUB_OFFLINE_AFTER_MS: "60000" }), now: () => time })
  try {
    await clocked.request("/api/v1/machines/enroll", { method: "POST", json: machinePayload({ machine: { id: "machine_clock" } }), auth: ENROLLMENT_TOKEN })
    await clocked.login()
    assert.equal((await clocked.request("/api/v1/machines/machine_clock")).json.machine.status, "online")
    time += 61_000
    assert.equal((await clocked.request("/api/v1/machines/machine_clock")).json.machine.status, "offline")
  } finally {
    await clocked.close()
  }
})

test("bootstrap: signed-out callers get 200 + authenticated:false (no red console error); only proxyable machines when signed in", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  const anonymous = await hub.request("/api/v1/bootstrap")
  assert.equal(anonymous.status, 200)
  assert.deepEqual(anonymous.json, { hub: true, authenticated: false, name: "Harness Remote Hub" })
  assert.equal(anonymous.headers.get("www-authenticate"), null)
  assert.ok(!("machines" in anonymous.json), "nothing about the fleet is disclosed before sign-in")

  await enroll(machinePayload({ machine: { id: "machine_boot_yes" } }))
  await enroll(machinePayload({ machine: { id: "machine_boot_no" }, proxy: false }))
  await hub.login()
  const boot = (await hub.request("/api/v1/bootstrap")).json
  assert.equal(boot.hub, true)
  assert.equal(boot.authenticated, true)
  const ids = boot.machines.map((machine) => machine.id)
  assert.ok(ids.includes("machine_boot_yes"))
  assert.ok(!ids.includes("machine_boot_no"), "a machine that kept its credentials cannot be opened through the hub")
  const entry = boot.machines.find((machine) => machine.id === "machine_boot_yes")
  assert.equal(entry.basePath, "/m/machine_boot_yes")
  assert.equal(entry.proxyReady, false, "not verified reachable yet")
  assert.match(boot.publicUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test("stats summarises the fleet", { skip: skipDatabase }, async () => {
  await hub.login()
  const stats = (await hub.request("/api/v1/stats")).json
  assert.ok(stats.machines >= 1)
  assert.equal(typeof stats.sessions, "number")
})
