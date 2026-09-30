import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { ACTIVITY_LABELS, ACTIVITY_ORDER, activityLabel, activityTone, ago, clip, groupSessions, installCommands, parseRoute, powershellQuote, proxyState, safeNext, sessionSearchParams, sessionTone, shellQuote } from "../public/util.js"

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

test("safeNext only ever returns a same-origin path (no open redirect after sign-in)", () => {
  assert.equal(safeNext("?next=%2F"), "/")
  assert.equal(safeNext("?next=%2Fsome%2Fpath%3Fa%3D1"), "/some/path?a=1")
  assert.equal(safeNext("?next=%2Fhubbub"), "/hubbub", "only /hub and /hub/... are excluded, not other prefixes")
  for (const bad of [
    "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "evil.example", "", "/\r\nSet-Cookie:x", "/a\u0000b",
    "/hub", "/hub/", "/hub/#/logs", "/hub?x=1"
  ]) {
    assert.equal(safeNext(`?next=${encodeURIComponent(bad)}`), null, bad)
  }
  assert.equal(safeNext("?next=%2F%250d%250a"), "/%0d%0a", "literal percent-text is just a same-origin path, not a header split")
  assert.equal(safeNext(""), null)
  assert.equal(safeNext("?other=1"), null)
  assert.equal(safeNext(undefined), null)
})

const session = (over) => ({ machineId: "m1", machineName: "Studio", agentId: "claude", id: "s", directory: "/work/repo", activity: "idle", startedAt: "2026-09-29T08:00:00Z", lastRanAt: "2026-09-29T09:00:00Z", ...over })

test("every activity has a label and a colour the stylesheet defines", () => {
  const known = ["ok", "warn", "bad", "busy", "attention", "off", "pending", "idle", "unknown"]
  for (const activity of ACTIVITY_ORDER) {
    assert.ok(ACTIVITY_LABELS[activity], activity)
    assert.ok(known.includes(activityTone(activity)), `${activity} -> ${activityTone(activity)}`)
  }
  assert.equal(activityLabel("needs_input"), "Needs you")
  assert.equal(activityLabel("nonsense"), "Unknown")
  assert.equal(activityTone("completed"), "ok")
  assert.equal(activityTone("failed"), "bad")
  assert.equal(activityTone("working"), "busy")
})

test("no grouping is one recent feed, newest run first, undated last", () => {
  const groups = groupSessions([
    session({ id: "old", lastRanAt: "2026-09-29T01:00:00Z" }),
    session({ id: "new", lastRanAt: "2026-09-29T11:00:00Z" }),
    session({ id: "undated", lastRanAt: null, startedAt: null })
  ], "none")
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].sessions.map((entry) => entry.id), ["new", "old", "undated"])
  assert.deepEqual(groupSessions([], "none"), [])
})

test("grouping by status puts what needs a look first", () => {
  const groups = groupSessions(["completed", "working", "failed", "needs_input", "stopped", "idle", "gone"].map((activity) => session({ id: activity, activity })), "status")
  assert.deepEqual(groups.map((group) => group.key), ["needs_input", "working", "failed", "completed", "stopped", "idle", "gone"])
  assert.equal(groups[0].label, "Needs you")
})

test("grouping by machine, agent or project orders groups by their newest run and never mixes machines' same-named folders", () => {
  const items = [
    session({ id: "a", machineId: "m1", machineName: "Studio", lastRanAt: "2026-09-29T05:00:00Z" }),
    session({ id: "b", machineId: "m2", machineName: "Laptop", lastRanAt: "2026-09-29T10:00:00Z" }),
    session({ id: "c", machineId: "m1", machineName: "Studio", lastRanAt: "2026-09-29T06:00:00Z" })
  ]
  assert.deepEqual(groupSessions(items, "machine").map((group) => [group.label, group.sessions.length]), [["Laptop", 1], ["Studio", 2]])
  assert.deepEqual(groupSessions(items, "project").map((group) => group.label), ["repo", "repo"], "the same folder name on two machines is two groups")
  assert.equal(groupSessions(items, "project").length, 2)
  assert.deepEqual(groupSessions([session({ agentId: "codex" }), session({ agentId: "claude", lastRanAt: "2026-09-29T12:00:00Z" })], "agent").map((group) => group.label), ["claude", "codex"])
  assert.equal(groupSessions([session({ directory: "" })], "project")[0].label, "No folder")
  assert.equal(groupSessions([session({ directory: "C:\\work\\app" })], "project")[0].label, "app", "Windows paths too")
})

test("a group key that looks like an Object prototype property is still just a key", () => {
  const groups = groupSessions([session({ agentId: "__proto__" }), session({ agentId: "constructor" }), session({ agentId: "toString" })], "agent")
  assert.equal(groups.length, 3)
})

test("the search query carries only what was chosen", () => {
  assert.equal(sessionSearchParams({}).toString(), "limit=200")
  const params = sessionSearchParams({ q: "  parser ", activity: "failed", machine: "m1", agent: "claude", kind: "background", ranWithin: "24h", startedWithin: "7d", sort: "started", limit: 50 })
  assert.deepEqual(Object.fromEntries(params), { q: "parser", activity: "failed", machine: "m1", agent: "claude", kind: "background", ranAfter: "24h", startedAfter: "7d", sort: "started", limit: "50" })
  assert.equal(sessionSearchParams({ sort: "last_ran" }).has("sort"), false, "the default sort is not sent")
})
