import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { LokiSink } from "../src/events.js"
import { LokiClient } from "../src/loki.js"
import { ENROLLMENT_TOKEN, createTestDatabase, machinePayload, skipDatabase, startFakeLoki, startHub } from "./helpers.js"

let db
let fakeLoki
let hub
let bare
let token
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  fakeLoki = await startFakeLoki()
  const loki = new LokiClient({ url: fakeLoki.url })
  hub = await startHub({ ...db, loki, sink: new LokiSink({ loki }) })
  bare = await startHub({ ...db })
  const enrolled = await hub.request("/api/v1/machines/enroll", { method: "POST", json: machinePayload({ machine: { id: "machine_logs", name: "Log box" } }), auth: ENROLLMENT_TOKEN })
  token = enrolled.json.token
})
after(async () => {
  await hub?.close()
  await bare?.close()
  await fakeLoki?.close()
  await db?.drop()
})

const ship = (entries, auth = token) => hub.request("/api/v1/ingest/logs", { method: "POST", json: { entries }, auth })

test("ingest requires a machine token", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/ingest/logs", { method: "POST", json: { entries: [] } })).status, 401)
  assert.equal((await ship([{ line: "x" }], "hrm_nope")).status, 401)
})

test("ingest labels lines by machine, source, stream and detected level", { skip: skipDatabase }, async () => {
  fakeLoki.state.pushes.length = 0
  const now = Date.now()
  const response = await ship([
    { ts: now - 10, line: "[codex] spawn codex ENOENT: failed", stream: "stderr", source: "codex" },
    { ts: now - 5, line: "Harness Remote is ready", stream: "stdout" },
    { ts: now, line: "explicit", stream: "stdout", level: "warn" }
  ])
  assert.deepEqual(response.json, { accepted: 3 })
  const streams = fakeLoki.state.pushes.flatMap((push) => push.streams)
  const byLevel = Object.fromEntries(streams.map((stream) => [stream.stream.level, stream]))
  assert.equal(byLevel.error.stream.source, "codex")
  assert.equal(byLevel.error.stream.stream, "stderr")
  assert.equal(byLevel.error.stream.machine_id, "machine_logs")
  assert.equal(byLevel.error.stream.machine, "Log box")
  assert.equal(byLevel.error.stream.kind, "log")
  assert.equal(byLevel.error.stream.job, "harness-remote")
  assert.equal(byLevel.info.values[0][1], "Harness Remote is ready")
  assert.equal(byLevel.warn.values[0][1], "explicit")
})

test("a machine cannot spoof another machine's label", { skip: skipDatabase }, async () => {
  fakeLoki.state.pushes.length = 0
  await ship([{ line: "hi", machine_id: "machine_victim", labels: { machine_id: "machine_victim" } }])
  const stream = fakeLoki.state.pushes[0].streams[0].stream
  assert.equal(stream.machine_id, "machine_logs", "the label comes from the token, never the payload")
})

test("an empty batch is accepted without touching Loki", { skip: skipDatabase }, async () => {
  fakeLoki.state.pushes.length = 0
  assert.deepEqual((await ship([])).json, { accepted: 0 })
  assert.equal(fakeLoki.state.pushes.length, 0)
})

test("Loki outage: 503 + Retry-After so the machine keeps its buffer", { skip: skipDatabase }, async () => {
  fakeLoki.state.mode = "down"
  try {
    const response = await ship([{ line: "must not be lost" }])
    assert.equal(response.status, 503)
    assert.equal(response.json.error, "logs_unavailable")
    assert.ok(response.headers.get("retry-after"))
  } finally {
    fakeLoki.state.mode = "ok"
  }
})

test("a batch Loki rejects outright is acknowledged and dropped, not retried forever", { skip: skipDatabase }, async () => {
  fakeLoki.state.mode = "reject"
  try {
    const response = await ship([{ line: "too old for loki" }])
    assert.equal(response.status, 200)
    assert.equal(response.json.accepted, 0)
    assert.equal(response.json.dropped, 1)
  } finally {
    fakeLoki.state.mode = "ok"
  }
})

test("invalid batches are 400; oversized ones too", { skip: skipDatabase }, async () => {
  assert.equal((await hub.request("/api/v1/ingest/logs", { method: "POST", json: { entries: "nope" }, auth: token })).status, 400)
  assert.equal((await ship(Array.from({ length: 1_001 }, () => ({ line: "x" })))).status, 400)
})

test("without Loki configured, ingest and query say so (501) instead of pretending", { skip: skipDatabase }, async () => {
  const enrolled = await bare.request("/api/v1/machines/enroll", { method: "POST", json: machinePayload({ machine: { id: "machine_nolog" } }), auth: ENROLLMENT_TOKEN })
  assert.equal((await bare.request("/api/v1/ingest/logs", { method: "POST", json: { entries: [{ line: "x" }] }, auth: enrolled.json.token })).status, 501)
  await bare.login()
  assert.equal((await bare.request("/api/v1/logs")).status, 501)
  assert.equal((await bare.request("/api/v1/client-logs", { method: "POST", json: { entries: [{ message: "x" }] } })).status, 202)
})

test("readiness includes Loki when configured", { skip: skipDatabase }, async () => {
  assert.equal((await hub.request("/readyz")).json.checks.loki, true)
  fakeLoki.state.mode = "down"
  try {
    const ready = await hub.request("/readyz")
    assert.equal(ready.status, 503)
    assert.equal(ready.json.checks.loki, false)
    assert.equal(ready.json.checks.database, true)
  } finally {
    fakeLoki.state.mode = "ok"
  }
})

test("log query requires sign-in and builds LogQL from validated parameters only", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/logs")).status, 401)
  await hub.login()

  fakeLoki.state.queries.length = 0
  fakeLoki.state.result = [{ stream: { job: "harness-remote", machine_id: "machine_logs", level: "error", source: "codex" }, values: [[`${Date.now()}000000`, "boom"]] }]
  const response = await hub.request("/api/v1/logs?machine=machine_logs&level=error&source=codex&q=boom&since=15m&limit=50")
  assert.equal(response.status, 200)
  assert.equal(response.json.entries[0].line, "boom")
  assert.equal(response.json.entries[0].labels.machine_id, "machine_logs")
  const query = fakeLoki.state.queries[0]
  assert.equal(query.query, '{job="harness-remote",machine_id="machine_logs",source="codex",level="error"} |= "boom"')
  assert.equal(query.limit, "50")
  assert.equal(query.direction, "backward")
  const span = (Number(query.end) - Number(query.start)) / 1e9
  assert.ok(span >= 899 && span <= 901, `15m window, got ${span}s`)
})

test("log query rejects injection, bad times and out-of-retention ranges before reaching Loki", { skip: skipDatabase }, async () => {
  await hub.login()
  fakeLoki.state.queries.length = 0
  for (const query of [
    `machine=${encodeURIComponent('x"} or {job=~".+"')}`,
    "source=a%20b", "level=%7B", "since=yesterday", "since=60d", "until=1h&since=5m"
  ]) {
    assert.equal((await hub.request(`/api/v1/logs?${query}`)).status, 400, query)
  }
  assert.equal(fakeLoki.state.queries.length, 0)
})

test("log query maps a Loki failure to 502", { skip: skipDatabase }, async () => {
  await hub.login()
  fakeLoki.state.mode = "down"
  try {
    assert.equal((await hub.request("/api/v1/logs")).status, 502)
  } finally {
    fakeLoki.state.mode = "ok"
  }
})

test("session transitions from a heartbeat are written as event lines", { skip: skipDatabase }, async () => {
  fakeLoki.state.pushes.length = 0
  await hub.request("/api/v1/machines/heartbeat", {
    method: "POST",
    auth: token,
    json: { machine: { id: "machine_logs" }, sessions: [{ agentId: "codex", id: "s-42", title: "Fix flaky test", status: "busy", directory: "/repo" }] }
  })
  const stream = fakeLoki.state.pushes.flatMap((push) => push.streams).find((candidate) => candidate.stream.source === "session")
  assert.equal(stream.stream.kind, "event")
  assert.equal(stream.stream.machine_id, "machine_logs")
  assert.deepEqual(JSON.parse(stream.values[0][1]), { type: "session.created", agent: "codex", sessionId: "s-42", title: "Fix flaky test", directory: "/repo", from: null, to: "busy" })

  fakeLoki.state.pushes.length = 0
  await hub.request("/api/v1/machines/heartbeat", {
    method: "POST",
    auth: token,
    json: { machine: { id: "machine_logs" }, sessions: [{ agentId: "codex", id: "s-42", title: "Fix flaky test", status: "idle", directory: "/repo" }] }
  })
  const change = fakeLoki.state.pushes.flatMap((push) => push.streams).find((candidate) => candidate.stream.source === "session")
  assert.deepEqual([JSON.parse(change.values[0][1]).from, JSON.parse(change.values[0][1]).to], ["busy", "idle"])
})

test("an event-sink failure never fails the request that caused it", { skip: skipDatabase }, async () => {
  fakeLoki.state.mode = "down"
  try {
    const response = await hub.request("/api/v1/machines/heartbeat", {
      method: "POST", auth: token, json: { machine: { id: "machine_logs" }, sessions: [{ agentId: "codex", id: "s-99", status: "busy" }] }
    })
    assert.equal(response.status, 200)
  } finally {
    fakeLoki.state.mode = "ok"
  }
})

test("client error reports are stored as web logs, sanitised and rate limited", { skip: skipDatabase }, async () => {
  hub.forgetCookie()
  assert.equal((await hub.request("/api/v1/client-logs", { method: "POST", json: { entries: [{ message: "x" }] } })).status, 401)
  await hub.login()

  fakeLoki.state.pushes.length = 0
  const response = await hub.request("/api/v1/client-logs", {
    method: "POST",
    json: { entries: [
      { level: "error", message: "TypeError: x is undefined", stack: "at a\nat b", url: "https://hub.example/?token=SECRET#frag", userAgent: "iPhone", context: { password: "p", viewport: "390x844" } },
      { message: "" },
      { level: "bogus", message: "second" }
    ] }
  })
  assert.equal(response.status, 202)
  assert.equal(response.json.accepted, 2)
  const streams = fakeLoki.state.pushes.flatMap((push) => push.streams)
  assert.ok(streams.every((stream) => stream.stream.source === "web" && stream.stream.stream === "client"))
  const first = JSON.parse(streams.find((stream) => stream.stream.level === "error").values[0][1])
  assert.equal(first.url, "https://hub.example/", "query string and fragment (may hold tokens) are stripped")
  assert.deepEqual(first.context, { viewport: "390x844" }, "secret-looking keys are scrubbed")

  assert.equal((await hub.request("/api/v1/client-logs", { method: "POST", json: { entries: Array.from({ length: 21 }, () => ({ message: "x" })) } })).status, 400)
})
