import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { hashToken } from "../src/crypto.js"
import { createPool, migrate } from "../src/db.js"
import { ValidationError, machineInfo, parseWhen, sessionList, sessionQuery } from "../src/validate.js"
import { ADMIN_PASSWORD, ENROLLMENT_TOKEN, createTestDatabase, databaseUrl, machinePayload, skipDatabase, startHub } from "./helpers.js"

// "When did it start, when did it last run" — stored per Session, searchable, and never guessed wrong.

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")

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
const heartbeatFor = (id, sessions) => ({
  info: machineInfo({ id }, { partial: true }), endpoints: ["http://10.0.0.5:4097"], credentials: undefined, proxyEnabled: undefined,
  config: { backend: "codex" }, agents: [], stats: {}, sessions
})
const row = async (machineId, sessionId) => (await store.listSessions({ machineId })).find((candidate) => candidate.session_id === sessionId)
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

test("parseWhen reads ISO dates and ages, and refuses anything else", () => {
  const now = Date.parse("2026-09-29T12:00:00Z")
  assert.equal(parseWhen("2026-09-01", now).toISOString(), "2026-09-01T00:00:00.000Z")
  assert.equal(parseWhen("2026-09-29T09:30:00Z", now).toISOString(), "2026-09-29T09:30:00.000Z")
  assert.equal(parseWhen("90m", now).toISOString(), "2026-09-29T10:30:00.000Z")
  assert.equal(parseWhen("24h", now).toISOString(), "2026-09-28T12:00:00.000Z")
  assert.equal(parseWhen("7d", now).toISOString(), "2026-09-22T12:00:00.000Z")
  assert.equal(parseWhen("2 w", now).toISOString(), "2026-09-15T12:00:00.000Z")
  assert.equal(parseWhen("", now), null)
  assert.equal(parseWhen(undefined, now), null)
  for (const bad of ["yesterday", "1700000000", "12", "2026-13-45", "24x", "--1d", "1e9h"]) {
    assert.throws(() => parseWhen(bad, now), ValidationError, `${bad} must be rejected, not ignored`)
  }
})

test("sessionQuery validates every filter once and bounds paging", () => {
  const now = Date.parse("2026-09-29T12:00:00Z")
  const q = sessionQuery(new URLSearchParams("q=parser&activity=working,failed&kind=background&ranAfter=24h&startedBefore=2026-09-01&sort=started&limit=9999&offset=-5&machine=m1&agent=claude"), now)
  assert.deepEqual(q.activities, ["working", "failed"])
  assert.equal(q.kind, "background")
  assert.equal(q.ranAfter.toISOString(), "2026-09-28T12:00:00.000Z")
  assert.equal(q.startedBefore.toISOString(), "2026-09-01T00:00:00.000Z")
  assert.equal(q.sort, "started")
  assert.equal(q.limit, 500)
  assert.equal(q.offset, 0)
  assert.equal(q.machineId, "m1")
  assert.equal(q.agentId, "claude")
  assert.equal(sessionQuery(new URLSearchParams(""), now).sort, "last_ran")
  assert.equal(sessionQuery(new URLSearchParams("sort=; drop table sessions"), now).sort, "last_ran", "an unknown sort falls back, it is never interpolated")
  assert.throws(() => sessionQuery(new URLSearchParams("activity=working,bogus"), now), ValidationError)
  assert.throws(() => sessionQuery(new URLSearchParams("kind=weird"), now), ValidationError)
  assert.throws(() => sessionQuery(new URLSearchParams("ranAfter=soon"), now), ValidationError)
})

test("sessionList takes the new fields and still accepts what older machines send", () => {
  const [modern, legacy, odd] = sessionList([
    { agentId: "claude", id: "a", kind: "background", activity: "completed", detail: "Refactored the parser", status: "done", startedAt: 1_790_000_000_000, lastRanAt: 1_790_000_600_000 },
    { agentId: "codex", id: "b", status: "busy", createdAt: 1_790_000_000_000, updatedAt: 1_790_000_300_000 },
    { agentId: "codex", id: "c", status: "wat", kind: "hacker", activity: "party" }
  ])
  assert.deepEqual([modern.kind, modern.activity, modern.detail], ["background", "completed", "Refactored the parser"])
  assert.equal(modern.created_at, new Date(1_790_000_000_000).toISOString())
  assert.equal(modern.updated_at, new Date(1_790_000_600_000).toISOString())
  assert.deepEqual([legacy.kind, legacy.activity], ["session", "working"], "activity is derived from status for machines that do not send it")
  assert.equal(legacy.updated_at, new Date(1_790_000_300_000).toISOString())
  assert.deepEqual([odd.kind, odd.activity], ["session", "unknown"], "unknown values are normalised, never stored as sent")
})

test("started_at is the earliest start known; a Session nobody dated starts when the hub first saw it", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-start"))
  const send = (sessions) => store.recordHeartbeat("m-start", heartbeatFor("m-start", sessions))
  const base = { agent_id: "codex", title: "T", directory: "/w", status: "idle", kind: "session", activity: "idle", detail: "" }

  const before = Date.now()
  await send([{ ...base, session_id: "undated", created_at: null, updated_at: null }, { ...base, session_id: "dated", created_at: minutesAgo(600), updated_at: minutesAgo(300) }])
  const undated = await row("m-start", "undated")
  assert.ok(Math.abs(undated.started_at.getTime() - before) < 5_000, "an undated Session starts at first sight")
  assert.equal(undated.last_ran_at, null, "idle and never observed running: it has no 'last ran' to claim")
  assert.equal((await row("m-start", "dated")).started_at.toISOString(), minutesAgo(600).slice(0, 19) + ".000Z".slice(0, 0) + (await row("m-start", "dated")).started_at.toISOString().slice(19))

  // A later report of a LATER creation time never moves the start forward; an EARLIER one moves it back.
  await send([{ ...base, session_id: "dated", created_at: minutesAgo(10), updated_at: minutesAgo(5) }])
  assert.ok(Math.abs((await row("m-start", "dated")).started_at.getTime() - Date.parse(minutesAgo(600))) < 2_000)
  await send([{ ...base, session_id: "dated", created_at: minutesAgo(900), updated_at: minutesAgo(5) }])
  assert.ok(Math.abs((await row("m-start", "dated")).started_at.getTime() - Date.parse(minutesAgo(900))) < 2_000)
})

test("last_ran_at is the later of the harness's last activity and the last time it was seen working", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-ran"))
  const send = (sessions) => store.recordHeartbeat("m-ran", heartbeatFor("m-ran", sessions))
  const base = { agent_id: "codex", session_id: "s", title: "T", directory: "/w", created_at: minutesAgo(500), detail: "", kind: "session" }

  await send([{ ...base, status: "idle", activity: "idle", updated_at: minutesAgo(120) }])
  assert.ok(Math.abs((await row("m-ran", "s")).last_ran_at.getTime() - Date.parse(minutesAgo(120))) < 2_000, "the harness's own last-activity time")

  // Now it is running, but the harness's timestamp has not moved: the hub's own observation counts.
  const seen = Date.now()
  await send([{ ...base, status: "busy", activity: "working", updated_at: minutesAgo(120) }])
  assert.ok(Math.abs((await row("m-ran", "s")).last_ran_at.getTime() - seen) < 5_000, "observed working now")

  // It goes idle again with a stale harness timestamp: last_ran_at never goes backwards.
  await send([{ ...base, status: "idle", activity: "idle", updated_at: minutesAgo(120) }])
  assert.ok(Math.abs((await row("m-ran", "s")).last_ran_at.getTime() - seen) < 5_000)

  // And a harness that reports nothing at all still gets a "last ran" the moment it is seen working.
  await send([{ ...base, session_id: "silent", status: "busy", activity: "working", created_at: null, updated_at: null }])
  assert.ok(Math.abs((await row("m-ran", "silent")).last_ran_at.getTime() - Date.now()) < 5_000)
})

test("searchSessions filters by start and last-run time, activity, kind, agent and text, and sorts by either time", { skip: skipDatabase }, async () => {
  await store.enrollMachine(enrollment("m-find", { info: machineInfo({ id: "m-find", name: "Studio Mac" }) }))
  const mk = (id, over) => ({ agent_id: "codex", session_id: id, title: id, directory: "/w", status: "idle", kind: "session", activity: "idle", detail: "", created_at: null, updated_at: null, ...over })
  await store.recordHeartbeat("m-find", heartbeatFor("m-find", [
    mk("old-done", { agent_id: "claude", kind: "background", activity: "completed", status: "done", created_at: minutesAgo(60 * 24 * 10), updated_at: minutesAgo(60 * 24 * 9) }),
    mk("recent-failed", { agent_id: "claude", kind: "background", activity: "failed", status: "failed", created_at: minutesAgo(200), updated_at: minutesAgo(30) }),
    mk("busy-now", { status: "busy", activity: "working", created_at: minutesAgo(50), updated_at: minutesAgo(1), title: "Fix the flaky parser test" }),
    mk("waiting", { status: "waiting", activity: "needs_input", created_at: minutesAgo(400), updated_at: minutesAgo(90) })
  ]))
  const ids = async (filters) => (await store.searchSessions({ machineId: "m-find", ...filters })).rows.map((r) => r.session_id)
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000)

  assert.deepEqual(await ids({}), ["busy-now", "recent-failed", "waiting", "old-done"], "most recently run first by default")
  assert.deepEqual(await ids({ sort: "started" }), ["busy-now", "recent-failed", "waiting", "old-done"].sort((a, b) => order(a) - order(b)), "or most recently started first")
  function order(id) { return { "busy-now": 0, "recent-failed": 1, waiting: 2, "old-done": 3 }[id] }

  assert.deepEqual(await ids({ ranAfter: ago(60) }), ["busy-now", "recent-failed"], "ran in the last hour")
  assert.deepEqual(await ids({ ranBefore: ago(60) }), ["waiting", "old-done"], "did not run in the last hour")
  assert.deepEqual(await ids({ startedAfter: ago(60 * 24) }), ["busy-now", "recent-failed", "waiting"], "started in the last day")
  assert.deepEqual(await ids({ startedBefore: ago(60 * 24) }), ["old-done"], "started more than a day ago")
  assert.deepEqual(await ids({ startedAfter: ago(300), ranAfter: ago(45) }), ["busy-now", "recent-failed"], "both windows must hold")

  assert.deepEqual(await ids({ activities: ["failed"] }), ["recent-failed"])
  assert.deepEqual(await ids({ activities: ["completed", "failed"] }), ["recent-failed", "old-done"])
  assert.deepEqual(await ids({ activities: ["active"] }), ["busy-now", "waiting"], "'active' means working or waiting on a person")
  assert.deepEqual(await ids({ status: "active" }), ["busy-now", "waiting"], "the older status=active shorthand still works")
  assert.deepEqual(await ids({ kind: "background" }), ["recent-failed", "old-done"])
  assert.deepEqual(await ids({ agentId: "claude" }), ["recent-failed", "old-done"])
  assert.deepEqual(await ids({ query: "flaky" }), ["busy-now"])
  assert.deepEqual(await ids({ query: "studio mac" }), ["busy-now", "recent-failed", "waiting", "old-done"], "the machine's name is searchable too")
  assert.deepEqual(await ids({ query: "RECENT-fail" }), ["recent-failed"], "case-insensitive, matches the Session id")

  const page = await store.searchSessions({ machineId: "m-find", limit: 2, offset: 1 })
  assert.deepEqual(page.rows.map((r) => r.session_id), ["recent-failed", "waiting"])
  assert.equal(page.total, 4, "total counts every match, not just the page")
})

test("migration 002 backfills existing rows: start from creation (else first sight), last ran from the harness time", { skip: skipDatabase }, async () => {
  const schema = `t_${randomBytes(6).toString("hex")}`
  const admin = createPool({ databaseUrl })
  await admin.query(`create schema ${schema}`)
  const pool = createPool({ databaseUrl, schema })
  const dir = await mkdtemp(path.join(os.tmpdir(), "hub-mig-"))
  try {
    await mkdir(dir, { recursive: true })
    await cp(path.join(migrationsDir, "001_init.sql"), path.join(dir, "001_init.sql"))
    await migrate(pool, dir)
    await pool.query("insert into machines (id, name, token_hash, enrolled_via) values ('m', 'm', 'h', 'test')")
    await pool.query(`insert into sessions (machine_id, agent_id, session_id, status, created_at, updated_at, first_seen_at) values
      ('m','a','dated','busy','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','2026-03-01T00:00:00Z'),
      ('m','a','undated','idle',null,null,'2026-03-01T00:00:00Z'),
      ('m','a','waiting','waiting',null,null,'2026-03-01T00:00:00Z'),
      ('m','a','odd','banana',null,null,'2026-03-01T00:00:00Z')`)
    await cp(path.join(migrationsDir, "002_session_activity.sql"), path.join(dir, "002_session_activity.sql"))
    assert.deepEqual(await migrate(pool, dir), ["002_session_activity.sql"])
    const rows = Object.fromEntries((await pool.query("select * from sessions")).rows.map((r) => [r.session_id, r]))
    assert.equal(rows.dated.started_at.toISOString(), "2026-01-01T00:00:00.000Z")
    assert.equal(rows.dated.last_ran_at.toISOString(), "2026-01-02T00:00:00.000Z")
    assert.equal(rows.dated.activity, "working")
    assert.equal(rows.undated.started_at.toISOString(), "2026-03-01T00:00:00.000Z", "no creation time: first sight")
    assert.equal(rows.undated.last_ran_at, null)
    assert.equal(rows.waiting.activity, "needs_input")
    assert.equal(rows.odd.activity, "unknown")
    assert.ok(Object.values(rows).every((r) => r.kind === "session"))
    assert.deepEqual(await migrate(pool, dir), [], "and it is idempotent")
  } finally {
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
    await rm(dir, { recursive: true, force: true })
  }
})

test("the sessions API exposes startedAt / lastRanAt, searches by time, and rejects a bad date with a 400", { skip: skipDatabase }, async () => {
  const hub = await startHub({ ...db })
  try {
    await hub.request("/api/v1/machines/enroll", { method: "POST", auth: ENROLLMENT_TOKEN, json: machinePayload({ machine: { id: "machine_api_times" } }) })
    const machineToken = (await hub.request("/api/v1/machines/enroll", { method: "POST", auth: ENROLLMENT_TOKEN, json: machinePayload({ machine: { id: "machine_api_times" } }) })).json.token
    await hub.request("/api/v1/machines/heartbeat", {
      method: "POST", auth: machineToken,
      json: {
        sessions: [
          { agentId: "claude", id: "old", kind: "background", activity: "completed", status: "done", title: "Old job", startedAt: Date.now() - 10 * 86_400_000, lastRanAt: Date.now() - 9 * 86_400_000 },
          { agentId: "codex", id: "new", status: "busy", title: "New work", startedAt: Date.now() - 3_600_000, lastRanAt: Date.now() - 60_000 }
        ],
        sessionAgents: []
      }
    })
    assert.equal((await hub.login(ADMIN_PASSWORD)).status, 200)
    const all = (await hub.request("/api/v1/sessions?machine=machine_api_times")).json
    assert.equal(all.total, 2)
    assert.deepEqual(all.sessions.map((s) => s.id), ["new", "old"])
    const fresh = all.sessions[0]
    assert.equal(fresh.activity, "working")
    assert.ok(Math.abs(Date.parse(fresh.startedAt) - (Date.now() - 3_600_000)) < 10_000)
    assert.ok(Math.abs(Date.parse(fresh.lastRanAt) - Date.now()) < 10_000, "observed running: last ran is now")
    assert.deepEqual(all.sessions[1].kind, "background")

    const lastDay = (await hub.request("/api/v1/sessions?machine=machine_api_times&ranAfter=24h")).json
    assert.deepEqual(lastDay.sessions.map((s) => s.id), ["new"])
    const older = (await hub.request("/api/v1/sessions?machine=machine_api_times&startedBefore=7d&activity=completed")).json
    assert.deepEqual(older.sessions.map((s) => s.id), ["old"])
    const bad = await hub.request("/api/v1/sessions?ranAfter=whenever")
    assert.equal(bad.status, 400)
    assert.match(bad.json.message, /not a date/)
  } finally {
    await hub.close()
  }
})
