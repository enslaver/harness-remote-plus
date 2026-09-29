import test from "node:test"
import assert from "node:assert/strict"
import { LokiClient, LokiError, buildQuery, parseTime, quoteLogQL, sanitizeLabels } from "../src/loki.js"
import { detectLevel } from "../src/events.js"

test("quoteLogQL escapes everything that could end the string or the query", () => {
  assert.equal(quoteLogQL('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteLogQL("back\\slash"), '"back\\\\slash"')
  assert.equal(quoteLogQL("line\nbreak\r\ttab"), '"line\\nbreak\\r\\ttab"')
})

test("a hostile search string cannot break out of the line filter", () => {
  const attack = '"} or {job=~".+"} |= "'
  const query = buildQuery({ filters: { machine_id: "machine_a" }, contains: attack })
  assert.equal(query, `{job="harness-remote",machine_id="machine_a"} |= "\\"} or {job=~\\".+\\"} |= \\""`)
  // Every quote inside the filter literal is escaped, so the only unescaped quotes are the delimiters.
  const literal = query.slice(query.indexOf("|= ") + 3)
  assert.equal(literal.match(/(?<!\\)"/g).length, 2)
})

test("label filters accept only safe values and known names", () => {
  assert.equal(buildQuery({ filters: { level: "error", source: "codex", ignored: "x" } }), '{job="harness-remote",source="codex",level="error"}')
  assert.equal(buildQuery({ filters: { level: "", source: undefined } }), '{job="harness-remote"}')
  for (const bad of ['a"b', "a b", "a}", "x".repeat(200), "a|b", "{x}"]) {
    assert.throws(() => buildQuery({ filters: { source: bad } }), RangeError, bad)
  }
  assert.throws(() => buildQuery({ filters: { machine_id: 5 } }), RangeError)
})

test("parseTime handles relative durations, epoch milliseconds, defaults and junk", () => {
  const now = 1_800_000_000_000
  assert.equal(parseTime("15m", now), now - 900_000)
  assert.equal(parseTime("2h", now), now - 7_200_000)
  assert.equal(parseTime("7d", now), now - 7 * 86_400_000)
  assert.equal(parseTime("1790000000000", now), 1_790_000_000_000)
  assert.equal(parseTime(undefined, now, 42), 42)
  assert.equal(parseTime("", now, 7), 7)
  for (const bad of ["yesterday", "-5m", "5x", "1e9", "12", "5m; drop"]) assert.throws(() => parseTime(bad, now), RangeError, bad)
})

test("sanitizeLabels drops empties, truncates values and rejects bad names", () => {
  assert.deepEqual(sanitizeLabels({ a: "x", b: "", c: undefined, d: null, e: "y".repeat(500) }).e.length, 128)
  assert.deepEqual(Object.keys(sanitizeLabels({ a: "x", b: "", c: undefined })), ["a"])
  assert.throws(() => sanitizeLabels({ "bad-name": "x" }), /Invalid Loki label name/)
  assert.throws(() => sanitizeLabels({ "1x": "x" }))
})

test("detectLevel finds errors and warnings in raw terminal lines", () => {
  assert.equal(detectLevel("[codex] spawn codex ENOENT: failed to start"), "error")
  assert.equal(detectLevel("Uncaught exception in handler"), "error")
  assert.equal(detectLevel("warning: deprecated flag"), "warn")
  assert.equal(detectLevel("Harness Remote is ready."), "info")
  assert.equal(detectLevel("terror alert"), "info", "word boundaries: no match inside another word")
})

function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })
    return handler(url, init)
  }
  return { impl, calls }
}

test("push sends nanosecond strings, sorted per stream, with the job label added", async () => {
  const { impl, calls } = recordingFetch(() => new Response(null, { status: 204 }))
  const loki = new LokiClient({ url: "http://loki:3100/", fetchImpl: impl })
  await loki.push([{ labels: { kind: "log", machine_id: "m1", empty: "" }, entries: [{ ts: 2_000, line: "second" }, { ts: 1_000, line: "first" }] }])
  assert.equal(calls[0].url, "http://loki:3100/loki/api/v1/push")
  assert.deepEqual(calls[0].body.streams[0].stream, { job: "harness-remote", kind: "log", machine_id: "m1" })
  assert.deepEqual(calls[0].body.streams[0].values, [["1000000000", "first"], ["2000000000", "second"]])
})

test("push with nothing to send makes no request", async () => {
  const { impl, calls } = recordingFetch(() => new Response(null, { status: 204 }))
  await new LokiClient({ url: "http://loki", fetchImpl: impl }).push([{ labels: {}, entries: [] }])
  assert.equal(calls.length, 0)
})

test("push distinguishes retryable outages from rejected batches", async () => {
  const failing = (status, text) => new LokiClient({ url: "http://loki", fetchImpl: async () => new Response(text, { status }) })
  await assert.rejects(failing(503, "busy").push([{ labels: {}, entries: [{ ts: 1, line: "x" }] }]), (error) => error instanceof LokiError && error.retryable === true && error.status === 503)
  await assert.rejects(failing(429, "slow down").push([{ labels: {}, entries: [{ ts: 1, line: "x" }] }]), (error) => error.retryable === true)
  await assert.rejects(failing(400, "timestamp too old").push([{ labels: {}, entries: [{ ts: 1, line: "x" }] }]), (error) => error.retryable === false && /too old/.test(error.message))
  const unreachable = new LokiClient({ url: "http://loki", fetchImpl: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }) } })
  await assert.rejects(unreachable.push([{ labels: {}, entries: [{ ts: 1, line: "x" }] }]), (error) => error.retryable === true && /ECONNREFUSED/.test(error.message))
})

test("query merges streams into one ordered timeline and hides Loki's own labels", async () => {
  const payload = { data: { result: [
    { stream: { job: "harness-remote", service_name: "harness-remote", detected_level: "info", machine_id: "m1", source: "codex" }, values: [["1000000000000000002", "b"], ["1000000000000000004", "d"]] },
    { stream: { job: "harness-remote", machine_id: "m1", source: "daemon" }, values: [["1000000000000000001", "a"], ["1000000000000000003", "c"]] }
  ] } }
  const { impl, calls } = recordingFetch(() => new Response(JSON.stringify(payload), { status: 200 }))
  const loki = new LokiClient({ url: "http://loki", fetchImpl: impl })

  const backward = await loki.query({ filters: { machine_id: "m1" }, contains: "x", start: 1_000, end: 2_000, limit: 3 })
  assert.deepEqual(backward.map((entry) => entry.line), ["d", "c", "b"], "newest first, trimmed to the limit")
  assert.deepEqual(backward[0].labels, { machine_id: "m1", source: "codex" })
  assert.equal(backward[0].ts, 1_000_000_000_000)

  const forward = await loki.query({ start: 1_000, end: 2_000, direction: "forward", limit: 10 })
  assert.deepEqual(forward.map((entry) => entry.line), ["a", "b", "c", "d"])

  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get("query"), '{job="harness-remote",machine_id="m1"} |= "x"')
  assert.equal(url.searchParams.get("start"), "1000000000")
  assert.equal(url.searchParams.get("direction"), "backward")
})

test("ready is false for a down or unreachable Loki, never throws", async () => {
  assert.equal(await new LokiClient({ url: "http://loki", fetchImpl: async () => new Response("no", { status: 503 }) }).ready(), false)
  assert.equal(await new LokiClient({ url: "http://loki", fetchImpl: async () => { throw new Error("down") } }).ready(), false)
  assert.equal(await new LokiClient({ url: "http://loki", fetchImpl: async () => new Response("ready") }).ready(), true)
})

// Opt-in: proves the client against the real thing, not just against my model of it.
//   docker run --rm -p 3100:3100 -v $PWD/deploy/loki/loki-config.yml:/etc/loki/config.yml grafana/loki:3.4.2 -config.file=/etc/loki/config.yml
test("round-trips through a real Loki", { skip: process.env.HUB_TEST_LOKI_URL ? false : "HUB_TEST_LOKI_URL is not set", timeout: 60_000 }, async () => {
  const loki = new LokiClient({ url: process.env.HUB_TEST_LOKI_URL })
  const machine = `machine_it_${Date.now()}`
  const now = Date.now()
  for (let attempt = 0; attempt < 40 && !(await loki.ready()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1_000))

  await loki.push([
    { labels: { kind: "log", source: "codex", stream: "stderr", level: "error", machine_id: machine }, entries: [{ ts: now - 500, line: 'boom "quoted" \\ back' }] },
    { labels: { kind: "log", source: "daemon", stream: "stdout", level: "info", machine_id: machine }, entries: [{ ts: now, line: "hello" }] }
  ])
  let entries = []
  for (let attempt = 0; attempt < 20 && entries.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    entries = await loki.query({ filters: { machine_id: machine }, start: now - 60_000, end: Date.now() + 60_000 })
  }
  assert.deepEqual(entries.map((entry) => entry.line), ["hello", 'boom "quoted" \\ back'])
  assert.equal(entries[1].labels.source, "codex")

  const onlyErrors = await loki.query({ filters: { machine_id: machine, level: "error" }, start: now - 60_000, end: Date.now() + 60_000 })
  assert.equal(onlyErrors.length, 1)
  const search = await loki.query({ filters: { machine_id: machine }, contains: "hello", start: now - 60_000, end: Date.now() + 60_000 })
  assert.deepEqual(search.map((entry) => entry.line), ["hello"])
  const injected = await loki.query({ filters: { machine_id: machine }, contains: '"} or {job=~".+"} |= "', start: now - 60_000, end: Date.now() + 60_000 })
  assert.deepEqual(injected, [], "the injection attempt is just a string that matches nothing")
  await assert.rejects(loki.push([{ labels: { machine_id: machine }, entries: [{ ts: 1_000_000, line: "ancient" }] }]), (error) => error.retryable === false)
})
