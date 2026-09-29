import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { ago, clip, installCommands, parseRoute, powershellQuote, proxyState, sessionTone, shellQuote } from "../public/util.js"

test("ago reads naturally at each scale and tolerates bad input", () => {
  const now = Date.parse("2026-06-01T12:00:00Z")
  const at = (secondsAgo) => now - secondsAgo * 1000
  assert.equal(ago(at(5), now), "just now")
  assert.equal(ago(at(60), now), "1 min ago")
  assert.equal(ago(at(5 * 60), now), "5 min ago")
  assert.equal(ago(at(3 * 3600), now), "3 h ago")
  assert.equal(ago(at(3 * 86400), now), "3 d ago")
  assert.equal(ago(new Date(at(120)).toISOString(), now), "2 min ago")
  assert.equal(ago(null, now), "never")
  assert.equal(ago("nonsense", now), "unknown")
  assert.equal(ago(now + 60_000, now), "just now", "a slightly-fast remote clock is not 'in the future'")
})

test("clip only shortens what is too long", () => {
  assert.equal(clip("short", 10), "short")
  assert.equal(clip("abcdefghij", 5), "abcd…")
  assert.equal(clip(undefined, 5), "")
})

test("sessionTone maps harness statuses to the UI vocabulary", () => {
  assert.equal(sessionTone("busy"), "busy")
  assert.equal(sessionTone("retry"), "busy")
  assert.equal(sessionTone("waiting"), "attention")
  assert.equal(sessionTone("idle"), "idle")
  assert.equal(sessionTone("???"), "unknown")
})

test("proxyState explains each situation in words a person can act on", () => {
  const machine = (proxy) => ({ proxy: { enabled: true, hasCredentials: true, reachable: null, endpoint: null, latencyMs: null, error: null, ...proxy } })
  assert.equal(proxyState(machine({ enabled: false })).tone, "off")
  assert.equal(proxyState(machine({ hasCredentials: false })).tone, "off")
  assert.equal(proxyState(machine({})).tone, "pending")
  const ok = proxyState(machine({ reachable: true, endpoint: "http://10.0.0.5:4097", latencyMs: 12 }))
  assert.equal(ok.tone, "ok")
  assert.match(ok.detail, /10\.0\.0\.5:4097.*12 ms/)
  const bad = proxyState(machine({ reachable: false, error: "ECONNREFUSED" }))
  assert.equal(bad.tone, "warn")
  assert.equal(bad.detail, "ECONNREFUSED")
})

test("shellQuote leaves plain words alone and neutralises everything else", () => {
  assert.equal(shellQuote("hre_AbC-123_x"), "hre_AbC-123_x")
  assert.equal(shellQuote("https://hub.example.com:8443"), "https://hub.example.com:8443")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote("a b"), "'a b'")
  assert.equal(shellQuote(""), "''")
})

test("shell-quoted values round-trip through a real shell without expansion", () => {
  for (const nasty of ["$(touch /tmp/pwned)", "`id`", "a;b", "it's \"quoted\"", "a b\tc", "$HOME", "x\ny", "*", "!bang"]) {
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(nasty)}`], { encoding: "utf8" })
    assert.equal(out, nasty, nasty)
  }
})

test("powershellQuote doubles single quotes", () => {
  assert.equal(powershellQuote("it's"), "'it''s'")
  assert.equal(powershellQuote("$env:X"), "'$env:X'", "single-quoted PowerShell strings do not expand")
})

test("installCommands puts the token in the environment, not argv, for both shells", () => {
  const commands = installCommands({ installCommand: "npx --yes github:enslaver/harness-remote-plus", publicUrl: "https://hub.example.com", token: "hre_abc" })
  assert.equal(commands.posix, "HARNESS_REMOTE_HUB_TOKEN=hre_abc npx --yes github:enslaver/harness-remote-plus --hub https://hub.example.com")
  assert.equal(commands.powershell, "$env:HARNESS_REMOTE_HUB_TOKEN='hre_abc'; npx --yes github:enslaver/harness-remote-plus --hub 'https://hub.example.com'")
  assert.ok(!commands.posix.includes("--hub-token"))
})

test("parseRoute", () => {
  assert.deepEqual(parseRoute(""), { name: "machines" })
  assert.deepEqual(parseRoute("#/"), { name: "machines" })
  assert.deepEqual(parseRoute("#/sessions"), { name: "sessions" })
  assert.deepEqual(parseRoute("#/logs"), { name: "logs" })
  assert.deepEqual(parseRoute("#/enroll"), { name: "enroll" })
  assert.deepEqual(parseRoute("#/machines/machine_a%20b"), { name: "machine", id: "machine_a b" })
  assert.deepEqual(parseRoute("#/machines"), { name: "machines" })
  assert.deepEqual(parseRoute("#/bogus/x"), { name: "machines" })
})
