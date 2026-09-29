import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { hashToken } from "../src/crypto.js"
import { machineInfo } from "../src/validate.js"
import { createTestDatabase, skipDatabase } from "./helpers.js"

let db
let store
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  store = db.store
})
after(async () => db?.drop())

const enrollment = (id, overrides = {}) => ({
  info: machineInfo({ id, name: `name-${id}`, hostname: `${id}.local`, platform: "linux", arch: "x64", nodeVersion: "22.0.0", version: "3.1.0" }),
  endpoints: ["http://10.0.0.5:4097"],
  credentials: { username: "harness", password: "hunter2-gateway" },
  proxyEnabled: true,
  config: { backend: "codex" },
  tokenHash: hashToken(`token-${id}`),
  enrolledVia: "env",
  ...overrides
})

const heartbeat = (overrides = {}) => ({
  info: machineInfo({ id: "x", name: "renamed" }),
  endpoints: ["http://10.0.0.5:4097"],
  credentials: undefined,
  proxyEnabled: undefined,
  config: { backend: "codex" },
  agents: [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available" }],
  stats: { uptimeSeconds: 5 },
  sessions: [],
  ...overrides
})

const session = (id, status = "idle", extra = {}) => ({
  agent_id: "codex", session_id: id, title: `Session ${id}`, directory: "/work", status, created_at: null, updated_at: "2026-05-01T00:00:00.000Z", ...extra
})

test("migrations are idempotent", { skip: skipDatabase }, async () => {
  const { migrate } = await import("../src/db.js")
  const path = await import("node:path")
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "migrations")
  assert.deepEqual(await migrate(db.pool, dir), [])
})

test("enrolling twice keeps one row, rotates the token and clears the verified endpoint", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-rotate"))
  await store.recordProbe("m-rotate", { ok: true, endpoint: "http://10.0.0.5:4097", ms: 4 })
  const again = await store.enrollMachine(enrollment("m-rotate", { tokenHash: hashToken("second") }))
  assert.equal(again.verified_endpoint, null)
  assert.equal(await store.machineByTokenHash(hashToken("token-m-rotate")), undefined, "old token is dead")
  assert.equal((await store.machineByTokenHash(hashToken("second"))).id, "m-rotate")
  assert.equal((await store.listMachines()).filter((machine) => machine.id === "m-rotate").length, 1)
})

test("credentials are sealed at rest and round-trip through machineCredentials", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-seal"))
  const raw = (await db.pool.query("select credentials_enc from machines where id = 'm-seal'")).rows[0].credentials_enc
  assert.ok(Buffer.isBuffer(raw))
  assert.ok(!raw.includes(Buffer.from("hunter2-gateway")), "plaintext password must not be in the row")
  assert.deepEqual(await store.machineCredentials("m-seal"), { username: "harness", password: "hunter2-gateway" })
})

test("enrolling without proxy stores no credentials even if some were sent", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-noproxy", { proxyEnabled: false }))
  assert.equal(await store.machineCredentials("m-noproxy"), null)
  assert.equal((await store.getMachine("m-noproxy")).proxy_enabled, false)
})

test("undecryptable credentials read as absent instead of throwing", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-badkey"))
  await db.pool.query("update machines set credentials_enc = $1 where id = 'm-badkey'", [Buffer.from("garbage-not-sealed-at-all-xxxxxxxxxxxx")])
  assert.equal(await store.machineCredentials("m-badkey"), null)
})

test("heartbeat updates state, records config history only on change", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-hb"))
  const before = await store.configHistory("m-hb")
  assert.equal(before.length, 1, "enrollment records the first config")

  await store.recordHeartbeat("m-hb", heartbeat({ info: machineInfo({ id: "m-hb", name: "renamed" }) }))
  assert.equal((await store.configHistory("m-hb")).length, 1, "same config: no new history")

  const changed = await store.recordHeartbeat("m-hb", heartbeat({ info: machineInfo({ id: "m-hb", name: "renamed" }), config: { backend: "claude", roots: ["/a"] } }))
  assert.equal(changed.configChanged, true)
  assert.equal((await store.configHistory("m-hb")).length, 2)

  const row = await store.getMachine("m-hb")
  assert.equal(row.name, "renamed")
  assert.equal(row.agents[0].state, "available")
  assert.deepEqual(row.config, { backend: "claude", roots: ["/a"] })
  assert.ok(row.last_heartbeat_at)
})

test("config history ignores key order", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-order", { config: { a: 1, b: { c: 2, d: 3 } } }))
  await store.recordHeartbeat("m-order", heartbeat({ info: machineInfo({ id: "m-order" }), config: { b: { d: 3, c: 2 }, a: 1 } }))
  assert.equal((await store.configHistory("m-order")).length, 1)
})

test("heartbeat keeps credentials unless replaced or proxy is switched off", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-creds"))
  await store.recordHeartbeat("m-creds", heartbeat({ info: machineInfo({ id: "m-creds" }) }))
  assert.equal((await store.machineCredentials("m-creds")).password, "hunter2-gateway")

  await store.recordHeartbeat("m-creds", heartbeat({ info: machineInfo({ id: "m-creds" }), credentials: { username: "harness", password: "rotated-after-restart" }, proxyEnabled: true }))
  assert.equal((await store.machineCredentials("m-creds")).password, "rotated-after-restart")

  await store.recordHeartbeat("m-creds", heartbeat({ info: machineInfo({ id: "m-creds" }), proxyEnabled: false }))
  assert.equal(await store.machineCredentials("m-creds"), null, "opting out deletes the stored credentials")
  assert.equal((await store.getMachine("m-creds")).proxy_enabled, false)
})

test("heartbeat drops a verified endpoint the machine no longer advertises", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-ep"))
  await store.recordProbe("m-ep", { ok: true, endpoint: "http://10.0.0.5:4097", ms: 3 })
  await store.recordHeartbeat("m-ep", heartbeat({ info: machineInfo({ id: "m-ep" }), endpoints: ["http://10.0.0.5:4097"] }))
  assert.equal((await store.getMachine("m-ep")).verified_endpoint, "http://10.0.0.5:4097")
  await store.recordHeartbeat("m-ep", heartbeat({ info: machineInfo({ id: "m-ep" }), endpoints: ["http://10.0.0.99:4097"] }))
  assert.equal((await store.getMachine("m-ep")).verified_endpoint, null)
})

test("heartbeat for an unknown machine returns null", { skip: skipDatabase }, async () => {
  assert.equal(await store.recordHeartbeat("nope", heartbeat()), null)
})

test("session upsert reports created and status transitions, not no-ops", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-sess"))
  const send = (sessions) => store.recordHeartbeat("m-sess", heartbeat({ info: machineInfo({ id: "m-sess" }), sessions }))

  const first = await send([session("a", "idle"), session("b", "busy")])
  assert.deepEqual(first.transitions.map((entry) => [entry.type, entry.session.session_id, entry.from, entry.to]), [
    ["session.created", "a", null, "idle"],
    ["session.created", "b", null, "busy"]
  ])

  const second = await send([session("a", "busy"), session("b", "busy")])
  assert.deepEqual(second.transitions.map((entry) => [entry.type, entry.session.session_id, entry.from, entry.to]), [
    ["session.status", "a", "idle", "busy"]
  ])

  const third = await send([session("a", "busy"), session("b", "busy")])
  assert.deepEqual(third.transitions, [], "identical report is quiet")
})

test("duplicate sessions in one batch do not crash the upsert (last wins)", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-dup"))
  await store.recordHeartbeat("m-dup", heartbeat({ info: machineInfo({ id: "m-dup" }), sessions: [session("x", "idle"), session("x", "busy")] }))
  const rows = await store.listSessions({ machineId: "m-dup" })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, "busy")
})

test("a missing timestamp does not erase one already known", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-ts"))
  const send = (sessions) => store.recordHeartbeat("m-ts", heartbeat({ info: machineInfo({ id: "m-ts" }), sessions }))
  await send([session("t", "idle", { created_at: "2026-01-01T00:00:00.000Z" })])
  await send([session("t", "idle", { created_at: null, updated_at: null })])
  const [row] = await store.listSessions({ machineId: "m-ts" })
  assert.equal(new Date(row.created_at).toISOString(), "2026-01-01T00:00:00.000Z")
})

test("listSessions filters by status/active/search and escapes LIKE wildcards", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-list"))
  await store.recordHeartbeat("m-list", heartbeat({
    info: machineInfo({ id: "m-list" }),
    sessions: [
      session("1", "busy", { title: "Refactor 100% of auth" }),
      session("2", "idle", { title: "Refactor authXof things" }),
      session("3", "waiting", { title: "Docs", directory: "/srv/site" }),
      session("4", "retry", { title: "under_score" })
    ]
  }))
  const titles = async (filter) => (await store.listSessions({ machineId: "m-list", ...filter })).map((row) => row.title).sort()
  assert.deepEqual(await titles({ status: "active" }), ["Docs", "Refactor 100% of auth", "under_score"])
  assert.deepEqual(await titles({ status: "idle" }), ["Refactor authXof things"])
  assert.deepEqual(await titles({ query: "100%" }), ["Refactor 100% of auth"], "% is literal")
  assert.deepEqual(await titles({ query: "under_score" }), ["under_score"])
  assert.deepEqual(await titles({ query: "r_score" }), ["under_score"])
  assert.deepEqual(await titles({ query: "a_b" }), [], "_ is literal, not any-character")
  assert.deepEqual(await titles({ query: "/srv" }), ["Docs"], "matches directory too")
  assert.equal((await store.listSessions({ machineId: "m-list", limit: 2 })).length, 2)
})

test("machine list carries session counts and sorts by display name", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-count"))
  await store.recordHeartbeat("m-count", heartbeat({ info: machineInfo({ id: "m-count" }), sessions: [session("1", "busy"), session("2", "idle")] }))
  const row = await store.getMachine("m-count")
  assert.equal(row.session_total, 2)
  assert.equal(row.session_active, 1)
  await store.setDisplayName("m-count", "AAA first")
  assert.equal((await store.listMachines())[0].id, "m-count")
  await store.setDisplayName("m-count", null)
  assert.equal((await store.getMachine("m-count")).display_name, null)
  assert.equal(await store.setDisplayName("ghost", "x"), false)
})

test("deleting a machine cascades to its sessions and history", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-del"))
  await store.recordHeartbeat("m-del", heartbeat({ info: machineInfo({ id: "m-del" }), sessions: [session("1")] }))
  assert.equal(await store.deleteMachine("m-del"), true)
  assert.equal(await store.deleteMachine("m-del"), false)
  assert.equal((await store.listSessions({ machineId: "m-del" })).length, 0)
  assert.equal((await store.configHistory("m-del")).length, 0)
})

test("recordProbe stores latency on success and only the error on failure", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-probe"))
  await store.recordProbe("m-probe", { ok: true, endpoint: "http://10.0.0.5:4097", ms: 12 })
  let row = await store.getMachine("m-probe")
  assert.equal(row.last_probe_ok, true)
  assert.equal(row.last_probe_ms, 12)
  assert.equal(row.verified_endpoint, "http://10.0.0.5:4097")

  await store.recordProbe("m-probe", { ok: false, error: "timeout" })
  row = await store.getMachine("m-probe")
  assert.equal(row.last_probe_ok, false)
  assert.equal(row.last_probe_ms, null)
  assert.equal(row.last_probe_error, "timeout")
  assert.equal(row.verified_endpoint, "http://10.0.0.5:4097", "a failed probe does not forget the last good address")
})

test("proxyTargets lists only machines that shared credentials", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-t1"))
  await store.enrollMachine(enrollment("m-t2", { proxyEnabled: false }))
  const ids = (await store.proxyTargets()).map((row) => row.id)
  assert.ok(ids.includes("m-t1"))
  assert.ok(!ids.includes("m-t2"))
})

test("enrollment tokens: consume counts uses, honours expiry and revocation", { skip: skipDatabase }, async () => {
  const live = await store.createEnrollmentToken({ label: "laptop", tokenHash: hashToken("live") })
  await store.createEnrollmentToken({ label: "expired", tokenHash: hashToken("expired"), expiresAt: new Date(Date.now() - 1_000) })
  const revoked = await store.createEnrollmentToken({ label: "revoked", tokenHash: hashToken("revoked") })
  assert.equal(await store.revokeEnrollmentToken(revoked.id), true)
  assert.equal(await store.revokeEnrollmentToken(revoked.id), false, "already revoked")

  assert.equal((await store.consumeEnrollmentToken(hashToken("live"))).id, live.id)
  assert.equal((await store.consumeEnrollmentToken(hashToken("live"))).id, live.id, "multi-use")
  assert.equal(await store.consumeEnrollmentToken(hashToken("expired")), undefined)
  assert.equal(await store.consumeEnrollmentToken(hashToken("revoked")), undefined)
  assert.equal(await store.consumeEnrollmentToken(hashToken("unknown")), undefined)

  const listed = (await store.listEnrollmentTokens()).find((token) => token.id === live.id)
  assert.equal(listed.use_count, 2)
  assert.ok(!("token_hash" in listed), "the hash is never listed")
})

test("pruneSessions removes only long-unseen sessions", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-prune"))
  await store.recordHeartbeat("m-prune", heartbeat({ info: machineInfo({ id: "m-prune" }), sessions: [session("old"), session("new")] }))
  await db.pool.query("update sessions set last_seen_at = now() - interval '200 days' where machine_id = 'm-prune' and session_id = 'old'")
  assert.equal(await store.pruneSessions(90) >= 1, true)
  assert.deepEqual((await store.listSessions({ machineId: "m-prune" })).map((row) => row.session_id), ["new"])
})
