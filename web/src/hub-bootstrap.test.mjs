import assert from "node:assert/strict"
import test from "node:test"
import { fetchHubBootstrap, hubMachineFromPayload, parseHubBootstrap, sameHubMachines } from "./hubBootstrap.ts"
import { baseUrl, machineBaseUrl } from "./serverConfig.ts"

const https443 = { protocol: "https:", hostname: "hub.example.com", port: "" }
const lan = { protocol: "http:", hostname: "192.168.1.10", port: "8080" }
const entry = (overrides = {}) => ({ id: "machine_abc", name: "Studio Mac", basePath: "/m/machine_abc", ...overrides })

test("a hub machine is reached through the hub's own origin, with no stored credentials", () => {
  const machine = hubMachineFromPayload(entry(), https443)
  assert.equal(machine.id, "hub:machine_abc")
  assert.equal(machine.name, "Studio Mac")
  assert.deepEqual(machine.config, { backend: "opencode", host: "https://hub.example.com", port: 443, username: "", password: "", basePath: "/m/machine_abc" })
  assert.equal(machineBaseUrl(machine.config), "https://hub.example.com:443/m/machine_abc")
  assert.equal(baseUrl({ ...machine.config, agentId: "codex" }), "https://hub.example.com:443/m/machine_abc/v1/agents/codex")
})

test("the port comes from the page, defaulting by scheme", () => {
  assert.equal(hubMachineFromPayload(entry(), lan).config.port, 8080)
  assert.equal(hubMachineFromPayload(entry(), lan).config.host, "http://192.168.1.10")
  assert.equal(hubMachineFromPayload(entry(), { protocol: "http:", hostname: "hub.lan", port: "" }).config.port, 80)
  assert.equal(machineBaseUrl(hubMachineFromPayload(entry(), { protocol: "http:", hostname: "[::1]", port: "8080" }).config), "http://[::1]:8080/m/machine_abc")
})

test("only the hub's own proxy route is accepted as a base path", () => {
  for (const basePath of ["/m/x/y", "/other/x", "/m/", "m/x", "//evil.example/m/x", "/m/x?y=1", "/m/x#f", "/m/../x", undefined, 5]) {
    assert.equal(hubMachineFromPayload(entry({ basePath }), https443), null, String(basePath))
  }
  for (const bad of [null, undefined, "x", 5, [], {}, { id: "", basePath: "/m/x" }, { id: 5, basePath: "/m/x" }]) {
    assert.equal(hubMachineFromPayload(bad, https443), null)
  }
  assert.equal(hubMachineFromPayload(entry({ name: "  " }), https443).name, "machine_abc", "a blank name falls back to the id")
})

test("parseHubBootstrap tells a hub from anything else, and signed-in from signed-out", () => {
  for (const payload of [null, undefined, "hello", 5, [], {}, { hub: false }, { hub: "true" }, { machines: [entry()] }]) {
    assert.deepEqual(parseHubBootstrap(payload, https443), { kind: "none" }, JSON.stringify(payload))
  }
  assert.deepEqual(parseHubBootstrap({ hub: true, authenticated: false, name: "Home" }, https443), { kind: "signin", name: "Home" })
  assert.deepEqual(parseHubBootstrap({ hub: true, name: "" }, https443), { kind: "signin", name: "Harness Remote Hub" })
  const ready = parseHubBootstrap({ hub: true, authenticated: true, name: "Home", machines: [entry(), entry({ id: "machine_bad", basePath: "/nope" }), null, entry({ id: "machine_two", basePath: "/m/machine_two" })] }, https443)
  assert.equal(ready.kind, "ready")
  assert.deepEqual(ready.machines.map((machine) => machine.id), ["hub:machine_abc", "hub:machine_two"], "malformed entries are dropped, not fatal")
  assert.deepEqual(parseHubBootstrap({ hub: true, authenticated: true }, https443), { kind: "ready", name: "Harness Remote Hub", machines: [] })
})

function response(status, body, contentType = "application/json") {
  return { status, headers: new Headers(contentType ? { "content-type": contentType } : {}), json: async () => body }
}

test("fetchHubBootstrap: the probe is same-origin and relative to BASE_URL", async () => {
  let seen
  const result = await fetchHubBootstrap({
    baseUrl: "/", location: https443,
    fetchImpl: async (url, init) => { seen = { url, init }; return response(200, { hub: true, authenticated: true, name: "Home", machines: [entry()] }) }
  })
  assert.equal(result.kind, "ready")
  assert.equal(seen.url, "/api/v1/bootstrap")
  assert.equal(seen.init.credentials, "same-origin", "the session cookie, and only for this origin")
  const pages = await fetchHubBootstrap({ baseUrl: "/harness-remote-plus/", location: https443, fetchImpl: async (url) => { assert.equal(url, "/harness-remote-plus/api/v1/bootstrap"); return response(404, null) } })
  assert.equal(pages.kind, "none")
})

test("fetchHubBootstrap: a plain host is definitively not a hub, however it answers", async () => {
  const answers = [
    () => response(404, null),
    () => response(405, null),
    // The important one: an SPA fallback answers *every* path with 200 text/html.
    () => response(200, "<!doctype html>", "text/html; charset=utf-8"),
    () => response(200, "{}", ""),
    () => response(200, { hello: "world" })
  ]
  for (const answer of answers) assert.deepEqual(await fetchHubBootstrap({ location: https443, baseUrl: "/", fetchImpl: async () => answer() }), { kind: "none" })
})

test("fetchHubBootstrap: transient trouble is 'unavailable' (ask again), never an exception", async () => {
  assert.deepEqual(await fetchHubBootstrap({ location: https443, baseUrl: "/", fetchImpl: async () => { throw new TypeError("Failed to fetch") } }), { kind: "unavailable" })
  assert.deepEqual(await fetchHubBootstrap({ location: https443, baseUrl: "/", fetchImpl: async () => response(503, null) }), { kind: "unavailable" })
  assert.deepEqual(await fetchHubBootstrap({ location: https443, baseUrl: "/", fetchImpl: async () => ({ status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => { throw new SyntaxError("bad json") } }) }), { kind: "unavailable" })
})

test("fetchHubBootstrap gives up on a hung request instead of blocking the app", async () => {
  const started = Date.now()
  const result = await fetchHubBootstrap({
    location: https443, baseUrl: "/", timeoutMs: 40,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
  })
  assert.deepEqual(result, { kind: "unavailable" })
  assert.ok(Date.now() - started < 1_000)
})

test("a poll that changed nothing is recognised, so it changes nothing", () => {
  const a = [hubMachineFromPayload(entry(), https443)]
  assert.equal(sameHubMachines(a, [hubMachineFromPayload(entry(), https443)]), true)
  assert.equal(sameHubMachines(a, [hubMachineFromPayload(entry({ name: "Renamed" }), https443)]), false)
  assert.equal(sameHubMachines(a, [hubMachineFromPayload(entry({ basePath: "/m/machine_zzz" }), https443)]), false)
  assert.equal(sameHubMachines(a, []), false)
})
