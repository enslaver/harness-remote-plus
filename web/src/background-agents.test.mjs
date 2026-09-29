import assert from "node:assert/strict"
import test from "node:test"
import {
  backgroundAgentBySession,
  backgroundAgentClient,
  backgroundSessionStatus,
  claudeAgentHost,
  listBackgroundAgents,
  parseBackgroundAgent,
  parseBackgroundAgentList,
  sessionFromBackgroundAgent,
  syntheticBackgroundRecords
} from "./background-agents.ts"
import { federatedSessionBucket } from "./native-session-federation.ts"

const SID = "aaaa0001-1111-2222-3333-444455556666"
const wire = (over = {}) => ({
  key: "background:aaaa0001", kind: "background", id: "aaaa0001", sessionId: SID, name: "Refactor parser", directory: "/repo", activity: "completed",
  rawState: "done", detail: "Refactored the parser", startedAt: 1_790_000_000_000, updatedAt: 1_790_000_900_000,
  capabilities: { open: true, prompt: true, logs: true, stop: false, resume: true, remove: true }, ...over
})
const machineConfig = { backend: "opencode", host: "http://desk.local", port: 4900, username: "harness", password: "pw" }
const claudeHost = { id: "claude", label: "Claude Code", backend: "claude", transport: "acp", state: "configured", capabilities: { abort: true, models: true, sessionRename: true, sessionDelete: true } }
const codexHost = { id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available" }

function fakeFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body === undefined ? undefined : JSON.parse(init.body), authorization: init.headers?.Authorization })
    const result = await handler(String(url), init)
    return new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {}), { status: result.status ?? 200 })
  }
  return calls
}

test("an entry is read strictly: unknown activities, kinds and junk are dropped, extra fields ignored", () => {
  const parsed = parseBackgroundAgent(wire({ somethingNew: { a: 1 } }))
  assert.deepEqual([parsed.key, parsed.activity, parsed.id, parsed.capabilities.resume, parsed.startedAt], ["background:aaaa0001", "completed", "aaaa0001", true, 1_790_000_000_000])
  for (const bad of [null, "x", 5, [], {}, wire({ activity: "party" }), wire({ kind: "daemon" }), wire({ key: 7 }), wire({ activity: undefined })]) {
    assert.equal(parseBackgroundAgent(bad), undefined, JSON.stringify(bad))
  }
  assert.equal(parseBackgroundAgent(wire({ capabilities: undefined })).capabilities.stop, false, "no capabilities means nothing is allowed")
  assert.equal(parseBackgroundAgent(wire({ name: "" })).name, "Agent")
  assert.deepEqual(parseBackgroundAgent(wire({ subagents: { total: 3, running: 1, failed: 1 } })).subagents, { total: 3, running: 1, failed: 1 })
  assert.equal(parseBackgroundAgent(wire({ name: "x".repeat(500) })).name.length, 200)
})

test("a list is parsed leniently and reports availability", () => {
  const list = parseBackgroundAgentList({ available: true, agents: [wire(), { junk: true }, wire({ key: "background:aaaa0002", id: "aaaa0002" })] })
  assert.equal(list.available, true)
  assert.equal(list.agents.length, 2)
  assert.deepEqual(parseBackgroundAgentList({ available: false, reason: "claude_not_found", agents: [] }), { available: false, reason: "claude_not_found", agents: [] })
  for (const junk of [null, undefined, "no", 3, { available: "yes" }, { agents: "no" }]) {
    assert.deepEqual(parseBackgroundAgentList(junk).agents, [])
    assert.equal(parseBackgroundAgentList(junk).available, false)
  }
})

test("listing never throws: an old daemon, an error or an unreachable machine leaves the Session list alone", async () => {
  const original = globalThis.fetch
  try {
    fakeFetch(() => ({ status: 404, body: { error: "not found" } }))
    assert.deepEqual(await listBackgroundAgents(machineConfig), { available: false, agents: [] })
    fakeFetch(() => ({ status: 500, body: "boom" }))
    assert.equal((await listBackgroundAgents(machineConfig)).available, false)
    fakeFetch(() => ({ status: 401, body: "" }))
    assert.equal((await listBackgroundAgents(machineConfig)).available, false)
    globalThis.fetch = async () => { throw new TypeError("network down") }
    assert.equal((await listBackgroundAgents(machineConfig)).available, false)
    fakeFetch(() => ({ body: { available: true, agents: [wire()] } }))
    assert.equal((await listBackgroundAgents(machineConfig)).agents.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test("the client speaks the daemon's routes, with the machine's credentials, and encodes ids", async () => {
  const original = globalThis.fetch
  try {
    const calls = fakeFetch((url) => (url.includes("/logs") ? { body: { id: "aaaa0001", text: "hello\n", truncated: false } } : { body: { id: "aaaa0001" } }))
    await backgroundAgentClient.list(machineConfig)
    await backgroundAgentClient.start(machineConfig, { prompt: "do it", directory: "/repo", permissionMode: "acceptEdits" })
    await backgroundAgentClient.stop(machineConfig, "aaaa0001")
    await backgroundAgentClient.resume(machineConfig, "aaaa0001", "and more")
    await backgroundAgentClient.remove(machineConfig, "aaaa0001")
    assert.deepEqual(await backgroundAgentClient.logs(machineConfig, "aaaa0001"), { text: "hello\n", truncated: false })
    await backgroundAgentClient.stop(machineConfig, "../x y")
    assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname + new URL(call.url).search]), [
      ["GET", "/v1/background-agents?all=1"],
      ["POST", "/v1/background-agents"],
      ["POST", "/v1/background-agents/aaaa0001/stop"],
      ["POST", "/v1/background-agents/aaaa0001/resume"],
      ["DELETE", "/v1/background-agents/aaaa0001"],
      ["GET", "/v1/background-agents/aaaa0001/logs"],
      ["POST", "/v1/background-agents/..%2Fx%20y/stop"]
    ])
    assert.deepEqual(calls[1].body, { prompt: "do it", directory: "/repo", permissionMode: "acceptEdits" })
    assert.deepEqual(calls[3].body, { prompt: "and more" })
    assert.ok(calls.every((call) => call.authorization === `Basic ${Buffer.from("harness:pw").toString("base64")}`))
  } finally {
    globalThis.fetch = original
  }
})

test("the client surfaces the daemon's refusal message instead of swallowing it", async () => {
  const original = globalThis.fetch
  try {
    fakeFetch(() => ({ status: 409, body: { error: "Refusing to remove: the worktree has 2 unpushed commits", code: "claude_failed" } }))
    await assert.rejects(() => backgroundAgentClient.remove(machineConfig, "aaaa0001"), /unpushed commits/)
    fakeFetch(() => ({ status: 503, body: { error: "The `claude` command was not found on this machine.", code: "claude_not_found" } }))
    await assert.rejects(() => backgroundAgentClient.start(machineConfig, { prompt: "x", directory: "/r" }), /not found on this machine/)
  } finally {
    globalThis.fetch = original
  }
})

test("a background agent's activity becomes a status the rail files under the right bucket", () => {
  for (const [activity, bucket] of [["working", "active"], ["needs_input", "attention"], ["completed", "completed"], ["failed", "failed"], ["idle", "recent"]]) {
    assert.equal(federatedSessionBucket(backgroundSessionStatus(parseBackgroundAgent(wire({ activity })))), bucket, activity)
  }
  assert.equal(backgroundSessionStatus(parseBackgroundAgent(wire({ activity: "needs_input", needs: "Which database?" }))).message, "Which database?")
})

test("agents are matched to Sessions by conversation id; terminal sessions without one are not", () => {
  const map = backgroundAgentBySession([parseBackgroundAgent(wire()), parseBackgroundAgent(wire({ key: "interactive:5", kind: "interactive", sessionId: undefined, id: undefined, pid: 5 }))])
  assert.equal(map.size, 1)
  assert.equal(map.get(SID).id, "aaaa0001")
})

test("the Claude harness is found by id or backend", () => {
  assert.equal(claudeAgentHost([codexHost, claudeHost]).id, "claude")
  assert.equal(claudeAgentHost([codexHost, { ...claudeHost, id: "claude-work" }]).id, "claude-work")
  assert.equal(claudeAgentHost([codexHost]), undefined)
})

test("a background agent the harness listing lacks becomes an openable Claude Session row, with its real times", () => {
  const known = parseBackgroundAgent(wire({ key: "background:aaaa0002", id: "aaaa0002", sessionId: "aaaa0002-1111-2222-3333-444455556666" }))
  const missing = parseBackgroundAgent(wire({ activity: "working", rawState: "running" }))
  const unopenable = parseBackgroundAgent(wire({ key: "background:aaaa0003", id: "aaaa0003", sessionId: "aaaa0003-1111-2222-3333-444455556666", capabilities: { open: false } }))
  const records = syntheticBackgroundRecords([known, missing, unopenable], new Set([known.sessionId]), claudeHost, machineConfig)
  assert.equal(records.length, 1, "one already listed, one that cannot be opened")
  const [record] = records
  assert.deepEqual([record.agentId, record.agentLabel, record.backend, record.transport], ["claude", "Claude Code", "claude", "acp"])
  assert.equal(record.key, `claude:${SID}`)
  assert.equal(record.session.title, "Refactor parser")
  assert.equal(record.session.directory, "/repo")
  assert.deepEqual(record.session.time, { created: 1_790_000_000_000, updated: 1_790_000_900_000 })
  assert.equal(record.status.type, "working")
  assert.equal(record.abortSupported, true, "it inherits what the Claude harness can do")
  assert.equal(sessionFromBackgroundAgent(missing).id, SID)
})
