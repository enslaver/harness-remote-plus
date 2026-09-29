import test from "node:test"
import assert from "node:assert/strict"
import { LogTee, createRedactor } from "../src/log-tee.js"
import { fakeStream } from "./helpers/fake-hub.js"

const lines = (tee) => tee.take(tee.size).map((entry) => entry.line)

test("splits chunks into lines, handles CRLF and holds a partial line until it completes", () => {
  const tee = new LogTee({ flushPartialMs: 60_000 })
  tee.ingest("stdout", "first\nsecond\r\nthi")
  assert.deepEqual(lines(tee), ["first", "second"])
  tee.ingest("stdout", "rd\n")
  assert.deepEqual(lines(tee), ["third"])
  tee.detach()
})

test("streams are buffered independently", () => {
  const tee = new LogTee({ flushPartialMs: 60_000 })
  tee.ingest("stdout", "out-")
  tee.ingest("stderr", "err\n")
  tee.ingest("stdout", "put\n")
  const taken = tee.take(10)
  assert.deepEqual(taken.map((entry) => [entry.stream, entry.line]), [["stderr", "err"], ["stdout", "out-put"]])
  tee.detach()
})

test("a partial line with no newline still ships after the idle flush", async () => {
  const tee = new LogTee({ flushPartialMs: 20 })
  tee.ingest("stderr", "Enter passphrase: ")
  assert.equal(tee.size, 0)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(lines(tee), ["Enter passphrase:"])
  tee.detach()
})

test("strips ANSI colour codes and skips blank lines", () => {
  const tee = new LogTee()
  tee.ingest("stdout", "\u001b[31mred\u001b[0m text\n\n   \n\u001b[2K\u001b[1Gprogress\n")
  assert.deepEqual(lines(tee), ["red text", "progress"])
  tee.detach()
})

test("derives the source from a leading [name] prefix and leaves the line intact", () => {
  const tee = new LogTee()
  tee.ingest("stderr", "[codex] spawn codex ENOENT\n[Claude] fine\nplain daemon line\n[not a source because too long xxxxxxxxxxxxxxxxxxxxxxxxxxx] y\n")
  const entries = tee.take(10)
  assert.deepEqual(entries.map((entry) => [entry.source, entry.line]), [
    ["codex", "[codex] spawn codex ENOENT"],
    ["claude", "[Claude] fine"],
    ["daemon", "plain daemon line"],
    ["daemon", "[not a source because too long xxxxxxxxxxxxxxxxxxxxxxxxxxx] y"]
  ])
  tee.detach()
})

test("the queue is bounded: the oldest lines are dropped and counted", () => {
  const tee = new LogTee({ maxLines: 3 })
  for (const n of [1, 2, 3, 4, 5]) tee.ingest("stdout", `line ${n}\n`)
  assert.deepEqual(lines(tee), ["line 3", "line 4", "line 5"])
  assert.equal(tee.dropped, 2)
  tee.detach()
})

test("requeue puts undelivered lines back first and applies the same bound", () => {
  const tee = new LogTee({ maxLines: 4 })
  for (const n of [1, 2, 3]) tee.ingest("stdout", `old ${n}\n`)
  const batch = tee.take(3)
  tee.ingest("stdout", "new 1\nnew 2\n")
  tee.requeue(batch)
  assert.deepEqual(lines(tee), ["old 2", "old 3", "new 1", "new 2"], "the oldest surplus goes, the most recent output survives")
  assert.equal(tee.dropped, 1)
  tee.detach()
})

test("disabled means nothing is queued", () => {
  const tee = new LogTee()
  tee.enabled = false
  tee.ingest("stdout", "ignored\n")
  assert.equal(tee.size, 0)
  tee.detach()
})

test("attach is invisible: the original write runs first, with its own return value", () => {
  const stream = fakeStream()
  const original = stream.write
  const tee = new LogTee()
  tee.attach(stream, "stderr")
  assert.notEqual(stream.write, original)
  const result = stream.write("hello\n")
  assert.equal(result, true)
  assert.equal(stream.out, "hello\n", "the terminal still sees exactly what was written")
  assert.deepEqual(lines(tee), ["hello"])
  stream.write(Buffer.from("from a buffer\n"))
  assert.deepEqual(lines(tee), ["from a buffer"])
  tee.detach()
  assert.equal(stream.write, original, "detach restores the stream")
  stream.write("after\n")
  assert.equal(tee.size, 0)
})

test("a failure in the tee never breaks the caller's write", () => {
  const stream = fakeStream()
  const tee = new LogTee({ redact: () => { throw new Error("redactor bug") } })
  tee.attach(stream, "stdout")
  assert.doesNotThrow(() => stream.write("still printed\n"))
  assert.equal(stream.out, "still printed\n")
  tee.detach()
})

test("write callbacks and encodings are passed through", () => {
  let seen
  const stream = { write(chunk, encoding, callback) { seen = { chunk, encoding, callback }; return false } }
  const tee = new LogTee()
  tee.attach(stream, "stdout")
  const callback = () => {}
  assert.equal(stream.write("x\n", "utf8", callback), false, "backpressure signal is preserved")
  assert.deepEqual(seen, { chunk: "x\n", encoding: "utf8", callback })
  tee.detach()
})

test("redaction removes literal secrets and credential-shaped strings", () => {
  const redact = createRedactor(["hunter2-gateway", "hre_enrollmentTOKENvalue12345"])
  const cases = [
    ["gateway password is hunter2-gateway ok", "gateway password is [redacted] ok"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
    ["authorization: bearer abc.def-ghi", "authorization: bearer [redacted]"],
    ["started with --password s3cret --port 1", "started with --password [redacted] --port 1"],
    ["--password=s3cret", "--password=[redacted]"],
    ["--hub-token hre_AAAAAAAAAAAAAAAAAAAAAAAA", "--hub-token [redacted]"],
    ["env HARNESS_REMOTE_PASSWORD=topsecret set", "env HARNESS_REMOTE_PASSWORD=[redacted] set"],
    ["token hrm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked", "token [redacted-hub-token] leaked"],
    ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA end", "key [redacted-api-key] end"],
    ["gh ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end", "gh [redacted-github-token] end"],
    ["slack xoxb-1234567890-abcdef end", "slack [redacted-slack-token] end"]
  ]
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input)
  assert.equal(redact("nothing sensitive here"), "nothing sensitive here")
})

test("very short secrets are not used as literals (they would shred ordinary text)", () => {
  const redact = createRedactor(["ab", "", undefined, null, "12345"])
  assert.equal(redact("a lab about 12345 things"), "a lab about 12345 things")
})

test("redaction happens before queueing, so a secret never sits in the queue", () => {
  const tee = new LogTee({ redact: createRedactor(["hunter2-gateway"]) })
  tee.ingest("stderr", "[codex] login with hunter2-gateway failed\n")
  assert.ok(!JSON.stringify(tee.queue).includes("hunter2-gateway"))
  assert.equal(tee.queue[0].line, "[codex] login with [redacted] failed")
  tee.detach()
})

test("output that never ends a line is cut into bounded lines instead of piling up (and stays fast)", () => {
  const tee = new LogTee({ flushPartialMs: 60_000, maxLines: 100_000 })
  const started = process.hrtime.bigint()
  // 2 MB of "progress bar" text redrawn with \r and never a newline, in small writes.
  for (let index = 0; index < 20_000; index += 1) tee.ingest("stdout", `${"#".repeat(99)}\r`)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 1_500, `ingest of newline-free output took ${elapsedMs.toFixed(0)} ms; it must not re-scan what it already holds`)
  const held = tee.pending.get("stdout")?.length ?? 0
  assert.ok(held <= 8 * 1024, `the held partial line is bounded (held ${held} characters)`)
  assert.ok(tee.size > 0, "the cut lines were queued")
  assert.ok(tee.take(tee.size).every((entry) => entry.line.length <= 8 * 1024 + 20))
  tee.detach()
})

test("a very long line is truncated, and a secret inside it is redacted before the cut", () => {
  const tee = new LogTee({ redact: createRedactor(["hunter2-secret"]) })
  tee.ingest("stdout", `start hunter2-secret ${"x".repeat(50_000)}\n`)
  const [entry] = tee.take(1)
  assert.ok(entry.line.length < 8 * 1024 + 20)
  assert.match(entry.line, /…\[truncated\]$/)
  assert.ok(!entry.line.includes("hunter2-secret"))
  tee.detach()
})

test("a CRLF split across two writes is still one line ending", () => {
  const tee = new LogTee({ flushPartialMs: 60_000 })
  tee.ingest("stdout", "first\r")
  tee.ingest("stdout", "\nsecond\n")
  assert.deepEqual(lines(tee), ["first", "second"])
  tee.detach()
})

test("takeWithin bounds a batch by size as well as by count, and always makes progress", () => {
  const tee = new LogTee()
  for (let index = 0; index < 10; index += 1) tee.ingest("stdout", `${"y".repeat(5_000)}\n`)
  const batch = tee.takeWithin(500, 12_000)
  assert.equal(batch.length, 2, "two 5 kB lines fit in 12 kB, a third does not")
  const one = new LogTee()
  one.ingest("stdout", `${"z".repeat(5_000)}\n`)
  assert.equal(one.takeWithin(500, 10).length, 1, "a single line larger than the byte limit still ships alone")
})

test("redacts the credential shapes that used to slip through", () => {
  const redact = createRedactor(["s3cret-literal"])
  const cases = [
    ['{"authorization":"Bearer abc.def.ghi"}', "abc.def.ghi"],
    ["authorization=Bearer abc123token", "abc123token"],
    ["Authorization: Basic aGFybmVzczpwdw==", "aGFybmVzczpwdw"],
    ["connecting to http://deploy:p4ssw0rd-x@registry.internal:5000/v2", "p4ssw0rd-x"],
    ["export API_TOKEN=tok_live_1234567890", "tok_live_1234567890"],
    ['{"apiKey": "k-1234567890abcdef"}', "k-1234567890abcdef"],
    ['run --password="two words here" --port 4900', "words here"],
    ["password: hunter2hunter2", "hunter2hunter2"],
    ["aws key AKIAIOSFODNN7EXAMPLE in env", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9"],
    ["plain s3cret-literal text", "s3cret-literal"]
  ]
  for (const [input, secret] of cases) {
    const output = redact(input)
    assert.ok(!output.includes(secret), `${JSON.stringify(input)} still contains ${secret}: ${output}`)
  }
})

test("redaction leaves ordinary log lines alone", () => {
  const redact = createRedactor()
  for (const line of ["[omp] ready to serve sessions", "Harness daemon ready at http://0.0.0.0:4900", "created session fake-1", "GET /v1/machine 200 12ms", "tokens used: 1520 of 200000"]) {
    assert.equal(redact(line), line)
  }
})
