import test from "node:test"
import assert from "node:assert/strict"
import {
  ValidationError, agentList, configObject, credentialsObject, endpointList, endpointUrl, logEntries, machineId, machineInfo,
  scrubConfig, sessionList, statsObject
} from "../src/validate.js"

test("endpointUrl accepts plain gateway origins and normalises them", () => {
  assert.equal(endpointUrl("http://192.168.1.20:4097"), "http://192.168.1.20:4097")
  assert.equal(endpointUrl("HTTPS://Desk.Tailnet.ts.net:4097/"), "https://desk.tailnet.ts.net:4097")
  assert.equal(endpointUrl("http://[fd00::1]:4097"), "http://[fd00::1]:4097")
})

test("endpointUrl refuses anything that is not a bare http(s) origin", () => {
  for (const bad of [
    "ftp://host", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@host", "http://host/path",
    "http://host?x=1", "http://host#frag", "not a url", "", null, undefined, 42
  ]) {
    assert.equal(endpointUrl(bad), null, String(bad))
  }
})

test("endpointUrl blocks link-local and metadata-service addresses (SSRF)", () => {
  for (const bad of [
    "http://169.254.169.254", "http://169.254.0.1:80", "http://metadata.google.internal",
    "http://[fe80::1]:4097", "http://[febf::1]",
    // Every spelling of the same metadata address must be refused, not just the obvious one.
    "http://[::ffff:169.254.169.254]", "http://[::ffff:a9fe:a9fe]", "http://[::169.254.169.254]",
    "http://[64:ff9b::169.254.169.254]", "http://2852039166", "http://0xA9FEA9FE", "http://0251.0376.0251.0376"
  ]) {
    assert.equal(endpointUrl(bad), null, bad)
  }
  // ...while ordinary private and IPv6 addresses stay usable.
  for (const good of ["http://10.0.0.5:4097", "http://[::1]:4097", "http://[::ffff:192.168.1.5]:4097", "http://[fd00::1]:4097"]) {
    assert.ok(endpointUrl(good), good)
  }
})

test("endpointList dedupes, drops junk and caps the count", () => {
  const list = endpointList(["http://a:1", "http://a:1", "nope", "http://169.254.169.254", "http://b:2"])
  assert.deepEqual(list, ["http://a:1", "http://b:2"])
  const many = Array.from({ length: 30 }, (_, index) => `http://h${index}:1`)
  assert.equal(endpointList(many).length, 8)
  assert.deepEqual(endpointList("http://a:1"), [])
})

test("scrubConfig removes secret-looking keys at any depth and bounds structure", () => {
  const scrubbed = scrubConfig({
    backend: "codex",
    password: "x",
    nested: { apiKey: "x", api_key: "x", authorization: "x", token: "x", keep: "yes", deeper: { Secret: "x", ok: 1 } },
    list: [{ credentials: "x", fine: true }],
    fn: () => 1
  })
  assert.deepEqual(scrubbed, {
    backend: "codex",
    nested: { keep: "yes", deeper: { ok: 1 } },
    list: [{ fine: true }],
    fn: null
  })
  assert.ok(!JSON.stringify(scrubbed).includes('"x"'))
})

test("configObject rejects oversized configuration and non-objects become empty", () => {
  assert.deepEqual(configObject(undefined), {})
  assert.deepEqual(configObject([1, 2]), {})
  const huge = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, "v".repeat(1_000)]))
  assert.throws(() => configObject(huge), ValidationError)
})

test("machineId only accepts identifier-shaped values", () => {
  assert.equal(machineId("machine_123e4567-e89b-12d3-a456-426614174000"), "machine_123e4567-e89b-12d3-a456-426614174000")
  for (const bad of ["", "has space", "a/b", "../x", "x".repeat(129), undefined, 5]) {
    assert.throws(() => machineId(bad), ValidationError, String(bad))
  }
})

test("machineInfo falls back to hostname then id for the display name", () => {
  assert.equal(machineInfo({ id: "m1", name: "Desk" }).name, "Desk")
  assert.equal(machineInfo({ id: "m1", hostname: "box.local" }).name, "box.local")
  assert.equal(machineInfo({ id: "m1" }).name, "m1")
  assert.equal(machineInfo({ id: "m1", name: "a\u0007b\u0000c" }).name, "abc")
})

test("machineInfo({partial}) leaves absent identity fields null instead of inventing them", () => {
  assert.equal(machineInfo({ id: "m1" }, { partial: true }).name, null)
  assert.equal(machineInfo({ id: "m1", hostname: "box" }, { partial: true }).name, "box")
  assert.equal(machineInfo({ id: "m1" }).name, "m1", "enrollment still falls back to the id")
})

test("agentList keeps known states and defaults the rest", () => {
  assert.deepEqual(agentList([{ id: "codex", label: "Codex", state: "available" }, { id: "x", state: "weird" }, { label: "no id" }, null]), [
    { id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available" },
    { id: "x", label: "x", backend: "x", transport: "acp", state: "configured" }
  ])
})

test("statsObject keeps only known non-negative integers", () => {
  assert.deepEqual(statsObject({ uptimeSeconds: 12.9, rss: -5, evil: 1, sseClients: "3", heapUsed: NaN }), { uptimeSeconds: 12, rss: 0 })
  assert.deepEqual(statsObject(null), {})
})

test("sessionList normalises, caps per agent and refuses bogus timestamps", () => {
  const sessions = sessionList([
    { agentId: "codex", id: "s1", title: "  Fix bug ", directory: "/w", status: "busy", createdAt: 1_700_000_000_000, updatedAt: "2026-01-02T03:04:05Z" },
    { agentId: "codex", id: "s2", createdAt: 0, updatedAt: "garbage" },
    { agentId: "codex", id: "s3", updatedAt: Date.now() + 10 * 86_400_000 },
    { id: "no-agent" },
    { agentId: "codex" }
  ])
  assert.equal(sessions.length, 3)
  assert.equal(sessions[0].title, "Fix bug")
  assert.equal(sessions[0].created_at, "2023-11-14T22:13:20.000Z")
  assert.equal(sessions[0].updated_at, "2026-01-02T03:04:05.000Z")
  assert.equal(sessions[1].created_at, null)
  assert.equal(sessions[1].updated_at, null)
  assert.equal(sessions[1].status, "unknown")
  assert.equal(sessions[2].updated_at, null, "future timestamps are not trusted")

  const flood = sessionList(Array.from({ length: 900 }, (_, index) => ({ agentId: "codex", id: `s${index}` })))
  assert.equal(flood.length, 500)
})

test("credentialsObject requires both halves and bounds their size", () => {
  assert.deepEqual(credentialsObject({ username: "u", password: "p" }), { username: "u", password: "p" })
  assert.equal(credentialsObject({ username: "u" }), null)
  assert.equal(credentialsObject({ username: "u", password: "p".repeat(2_000) }), null)
  assert.equal(credentialsObject(null), null)
})

test("logEntries clamps absurd timestamps, sanitises source and bounds size", () => {
  const now = Date.parse("2026-06-01T00:00:00Z")
  const [good, skewed, stale, long, unnamed] = logEntries([
    { ts: now - 1_000, line: "ok", stream: "stderr", source: "Codex", level: "error" },
    { ts: now + 40 * 86_400_000, line: "from the future", stream: "weird" },
    { ts: "2001-01-01", line: "ancient" },
    { ts: now, line: "x".repeat(20_000) },
    { line: "no meta", source: "$$$" }
  ], now)
  assert.deepEqual(good, { ts: now - 1_000, line: "ok", stream: "stderr", source: "codex", level: "error" })
  assert.equal(skewed.ts, now)
  assert.equal(skewed.stream, "stdout")
  assert.equal(stale.ts, now)
  assert.equal(long.line.length, 8_193)
  assert.equal(unnamed.source, "daemon")
  assert.equal(logEntries([{ line: "" }, { line: 5 }, null], now).length, 0)
  assert.throws(() => logEntries("nope"), ValidationError)
  assert.throws(() => logEntries(Array.from({ length: 1_001 }, () => ({ line: "x" }))), /at most 1000/)
})
