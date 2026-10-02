import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HubReporter, advertisedEndpoints, describeConfig, prepareHubReporting } from "../src/hub-reporter.js"
import { readHubState } from "../src/hub-options.js"
import { LogTee, createRedactor } from "../src/log-tee.js"
import { fakeStream, startFakeHub } from "./helpers/fake-hub.js"

const identity = { id: "machine_test-1", name: "desk" }
const baseConfig = { backend: "codex", host: "0.0.0.0", port: 4097, username: "harness", password: "gateway-pass-9931", roots: ["/dev"], corsOrigins: ["http://localhost:5173"], stateDirectory: "" }
const agents = [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available" }]

async function setup(overrides = {}) {
  const hub = overrides.hub ?? await startFakeHub()
  const dir = await mkdtemp(path.join(os.tmpdir(), "hr-reporter-"))
  const logs = []
  const tee = overrides.tee === null ? undefined : new LogTee({ redact: createRedactor([baseConfig.password]) })
  const options = { url: hub.url, enrollmentToken: hub.state.enrollmentToken, machineToken: undefined, advertise: [], noProxy: false, ...overrides.options }
  const reporter = new HubReporter({
    options,
    identity,
    config: { ...baseConfig, stateDirectory: dir, ...overrides.config },
    snapshot: () => ({ agents }),
    scoped: true,
    tee,
    stateDirectory: dir,
    lan: () => ["192.168.1.20"],
    collect: overrides.collect ?? (async () => [{ agentId: "codex", id: "s1", title: "Fix bug", directory: "/repo", status: "busy" }]),
    log: (message) => logs.push(message),
    version: "3.1.0",
    random: () => 0.5,
    request: overrides.request
  })
  return {
    hub, dir, logs, tee, reporter, options,
    async done() {
      await reporter.stop()
      tee?.detach()
      await rm(dir, { recursive: true, force: true })
      if (!overrides.hub) await hub.close()
    }
  }
}

test("enrolls with the enrollment token, sends credentials once, and saves its own token", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    const [enroll] = t.hub.of("/enroll")
    assert.equal(enroll.bearer, t.hub.state.enrollmentToken)
    assert.equal(enroll.body.machine.id, "machine_test-1")
    assert.equal(enroll.body.machine.version, "3.1.0")
    assert.deepEqual(enroll.body.endpoints, ["http://192.168.1.20:4097"])
    assert.equal(enroll.body.proxy, true)
    assert.deepEqual(enroll.body.credentials, { username: "harness", password: "gateway-pass-9931" })

    const [beat] = t.hub.of("/heartbeat")
    assert.equal(beat.bearer, "hrm_fake_1", "heartbeats use the per-machine token, not the shared enrollment token")
    assert.equal("credentials" in beat.body, false, "credentials were already delivered at enrollment")
    assert.equal(beat.body.proxy, true)
    assert.deepEqual(beat.body.agents, [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available" }])
    assert.equal(beat.body.sessions[0].id, "s1")
    assert.equal(beat.body.stats.droppedLogLines, 0)
    assert.ok(beat.body.stats.rss > 0)

    const saved = await readHubState(t.dir)
    assert.equal(saved.machineToken, "hrm_fake_1")
    assert.equal(saved.url, t.hub.url)
    if (process.platform !== "win32") assert.equal((await stat(path.join(t.dir, "hub.json"))).mode & 0o777, 0o600)
    assert.match(t.logs.join("\n"), /connected to .* \(enrolled as desk\)/)
  } finally {
    await t.done()
  }
})

test("the gateway password never appears in the reported configuration", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    const beat = t.hub.of("/heartbeat")[0].body
    const enroll = t.hub.of("/enroll")[0].body
    assert.deepEqual(beat.config, { backend: "codex", host: "0.0.0.0", port: 4097, roots: ["/dev"], corsOrigins: ["http://localhost:5173"], authRequired: true, harnessRemoteVersion: "3.1.0" })
    assert.ok(!JSON.stringify(beat).includes("gateway-pass-9931"))
    assert.ok(!JSON.stringify({ ...enroll, credentials: undefined }).includes("gateway-pass-9931"), "only the dedicated credentials field carries it")
  } finally {
    await t.done()
  }
})

test("describeConfig is an allow-list", () => {
  const described = describeConfig({ ...baseConfig, acpArgs: ["--secret-arg"], extra: "x", password: "p" }, "1")
  assert.deepEqual(Object.keys(described).sort(), ["authRequired", "backend", "corsOrigins", "harnessRemoteVersion", "host", "port", "roots"])
})

test("a machine with a saved token skips enrollment and just heartbeats", async () => {
  const hub = await startFakeHub()
  hub.state.tokens.add("hrm_saved")
  const t = await setup({ hub, options: { machineToken: "hrm_saved", enrollmentToken: undefined } })
  try {
    await t.reporter.start()
    assert.equal(hub.of("/enroll").length, 0)
    assert.equal(hub.of("/heartbeat")[0].bearer, "hrm_saved")
    assert.equal("credentials" in hub.of("/heartbeat")[0].body, true, "after a restart the credentials (which change per launch) are sent again")
  } finally {
    await t.done()
    await hub.close()
  }
})

test("--hub-no-proxy shares nothing: proxy false, no credentials, ever", async () => {
  const t = await setup({ options: { noProxy: true } })
  try {
    await t.reporter.start()
    await t.reporter.beat()
    for (const call of t.hub.calls) {
      if (call.path.endsWith("/ingest/logs")) continue
      assert.equal(call.body.proxy, false)
      assert.equal("credentials" in call.body, false)
    }
    assert.match(t.logs.join("\n"), /web UI not shared/)
  } finally {
    await t.done()
  }
})

test("a gateway bound to loopback advertises nothing and shares nothing", async () => {
  const t = await setup({ config: { host: "127.0.0.1" } })
  try {
    await t.reporter.start()
    assert.deepEqual(t.hub.of("/enroll")[0].body.endpoints, [])
    assert.equal(t.hub.of("/enroll")[0].body.proxy, false, "a remote hub cannot reach 127.0.0.1")
    assert.equal("credentials" in t.hub.of("/enroll")[0].body, false)
    assert.match(t.logs.join("\n"), /no reachable address to share/)
  } finally {
    await t.done()
  }
})

test("a gateway with no password shares nothing to proxy with", async () => {
  const t = await setup({ config: { username: "", password: "" } })
  try {
    await t.reporter.start()
    assert.equal(t.hub.of("/enroll")[0].body.proxy, false)
  } finally {
    await t.done()
  }
})

test("advertisedEndpoints: --hub-advertise-host gets this gateway's own port; bad values warn instead of vanishing", () => {
  const lan = () => ["10.0.0.5"]
  const warnings = []
  const warn = (message) => warnings.push(message)
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [], advertiseHosts: ["jedi.tail1.ts.net"] }, config: { ...baseConfig, port: 4123 }, lan, warn }), ["http://jedi.tail1.ts.net:4123"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [], advertiseHosts: ["jedi:5000", "100.64.0.5"] }, config: baseConfig, lan, warn }), ["http://jedi:5000", "http://100.64.0.5:4097"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: ["jedi.tail1.ts.net"] }, config: baseConfig, lan, warn }), [])
  assert.match(warnings[0], /--hub-advertise-host/)
})

test("advertisedEndpoints: explicit list wins, wildcard uses LAN addresses, specific host is used as-is", () => {
  const lan = () => ["10.0.0.5", "192.168.1.20"]
  assert.deepEqual(advertisedEndpoints({ options: { advertise: ["http://100.64.0.5:4097/", "junk"] }, config: baseConfig, lan }), ["http://100.64.0.5:4097"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [] }, config: baseConfig, lan }), ["http://10.0.0.5:4097", "http://192.168.1.20:4097"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [] }, config: { ...baseConfig, host: "::" }, lan }), ["http://10.0.0.5:4097", "http://192.168.1.20:4097"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [] }, config: { ...baseConfig, host: "192.168.7.7" }, lan }), ["http://192.168.7.7:4097"])
  assert.deepEqual(advertisedEndpoints({ options: { advertise: [] }, config: { ...baseConfig, host: "fd00::1" }, lan }), ["http://[fd00::1]:4097"])
  for (const loopback of ["127.0.0.1", "::1", "localhost"]) assert.deepEqual(advertisedEndpoints({ options: { advertise: [] }, config: { ...baseConfig, host: loopback }, lan }), [])
})

test("sends credentials again when the hub asks for them", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.needCredentials = true
    await t.reporter.beat()
    t.hub.state.needCredentials = false
    await t.reporter.beat()
    const beats = t.hub.of("/heartbeat")
    assert.equal("credentials" in beats[0].body, false)
    assert.equal("credentials" in beats[1].body, false, "the hub had not yet asked when this one was sent")
    assert.equal("credentials" in beats[2].body, true, "asked, so sent")
    await t.reporter.beat()
    assert.equal("credentials" in t.hub.of("/heartbeat")[3].body, false, "and only once")
  } finally {
    await t.done()
  }
})

test("a session inventory failure does not stop the heartbeat", async () => {
  const t = await setup({ collect: async () => { throw new Error("gateway hiccup") } })
  try {
    await t.reporter.start()
    assert.deepEqual(t.hub.of("/heartbeat")[0].body.sessions, [])
  } finally {
    await t.done()
  }
})

test("if the hub forgets this machine (401), it enrolls again with the enrollment token", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.tokens.clear()
    await t.reporter.beat()
    assert.equal(t.hub.of("/enroll").length, 2)
    assert.equal((await readHubState(t.dir)).machineToken, "hrm_fake_2")
    assert.equal(t.hub.of("/heartbeat").at(-1).bearer, "hrm_fake_2")
    assert.equal("credentials" in t.hub.of("/heartbeat").at(-1).body, false, "re-enrollment delivered them")
    assert.match(t.logs.join("\n"), /no longer recognises this machine; enrolling again/)
  } finally {
    await t.done()
  }
})

test("a hub that refuses a token it just issued cannot trap the machine in an enroll loop", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.tokens.clear()
    // Every future token is refused straight away.
    const original = t.hub.state.tokens.add.bind(t.hub.state.tokens)
    t.hub.state.tokens.add = (token) => { void token; return t.hub.state.tokens }
    void original
    await t.reporter.beat()
    assert.equal(t.hub.of("/enroll").length, 2, "one re-enrollment, not an unbounded number")
    assert.ok(t.reporter.nextDelayMs >= 1_000)
  } finally {
    await t.done()
  }
})

test("without an enrollment token a 401 stops reporting, once, and leaves the gateway alone", async () => {
  const hub = await startFakeHub()
  const t = await setup({ hub, options: { machineToken: "hrm_revoked", enrollmentToken: undefined } })
  try {
    await t.reporter.start()
    assert.equal(hub.of("/heartbeat").length, 1)
    assert.match(t.logs.join("\n"), /no longer recognises this machine and no enrollment token/)
    assert.match(t.logs.join("\n"), /gateway itself is unaffected/)
    assert.equal(t.tee.enabled, false, "no point buffering logs for a hub we have stopped talking to")
    assert.equal(t.reporter.stopped, true)
    assert.equal((await readHubState(t.dir))?.machineToken ?? "", "")
  } finally {
    await t.done()
    await hub.close()
  }
})

test("a rejected enrollment token is fatal for the run and says how to fix it", async () => {
  const t = await setup({ options: { enrollmentToken: "hre_wrong" } })
  try {
    await t.reporter.start()
    assert.equal(t.hub.of("/enroll").length, 1)
    assert.match(t.logs.join("\n"), /rejected the enrollment token.*Add machine page.*--hub-token/s)
    assert.equal(t.hub.of("/heartbeat").length, 0)
    assert.equal(t.reporter.stopped, true)
  } finally {
    await t.done()
  }
})

test("no tokens at all is a clear fatal, not a crash", async () => {
  const t = await setup({ options: { enrollmentToken: undefined, machineToken: undefined } })
  try {
    await t.reporter.start()
    assert.match(t.logs.join("\n"), /not enrolled and no enrollment token/)
    assert.equal(t.hub.calls.length, 0)
  } finally {
    await t.done()
  }
})

test("an unreachable hub never throws, backs off exponentially, and logs the outage once", async () => {
  let attempts = 0
  const request = async () => { attempts += 1; throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }) }
  const t = await setup({ request })
  try {
    await t.reporter.start()
    assert.equal(attempts, 1)
    assert.equal(t.reporter.nextDelayMs, 5_000)
    for (const expected of [10_000, 20_000, 40_000, 80_000, 160_000]) {
      await t.reporter.beat()
      assert.equal(t.reporter.nextDelayMs, expected)
    }
    await t.reporter.beat()
    await t.reporter.beat()
    assert.equal(t.reporter.nextDelayMs, 5 * 60_000, "capped at five minutes")
    assert.equal(t.logs.length, 1, "one line for the whole outage, not one per attempt")
    assert.match(t.logs[0], /could not reach .*ECONNREFUSED.*will keep retrying/, "and it is not silent when the very first attempt fails")
  } finally {
    await t.done()
  }
})

test("recovers when the hub comes back, resets the backoff and says so", async () => {
  const hub = await startFakeHub()
  let down = true
  const t = await setup({ hub, request: async (url, init) => {
    if (down) throw Object.assign(new Error("x"), { code: "ETIMEDOUT" })
    const { requestJson } = await import("../src/http-json.js")
    return requestJson(url, init)
  } })
  try {
    await t.reporter.start()
    assert.equal(t.reporter.backoffMs, 5_000)
    down = false
    await t.reporter.beat()
    assert.equal(t.reporter.backoffMs, 0)
    assert.equal(t.reporter.nextDelayMs, 30_000)
    assert.match(t.logs.join("\n"), /could not reach[\s\S]*connected to/)
  } finally {
    await t.done()
    await hub.close()
  }
})

test("a missing Retry-After can never turn into a hot retry loop (NaN delay)", async () => {
  const t = await setup()
  try {
    t.hub.state.enrollStatus = 429
    await t.reporter.start()
    assert.ok(Number.isFinite(t.reporter.nextDelayMs) && t.reporter.nextDelayMs >= 5_000, `delay was ${t.reporter.nextDelayMs}`)

    t.hub.state.enrollStatus = 200
    await t.reporter.beat()
    t.hub.state.heartbeatStatus = 503
    await t.reporter.beat()
    assert.ok(Number.isFinite(t.reporter.nextDelayMs) && t.reporter.nextDelayMs >= 5_000)
  } finally {
    await t.done()
  }
})

test("honours a sane Retry-After from the hub", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.heartbeatStatus = 429
    t.hub.state.retryAfter = 90
    await t.reporter.beat()
    assert.ok(t.reporter.nextDelayMs >= 85_000 && t.reporter.nextDelayMs <= 95_000, `delay was ${t.reporter.nextDelayMs}`)
  } finally {
    await t.done()
  }
})

test("the interval comes from the hub unless the operator pinned it", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    assert.equal(t.reporter.intervalMs, 30_000)
  } finally {
    await t.done()
  }
  const pinned = await setup({ options: { intervalMs: 7_000 } })
  try {
    await pinned.reporter.start()
    assert.equal(pinned.reporter.intervalMs, 7_000)
  } finally {
    await pinned.done()
  }
})

// ---- log shipping -----------------------------------------------------------------------------------

test("ships queued log lines in order under the machine token", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.tee.ingest("stderr", "[codex] one\ntwo\n")
    await t.reporter.flushLogs()
    const [call] = t.hub.of("/ingest/logs")
    assert.equal(call.bearer, "hrm_fake_1")
    assert.deepEqual(call.body.entries.map((entry) => [entry.stream, entry.source, entry.line]), [["stderr", "codex", "[codex] one"], ["stderr", "daemon", "two"]])
    assert.ok(call.body.entries.every((entry) => Number.isFinite(entry.ts)))
    assert.equal(t.tee.size, 0)
  } finally {
    await t.done()
  }
})

test("logs written before enrollment are kept and shipped afterwards", async () => {
  const t = await setup()
  try {
    t.tee.ingest("stdout", "early startup line\n")
    await t.reporter.flushLogs()
    assert.equal(t.hub.of("/ingest/logs").length, 0, "no token yet, nothing sent")
    assert.equal(t.tee.size, 1)
    await t.reporter.start()
    await t.reporter.flushLogs()
    assert.deepEqual(t.hub.shippedLines(), ["early startup line"])
  } finally {
    await t.done()
  }
})

test("secrets are redacted before anything leaves the machine", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.tee.ingest("stderr", "[codex] auth failed for password gateway-pass-9931 and Authorization: Basic Zm9vOmJhcg==\n")
    await t.reporter.flushLogs()
    const shipped = t.hub.shippedLines().join("\n")
    assert.ok(!shipped.includes("gateway-pass-9931"))
    assert.ok(!shipped.includes("Zm9vOmJhcg=="))
    assert.match(shipped, /auth failed for password \[redacted\] and Authorization: Basic \[redacted\]/)
  } finally {
    await t.done()
  }
})

test("a hub without log storage (501) turns shipping off and empties the queue", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.ingestStatus = 501
    t.tee.ingest("stdout", "a\nb\n")
    await t.reporter.flushLogs()
    assert.equal(t.reporter.logsDisabled, true)
    assert.equal(t.tee.enabled, false)
    assert.equal(t.tee.size, 0)
    t.tee.ingest("stdout", "c\n")
    await t.reporter.flushLogs()
    assert.equal(t.hub.of("/ingest/logs").length, 1, "no further attempts")
    assert.match(t.logs.join("\n"), /no log storage configured/)
  } finally {
    await t.done()
  }
})

test("a temporary failure (503) keeps the lines, slows down, and delivers them later, in order", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.ingestStatus = 503
    t.tee.ingest("stdout", "one\ntwo\n")
    await t.reporter.flushLogs()
    assert.equal(t.tee.size, 2)
    assert.equal(t.reporter.logBackoffMs, 4_000)
    t.tee.ingest("stdout", "three\n")
    await t.reporter.flushLogs()
    assert.equal(t.reporter.logBackoffMs, 8_000)

    t.hub.state.ingestStatus = 200
    await t.reporter.flushLogs()
    assert.deepEqual(t.hub.shippedLines().slice(-3), ["one", "two", "three"])
    assert.equal(t.reporter.logBackoffMs, 0)
  } finally {
    await t.done()
  }
})

test("a batch the hub rejects outright is dropped and counted so it cannot wedge the queue", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.hub.state.ingestStatus = 400
    t.tee.ingest("stdout", "bad\nworse\n")
    await t.reporter.flushLogs()
    assert.equal(t.tee.size, 0)
    assert.equal(t.tee.dropped, 2)
  } finally {
    await t.done()
  }
})

test("a network error while shipping keeps the lines", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.reporter.request = async () => { throw Object.assign(new Error("x"), { code: "ECONNRESET" }) }
    t.tee.ingest("stdout", "keep me\n")
    await t.reporter.flushLogs()
    assert.equal(t.tee.size, 1)
  } finally {
    await t.done()
  }
})

test("large queues go out in batches of at most 500", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.tee.ingest("stdout", `${Array.from({ length: 1_200 }, (_, index) => `line ${index}`).join("\n")}\n`)
    await t.reporter.flushLogs()
    assert.deepEqual(t.hub.of("/ingest/logs").map((call) => call.body.entries.length), [500, 500, 200])
    assert.equal(t.hub.shippedLines()[1_199], "line 1199", "order is preserved across batches")
  } finally {
    await t.done()
  }
})

test("concurrent flushes share one request so batches cannot interleave", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.tee.ingest("stdout", "a\nb\n")
    await Promise.all([t.reporter.flushLogs(), t.reporter.flushLogs(), t.reporter.flushLogs()])
    assert.equal(t.hub.of("/ingest/logs").length, 1)
  } finally {
    await t.done()
  }
})

test("stop() gives the final lines a chance to leave", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    t.tee.ingest("stderr", "[codex] fatal: shutting down because of X\n")
    await t.reporter.stop()
    assert.deepEqual(t.hub.shippedLines(), ["[codex] fatal: shutting down because of X"])
  } finally {
    await t.done()
  }
})

// ---- wiring -----------------------------------------------------------------------------------------

test("prepareHubReporting is inert when no hub is configured: nothing patched, nothing sent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hr-prepare-"))
  const stdout = fakeStream()
  const stderr = fakeStream()
  const [outWrite, errWrite] = [stdout.write, stderr.write]
  try {
    const handle = await prepareHubReporting({ flags: { advertise: [] }, environment: {}, config: { stateDirectory: dir, password: "x" }, streams: [stdout, stderr] })
    assert.equal(handle, null)
    assert.equal(stdout.write, outWrite)
    assert.equal(stderr.write, errWrite)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a hub URL with no token says so and continues without the hub", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hr-prepare-"))
  const messages = []
  const stdout = fakeStream()
  try {
    const handle = await prepareHubReporting({ flags: { advertise: [], url: "https://hub.example.com" }, environment: {}, config: { stateDirectory: dir }, streams: [stdout, fakeStream()], log: (message) => messages.push(message) })
    assert.equal(handle, null)
    assert.match(messages[0], /without a token.*--hub-token.*Continuing without the hub/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("end to end: configured install captures output, redacts it, enrolls, ships, and detaches on stop", async () => {
  const hub = await startFakeHub()
  const dir = await mkdtemp(path.join(os.tmpdir(), "hr-e2e-"))
  const stdout = fakeStream()
  const stderr = fakeStream()
  const [outWrite, errWrite] = [stdout.write, stderr.write]
  try {
    const handle = await prepareHubReporting({
      flags: { advertise: [], url: hub.url, token: hub.state.enrollmentToken },
      environment: {},
      config: { ...baseConfig, stateDirectory: dir },
      streams: [stdout, stderr],
      log: () => {}
    })
    assert.ok(handle)
    assert.notEqual(stderr.write, errWrite, "output is being tapped")

    // Written before the reporter starts, e.g. by early startup code.
    stderr.write("[codex] adapter crashed; password was gateway-pass-9931\n")
    await handle.start({ identity, snapshot: () => ({ agents }), scoped: true })
    stdout.write("Harness daemon ready\n")
    await handle.stop()

    assert.match(stderr.out, /gateway-pass-9931/, "the local terminal still sees the raw line; only the copy is redacted")
    assert.deepEqual(hub.shippedLines(), ["[codex] adapter crashed; password was [redacted]", "Harness daemon ready"])
    assert.equal(stderr.write, errWrite, "stop() detaches")
    assert.equal(stdout.write, outWrite)
    const saved = JSON.parse(await readFile(path.join(dir, "hub.json"), "utf8"))
    assert.equal(saved.machineId, "machine_test-1")
  } finally {
    await rm(dir, { recursive: true, force: true })
    await hub.close()
  }
})

test("log batches are bounded by size as well as count, so long lines cannot exceed what the hub accepts", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    // 300 lines of ~6 kB is ~1.8 MB: by count alone that is one batch, which the hub would answer with 413.
    t.tee.ingest("stdout", `${Array.from({ length: 300 }, (_, index) => `${index} ${"w".repeat(6_000)}`).join("\n")}\n`)
    await t.reporter.flushLogs()
    const batches = t.hub.of("/ingest/logs")
    assert.ok(batches.length >= 2, `expected the queue to be split, got ${batches.length} batch(es)`)
    for (const call of batches) {
      assert.ok(JSON.stringify(call.body).length < 1_500_000, "every request stays well under the hub's 2 MB body limit")
    }
    assert.equal(t.hub.shippedLines().length, 300, "nothing was lost")
    assert.equal(t.tee.dropped, 0)
  } finally {
    await t.done()
  }
})

test("the heartbeat says which agents' Session lists were complete", async () => {
  const t = await setup({ collect: async () => ({ sessions: [{ agentId: "codex", id: "s1", title: "A", directory: "/r", status: "idle" }], completeAgents: ["codex"] }) })
  try {
    await t.reporter.start()
    const [beat] = t.hub.of("/heartbeat")
    assert.deepEqual(beat.body.sessionAgents, ["codex"])
    assert.equal(beat.body.sessions[0].id, "s1")
  } finally {
    await t.done()
  }
})

test("a collector that returns a bare list claims no completeness, so nothing can be marked gone", async () => {
  const t = await setup()
  try {
    await t.reporter.start()
    assert.deepEqual(t.hub.of("/heartbeat")[0].body.sessionAgents, [])
  } finally {
    await t.done()
  }
})

test("an inventory too large for the hub is reported as empty instead of making the machine look offline", async () => {
  const huge = Array.from({ length: 4_000 }, (_, index) => ({ agentId: "codex", id: `s${index}`, title: "t".repeat(300), directory: "d".repeat(1_000), status: "idle" }))
  const t = await setup({ collect: async () => ({ sessions: huge, completeAgents: ["codex"] }) })
  try {
    await t.reporter.start()
    const [beat] = t.hub.of("/heartbeat")
    assert.deepEqual(beat.body.sessions, [])
    assert.deepEqual(beat.body.sessionAgents, [], "an emptied list must not be mistaken for 'every Session is gone'")
  } finally {
    await t.done()
  }
})
