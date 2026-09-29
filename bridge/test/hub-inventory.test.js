import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { collectSessions, localBaseUrl } from "../src/hub-inventory.js"

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
    const sessions = await collectSessions({
      config: { ...config, port: gateway.port },
      agents: [{ id: "codex", state: "configured" }, { id: "opencode", state: "unavailable" }],
      scoped: true
    })
    assert.deepEqual(sessions, [])
    assert.equal(gateway.seen.length, 0, "a sleeping harness must stay asleep")
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
    const sessions = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "codex", state: "available" }], scoped: true })
    assert.deepEqual(sessions, [
      { agentId: "codex", id: "s1", title: "Fix bug", directory: "/repo", status: "busy", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
      { agentId: "codex", id: "s2", title: "Docs", directory: "/docs", status: "waiting", createdAt: undefined, updatedAt: 1_700_000_200_000 }
    ], "a listing that omits status (OpenCode) is completed from /session/status")
    assert.ok(gateway.seen.every((request) => request.authorization === `Basic ${Buffer.from("harness:pw").toString("base64")}`))
    assert.deepEqual(gateway.seen.map((request) => request.url), ["/v1/agents/codex/experimental/session", "/v1/agents/codex/session/status"])
  } finally {
    await gateway.close()
  }
})

test("single-backend gateways have no agent prefix", async () => {
  const gateway = await fakeGateway({ "/experimental/session": { body: [{ id: "only", title: "T", status: "idle" }] }, "/session/status": { body: {} } })
  try {
    const sessions = await collectSessions({ config: { ...config, username: "", port: gateway.port }, agents: [{ id: "omp", state: "available" }], scoped: false })
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
    const sessions = await collectSessions({
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
  const sessions = await collectSessions({ config: { ...config, port: 1 }, agents: [{ id: "codex", state: "available" }], scoped: true })
  assert.deepEqual(sessions, [])
})

test("caps how many sessions one agent can report", async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, status: "idle" }))
  const gateway = await fakeGateway({ "/experimental/session": { body: many }, "/session/status": { body: {} } })
  try {
    const sessions = await collectSessions({ config: { ...config, port: gateway.port }, agents: [{ id: "x", state: "available" }], scoped: false })
    assert.equal(sessions.length, 200)
  } finally {
    await gateway.close()
  }
})
