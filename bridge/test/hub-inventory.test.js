import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { collectSessions, localBaseUrl, sessionActivity } from "../src/hub-inventory.js"

const config = { host: "127.0.0.1", port: 0, username: "harness", password: "pw" }

async function fakeGateway(routes) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    const handler = routes[req.url]
    if (!handler) { res.writeHead(404); res.end(); return }
    res.writeHead(handler.status ?? 200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(handler.body))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { port: server.address().port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }) }
}

test("localBaseUrl uses loopback for wildcard binds and brackets IPv6", () => {
  assert.equal(localBaseUrl({ host: "0.0.0.0", port: 4097 }), "http://127.0.0.1:4097")
  assert.equal(localBaseUrl({ host: "::", port: 4097 }), "http://[::1]:4097")
  assert.equal(localBaseUrl({ host: "192.168.1.5", port: 4097 }), "http://192.168.1.5:4097")
  assert.equal(localBaseUrl({ host: "", port: 1 }), "http://127.0.0.1:1")
})

test("never contacts an agent that is not already running (listing would wake it)", async () => {
  const gateway = await fakeGateway({})
  try {
    const { sessions } = await collectSessions({
      config: { ...config, port: gateway.port },
      agents: [{ id: "codex", state: "configured" }, { id: "opencode", state: "unavailable" }],
      scoped: true
    })
    assert.deepEqual(sessions, [])
    // The only route asked is the machine-level one for Claude Code background agents, which reads the CLI's
    // registry; no agent route is touched, so no sleeping harness is woken.
    assert.ok(gateway.seen.every((request) => request.url.startsWith("/v1/background-agents")), "a sleeping harness must stay asleep")
  } finally {
    await gateway.close()
  }
})

test("reads the lightweight session index of running agents through the scoped route, with credentials", async () => {
  const gateway = await fakeGateway({
    "/v1/agents/codex/experimental/session": { body: [
      { id: "s1", title: "Fix bug", directory: "/repo", status: { type: "busy" }, time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 } },
      { id: "s2", title: "Docs", directory: "/docs", time: { updated: 1_700_000_200_000 } },
      { title: "no id" }, null, { id: 5 }
    ] },
    "/v1/agents/codex/session/status": { body: { s2: { type: "waiting" } } }
  })
  try {
    const { sessions } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "codex", state: "available" }], scoped: true })
    assert.deepEqual(sessions, [
      { agentId: "codex", id: "s1", kind: "session", title: "Fix bug", directory: "/repo", status: "busy", activity: "working", startedAt: 1_700_000_000_000, lastRanAt: 1_700_000_100_000, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
      { agentId: "codex", id: "s2", kind: "session", title: "Docs", directory: "/docs", status: "waiting", activity: "needs_input", startedAt: undefined, lastRanAt: 1_700_000_200_000, createdAt: undefined, updatedAt: 1_700_000_200_000 }
    ], "a listing that omits status (OpenCode) is completed from /session/status")
    assert.ok(gateway.seen.every((request) => request.authorization === `Basic ${Buffer.from("harness:pw").toString("base64")}`))
    assert.deepEqual(gateway.seen.map((request) => request.url).filter((url) => !url.startsWith("/v1/background-agents")), ["/v1/agents/codex/experimental/session", "/v1/agents/codex/session/status"])
  } finally {
    await gateway.close()
  }
})

test("single-backend gateways have no agent prefix", async () => {
  const gateway = await fakeGateway({ "/experimental/session": { body: [{ id: "only", title: "T", status: "idle" }] }, "/session/status": { body: {} } })
  try {
    const { sessions } = await collectSessions({ config: { ...config, username: "", port: gateway.port }, agents: [{ id: "omp", state: "available" }], scoped: false })
    assert.equal(sessions[0].status, "idle", "a bare-string status is accepted too")
    assert.equal(gateway.seen[0].authorization, undefined, "no credentials configured, none sent")
  } finally {
    await gateway.close()
  }
})

test("one agent failing does not hide the others, and a status failure is not fatal", async () => {
  const gateway = await fakeGateway({
    "/v1/agents/a/experimental/session": { status: 500, body: {} },
    "/v1/agents/b/experimental/session": { body: [{ id: "b1", status: { type: "idle" } }] }
  })
  try {
    const { sessions } = await collectSessions({
      config: { ...config, port: gateway.port },
      agents: [{ id: "a", state: "available" }, { id: "b", state: "available" }, { id: "c", state: "available" }],
      scoped: true
    })
    assert.deepEqual(sessions.map((session) => session.id), ["b1"])
  } finally {
    await gateway.close()
  }
})

test("an unreachable gateway yields an empty inventory rather than an exception", async () => {
  const { sessions } = await collectSessions({ config: { ...config, port: 1 }, agents: [{ id: "codex", state: "available" }], scoped: true })
  assert.deepEqual(sessions, [])
})

test("caps how many sessions one agent can report", async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, status: "idle" }))
  const gateway = await fakeGateway({ "/experimental/session": { body: many }, "/session/status": { body: {} } })
  try {
    const { sessions } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "x", state: "available" }], scoped: false })
    assert.equal(sessions.length, 200)
  } finally {
    await gateway.close()
  }
})

test("reports which agents' lists were complete: a list at the cap or with a next page is not", async () => {
  const many = Array.from({ length: 201 }, (_, index) => ({ id: `s${index}`, status: "idle" }))
  const gateway = await fakeGateway({
    "/v1/agents/small/experimental/session": { body: [{ id: "a", status: "idle" }] },
    "/v1/agents/small/session/status": { body: {} },
    "/v1/agents/big/experimental/session": { body: many },
    "/v1/agents/big/session/status": { body: {} }
  })
  try {
    const { completeAgents } = await collectSessions({
      config: { ...config, port: gateway.port },
      agents: [{ id: "small", state: "available" }, { id: "big", state: "available" }, { id: "asleep", state: "configured" }],
      scoped: true
    })
    assert.deepEqual(completeAgents, ["small"], "the truncated agent and the sleeping agent must not be treated as complete")
  } finally {
    await gateway.close()
  }
})

test("clips oversized titles and directories so a heartbeat cannot be refused for size", async () => {
  const gateway = await fakeGateway({
    "/experimental/session": { body: [{ id: "s", title: "T".repeat(5_000), directory: `/${"d".repeat(5_000)}` }] },
    "/session/status": { body: {} }
  })
  try {
    const { sessions } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "x", state: "available" }], scoped: false })
    assert.equal(sessions[0].title.length, 300)
    assert.equal(sessions[0].directory.length, 1024)
  } finally {
    await gateway.close()
  }
})

test("sessionActivity maps every harness's status words onto the shared vocabulary", () => {
  for (const [status, activity] of [["busy", "working"], ["retry", "working"], ["waiting", "needs_input"], ["idle", "idle"], ["error", "failed"], ["stopped", "stopped"], ["BUSY", "working"], ["whatever", "unknown"], [undefined, "unknown"]]) {
    assert.equal(sessionActivity(status), activity, String(status))
  }
})

const backgroundRoute = (agents, extra = {}) => ({ "/v1/background-agents?all=1": { body: { available: true, agents, ...extra } } })
const claudeAgent = (over) => ({ key: "background:aaaa0001", kind: "background", id: "aaaa0001", sessionId: "aaaa0001-1111-2222-3333-444455556666", name: "Refactor parser", directory: "/repo", activity: "completed", rawState: "done", startedAt: 1_790_000_000_000, updatedAt: 1_790_000_900_000, ...over })

test("Claude Code background agents are reported as Sessions of kind 'background', with when they started and last ran", async () => {
  const gateway = await fakeGateway(backgroundRoute([
    claudeAgent({}),
    claudeAgent({ key: "background:aaaa0002", id: "aaaa0002", sessionId: "aaaa0002-1111-2222-3333-444455556666", name: "Pick a DB", activity: "needs_input", rawState: "blocked", needs: "Which database?" }),
    { key: "interactive:x", kind: "interactive", sessionId: "bbbb0001-1111-2222-3333-444455556666", name: "terminal", directory: "/repo", activity: "working", rawState: "busy", startedAt: 1_790_000_100_000, updatedAt: 1_790_000_200_000 },
    { kind: "background", name: "no activity, ignored" }
  ]))
  try {
    const { sessions } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [], scoped: true })
    assert.equal(sessions.length, 3)
    const done = sessions.find((session) => session.id.startsWith("aaaa0001"))
    assert.deepEqual([done.agentId, done.kind, done.title, done.status, done.activity, done.startedAt, done.lastRanAt], ["claude", "background", "Refactor parser", "done", "completed", 1_790_000_000_000, 1_790_000_900_000])
    const blocked = sessions.find((session) => session.id.startsWith("aaaa0002"))
    assert.deepEqual([blocked.activity, blocked.detail], ["needs_input", "Which database?"])
    const terminal = sessions.find((session) => session.id.startsWith("bbbb0001"))
    assert.deepEqual([terminal.kind, terminal.activity], ["session", "working"], "a terminal Claude session is an ordinary Session that is running right now")
  } finally {
    await gateway.close()
  }
})

test("a background agent that is also in Claude's ordinary list is one Session, not two", async () => {
  const id = "aaaa0001-1111-2222-3333-444455556666"
  const gateway = await fakeGateway({
    ...backgroundRoute([claudeAgent({ activity: "working", rawState: "running", name: "job" })]),
    "/v1/agents/claude/experimental/session": { body: [{ id, title: "Refactor the parser", directory: "/repo", status: { type: "idle" }, time: { created: 1_780_000_000_000, updated: 1_780_000_500_000 } }] },
    "/v1/agents/claude/session/status": { body: {} }
  })
  try {
    const { sessions, completeAgents } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "claude", state: "available" }], scoped: true })
    assert.equal(sessions.length, 1)
    const [merged] = sessions
    assert.equal(merged.kind, "background")
    assert.equal(merged.activity, "working", "the CLI's live state beats the ACP listing's stale idle")
    assert.equal(merged.title, "Refactor the parser", "but the ACP listing's title is kept")
    assert.equal(merged.startedAt, 1_780_000_000_000, "and the earlier start")
    assert.deepEqual(completeAgents, ["claude"])
  } finally {
    await gateway.close()
  }
})

test("no Claude Code, an old daemon or a failing route changes nothing about the rest of the inventory", async () => {
  for (const routes of [{}, { "/v1/background-agents?all=1": { status: 500, body: {} } }, { "/v1/background-agents?all=1": { body: { available: false, reason: "claude_not_found", agents: [] } } }]) {
    const gateway = await fakeGateway({ ...routes, "/experimental/session": { body: [{ id: "s", status: "idle" }] }, "/session/status": { body: {} } })
    try {
      const { sessions } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "omp", state: "available" }], scoped: false })
      assert.deepEqual(sessions.map((session) => session.id), ["s"])
    } finally {
      await gateway.close()
    }
  }
})

test("'claude' is never called complete when only the background list was seen", async () => {
  const gateway = await fakeGateway(backgroundRoute([claudeAgent({})]))
  try {
    const { completeAgents } = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "claude", state: "configured" }], scoped: true })
    assert.deepEqual(completeAgents, [], "its ordinary Sessions were never listed, so nothing may be marked gone")
  } finally {
    await gateway.close()
  }
})
