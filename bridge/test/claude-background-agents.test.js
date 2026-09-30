import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  agentActivity,
  claudeInvocation,
  childEnvironment,
  commandNotFound,
  createBackgroundAgentService,
  normalizeAgent,
  parseAgentsJson,
  parseJobState,
  stripAnsi
} from "../src/claude-background-agents.js"
import { createBackgroundAgentServer } from "../src/background-agent-server.js"
import { allowedDirectory } from "../src/allowed-directory.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeClaude = path.join(here, "helpers", "fake-claude.mjs")

const SESSION = (short) => `${short}-1111-2222-3333-444455556666`
const background = (id, state, extra = {}) => ({ id, cwd: "/work/proj", kind: "background", startedAt: 1_790_000_000_000, sessionId: SESSION(id), name: `job ${id}`, state, ...extra })
const interactive = (pid, status, extra = {}) => ({ pid, cwd: "/work/term", kind: "interactive", startedAt: 1_790_000_100_000, sessionId: `aaaa${String(pid).padStart(4, "0")}-1111-2222-3333-444455556666`, name: "terminal", status, ...extra })

// ---- pure functions -----------------------------------------------------------------------------------

test("agentActivity: one vocabulary for every way an agent can be doing something", () => {
  const cases = [
    [{ state: "running" }, "working"],
    [{ state: "working" }, "working"],
    [{ status: "busy" }, "working"],
    [{ status: "shell" }, "working"],
    [{ tempo: "active" }, "working"],
    [{ state: "blocked" }, "needs_input"],
    [{ status: "waiting" }, "needs_input"],
    [{ tempo: "blocked", state: "running" }, "needs_input"],
    [{ needsYou: true, state: "running" }, "needs_input"],
    [{ needs: "Which database?", state: "running" }, "needs_input"],
    [{ status: "idle" }, "idle"],
    [{ tempo: "idle", state: "queued-for-nothing" }, "idle"],
    [{}, "idle"],
    [{ state: "done" }, "completed"],
    [{ state: "success" }, "completed"],
    [{ state: "failed" }, "failed"],
    [{ state: "error" }, "failed"],
    [{ state: "stopped" }, "stopped"],
    [{ state: "cancelled" }, "stopped"]
  ]
  for (const [input, expected] of cases) assert.equal(agentActivity(input), expected, JSON.stringify(input))
  // A finished agent whose state file still says "active" is finished, not working.
  assert.equal(agentActivity({ state: "done", tempo: "active", needsYou: true }), "completed")
  assert.equal(agentActivity({ state: "FAILED " }), "failed", "case and whitespace do not matter")
})

test("normalizeAgent shapes background and interactive entries, and ignores the CLI's own supervisor processes", () => {
  const bg = normalizeAgent(background("3a1b2c3d", "running"))
  assert.deepEqual([bg.key, bg.kind, bg.id, bg.sessionId, bg.activity, bg.directory, bg.name], [
    "background:3a1b2c3d", "background", "3a1b2c3d", SESSION("3a1b2c3d"), "working", "/work/proj", "job 3a1b2c3d"
  ])
  assert.equal(bg.startedAt, 1_790_000_000_000)
  assert.equal(bg.updatedAt, 1_790_000_000_000, "with no state file, last activity falls back to the start")

  const terminal = normalizeAgent(interactive(4242, "busy"))
  assert.deepEqual([terminal.kind, terminal.pid, terminal.activity, terminal.id], ["interactive", 4242, "working", undefined])

  assert.equal(normalizeAgent({ kind: "daemon", pid: 1 }), undefined)
  assert.equal(normalizeAgent({ kind: "daemon-worker", pid: 2 }), undefined)
  assert.equal(normalizeAgent({ kind: "background", id: "not-hex!", sessionId: "junk" }), undefined, "an id that is not 8 hex characters is never passed to the CLI")
  assert.equal(normalizeAgent(null), undefined)
  assert.equal(normalizeAgent("string"), undefined)
  assert.equal(normalizeAgent(background("3a1b2c3d", "running", { name: "" })).name, "Agent 3a1b2c3d", "a nameless agent still gets a label")
  assert.equal(normalizeAgent({ ...background("3a1b2c3d", "running"), id: undefined }).id, "3a1b2c3d", "the short id is derived from the session id when the CLI omits it")
})

test("what may be done to an agent follows from what it is doing", () => {
  const caps = (state, extra) => normalizeAgent(background("3a1b2c3d", state, extra)).capabilities
  assert.deepEqual(caps("running"), { open: true, prompt: false, logs: true, stop: true, resume: false, remove: false })
  assert.deepEqual(caps("blocked"), { open: true, prompt: false, logs: true, stop: true, resume: false, remove: false })
  for (const finished of ["done", "failed", "stopped"]) {
    assert.deepEqual(caps(finished), { open: true, prompt: true, logs: true, stop: false, resume: true, remove: true }, finished)
  }
  // A terminal session belongs to someone else's terminal: look, never touch.
  assert.deepEqual(normalizeAgent(interactive(9, "busy")).capabilities, { open: true, prompt: false, logs: false, stop: false, resume: false, remove: false })
  assert.equal(normalizeAgent({ ...background("3a1b2c3d", "done"), sessionId: undefined }).capabilities.open, false)
})

test("parseJobState keeps the safe, useful subset and summarises sub-agents", () => {
  const job = parseJobState(JSON.stringify({
    state: "blocked", tempo: "blocked", detail: "Waiting for an answer", needs: "Which database?", needs_you: true, intent: "Pick a DB",
    createdAt: "2026-09-29T20:00:00.000Z", updatedAt: "2026-09-29T20:05:00.000Z", worktreePath: "/wt/x", worktreeBranch: "agent/x",
    initialPrompt: "SECRET PROMPT TEXT", providerEnv: { ANTHROPIC_API_KEY: "sk-live" },
    fan: [{ kind: "agent", label: "a", startedAt: 1 }, { kind: "agent", label: "b", startedAt: 1, doneAt: 2 }, { kind: "agent", label: "c", failed: true }, { kind: "shell", label: "npm test" }]
  }))
  assert.equal(job.needsYou, true)
  assert.equal(job.worktreeBranch, "agent/x")
  assert.deepEqual(job.subagents, { total: 3, running: 1, failed: 1 })
  assert.ok(!JSON.stringify(job).includes("SECRET PROMPT TEXT") && !JSON.stringify(job).includes("sk-live"), "prompts and environment never leave the state file")
  assert.equal(parseJobState("not json"), undefined)
  assert.equal(parseJobState("[]"), undefined)
  assert.equal(parseJobState(JSON.stringify({ state: "running", tempo: "sideways" })).tempo, undefined)
})

test("parseAgentsJson accepts the CLI's array and tolerates an envelope, but never guesses", () => {
  assert.deepEqual(parseAgentsJson("[]"), [])
  assert.equal(parseAgentsJson(JSON.stringify({ agents: [{ a: 1 }] })).length, 1)
  assert.throws(() => parseAgentsJson("Welcome to Claude!"), /did not print JSON/)
  assert.throws(() => parseAgentsJson('{"ok":true}'), /did not print a list/)
})

test("child processes never inherit the identity of the Claude session that launched the daemon", () => {
  const cleaned = childEnvironment({
    PATH: "/usr/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "sk-keep", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
    CLAUDE_CODE_SESSION_ID: "parent-session", CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDE_PID: "103", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "remote_desktop", CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/x", CLAUDE_CODE_CHILD_SESSION: "1"
  })
  assert.deepEqual(Object.keys(cleaned).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH"])
})

test("stripAnsi removes colour, cursor and hyperlink sequences and turns bare CR into a newline", () => {
  assert.equal(stripAnsi("\u001B[31mred\u001B[0m \u001B[2K\u001B[1Gdone"), "red done")
  assert.equal(stripAnsi("\u001B]8;;https://x.example\u0007link\u001B]8;;\u0007"), "link")
  assert.equal(stripAnsi("a\rb\r\nc"), "a\nb\r\nc")
})

test("on Windows a .cmd shim can never carry free text, but a native claude.exe can", () => {
  const prompt = "fix it & then run calc.exe %PATH% > out"
  assert.throws(() => claudeInvocation("claude.cmd", ["--bg", "--", prompt], { platform: "win32" }), (error) => error.code === "unsafe_command" && error.status === 409)
  assert.deepEqual(claudeInvocation("claude.cmd", ["agents", "--json"], { platform: "win32", environment: { ComSpec: "cmd.exe" } }), { command: "cmd.exe", args: ["/d", "/s", "/c", "claude.cmd", "agents", "--json"] })
  assert.deepEqual(claudeInvocation("C:\\bin\\claude.exe", ["--bg", "--", prompt], { platform: "win32" }), { command: "C:\\bin\\claude.exe", args: ["--bg", "--", prompt] })
  assert.deepEqual(claudeInvocation("claude", ["--bg", "--", prompt], { platform: "linux" }), { command: "claude", args: ["--bg", "--", prompt] })
})

// ---- the service, against a fake CLI ------------------------------------------------------------------

async function fixture({ agents = [], logs = {}, rmRefuses = {}, jobs = {}, env = {}, roots } = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "hr-bg-")))
  const work = path.join(dir, "work")
  await mkdir(work, { recursive: true })
  const statePath = path.join(dir, "state.json")
  const callsPath = path.join(dir, "calls.jsonl")
  const configDirectory = path.join(dir, "claude-config")
  await writeFile(statePath, JSON.stringify({ agents: typeof agents === "function" ? agents(work) : agents, logs, rmRefuses }))
  await writeFile(callsPath, "")
  for (const [id, job] of Object.entries(jobs)) {
    await mkdir(path.join(configDirectory, "jobs", id), { recursive: true })
    await writeFile(path.join(configDirectory, "jobs", id, "state.json"), JSON.stringify(job))
  }
  const environment = { PATH: process.env.PATH, FAKE_CLAUDE_STATE: statePath, FAKE_CLAUDE_CALLS: callsPath, CLAUDE_CODE_SESSION_ID: "parent-session-must-not-leak", ...env }
  // `node fake-claude.mjs` stands in for the `claude` executable.
  const run = (command, args, options) => import("../src/claude-background-agents.js").then(({ runCommand }) => runCommand(process.execPath, [fakeClaude, ...args], options))
  const service = createBackgroundAgentService({
    command: "claude",
    configDirectory,
    environment,
    run,
    isAllowedDirectory: (directory) => allowedDirectory(directory, { roots: roots ?? [work] })
  })
  return {
    dir, work, service, statePath, callsPath, environment,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    calls: async () => (await readFile(callsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

test("list returns normalised agents, newest activity first, enriched from each agent's own state file", async () => {
  const f = await fixture({
    agents: [background("aaaa0001", "running"), background("aaaa0002", "blocked"), background("aaaa0003", "done"), interactive(77, "idle")],
    jobs: {
      aaaa0001: { state: "running", tempo: "active", detail: "Editing parser.ts", template: "x", updatedAt: "2026-09-29T20:09:00.000Z" },
      aaaa0002: { state: "blocked", tempo: "blocked", needs: "Which database?", needs_you: true, updatedAt: "2026-09-29T20:05:00.000Z" },
      aaaa0003: { state: "done", detail: "Refactored the parser", lastTerminalAt: "2026-09-29T20:30:00.000Z", updatedAt: "2026-09-29T20:29:00.000Z" }
    }
  })
  try {
    const listed = await f.service.list({ all: true })
    assert.equal(listed.available, true)
    assert.deepEqual(listed.agents.map((agent) => [agent.key, agent.activity]), [
      ["background:aaaa0003", "completed"],
      ["background:aaaa0001", "working"],
      ["background:aaaa0002", "needs_input"],
      ["interactive:aaaa0077-1111-2222-3333-444455556666", "idle"]
    ])
    const done = listed.agents[0]
    assert.equal(done.detail, "Refactored the parser")
    assert.equal(done.updatedAt, Date.parse("2026-09-29T20:30:00.000Z"), "the finish time is what 'last ran' means for a finished agent")
    assert.equal(listed.agents[2].needs, "Which database?")

    const active = await f.service.list({ all: false, force: true })
    assert.deepEqual(active.agents.map((agent) => agent.id ?? agent.pid), ["aaaa0001", "aaaa0002", 77], "without --all, finished agents are not listed")
    assert.ok((await f.calls()).some((call) => call.argv.join(" ") === "agents --json"))
  } finally {
    await f.cleanup()
  }
})

test("list is cached briefly and concurrent callers share one CLI invocation", async () => {
  const f = await fixture({ agents: [background("aaaa0001", "running")], env: { FAKE_CLAUDE_SLOW: "150" } })
  try {
    const [first, second, third] = await Promise.all([f.service.list(), f.service.list(), f.service.list()])
    assert.equal(first.agents.length, 1)
    assert.equal(first, second)
    assert.equal(second, third)
    await f.service.list()
    assert.equal((await f.calls()).filter((call) => call.argv[0] === "agents").length, 1, "one process for four callers")
    f.service.invalidate()
    await f.service.list()
    assert.equal((await f.calls()).filter((call) => call.argv[0] === "agents").length, 2)
  } finally {
    await f.cleanup()
  }
})

test("a machine without Claude Code, or with one that predates background agents, is 'unavailable', not an error", async () => {
  const missing = createBackgroundAgentService({ command: "definitely-not-a-real-claude-binary-xyz", configDirectory: os.tmpdir() })
  const listed = await missing.list()
  assert.deepEqual([listed.available, listed.reason, listed.agents], [false, "claude_not_found", []])
  await assert.rejects(() => missing.start({ prompt: "hi", directory: os.tmpdir() }), (error) => error.code === "claude_not_found" && error.status === 503)

  const f = await fixture({ env: { FAKE_CLAUDE_OLD: "1" } })
  try {
    const old = await f.service.list()
    assert.deepEqual([old.available, old.reason], [false, "unsupported_version"])
    await assert.rejects(() => f.service.start({ prompt: "hi", directory: f.work }), (error) => error.code === "background_unavailable" && error.status === 503)
  } finally {
    await f.cleanup()
  }
})

test("the CLI never sees the parent Claude session's identity", async () => {
  const f = await fixture({ agents: [background("aaaa0001", "running")] })
  try {
    await f.service.list()
    assert.ok((await f.calls()).every((call) => call.leakedSession === null), "CLAUDE_CODE_SESSION_ID must not be inherited")
  } finally {
    await f.cleanup()
  }
})

test("start runs `claude --bg` in an allowed directory with exactly the options given, and reports the new id", async () => {
  const f = await fixture()
  try {
    const started = await f.service.start({ prompt: "  Fix the flaky test  ", directory: f.work, name: "flaky", model: "opus[1m]", permissionMode: "acceptEdits" })
    assert.equal(started.id, "abcd0001")
    const call = (await f.calls()).find((candidate) => candidate.argv[0] === "--bg")
    assert.deepEqual(call.argv, ["--bg", "--name", "flaky", "--model", "opus[1m]", "--permission-mode", "acceptEdits", "--", "Fix the flaky test"])
    assert.equal(call.cwd, f.work)
    assert.equal((await f.state()).started.prompt, "Fix the flaky test")
    // The new agent shows up straight away: the cache was dropped.
    assert.ok((await f.service.list()).agents.some((agent) => agent.id === "abcd0001" && agent.activity === "working"))
  } finally {
    await f.cleanup()
  }
})

test("a prompt that looks like an option is still just a prompt", async () => {
  const f = await fixture()
  try {
    await f.service.start({ prompt: "--dangerously-skip-permissions", directory: f.work })
    const call = (await f.calls()).find((candidate) => candidate.argv[0] === "--bg")
    assert.deepEqual(call.argv, ["--bg", "--", "--dangerously-skip-permissions"], "everything after -- is data")
  } finally {
    await f.cleanup()
  }
})

test("start refuses what it must: no prompt, oversized prompt, unknown options, bypassPermissions, other directories", async () => {
  const f = await fixture()
  try {
    const refused = async (input, pattern) => {
      await assert.rejects(() => f.service.start({ directory: f.work, prompt: "ok", ...input }), (error) => error.status === 400 && pattern.test(error.message))
    }
    await refused({ prompt: "   " }, /prompt is required/)
    await refused({ prompt: "x".repeat(30_001) }, /at most 30000/)
    await refused({ permissionMode: "bypassPermissions" }, /Permission mode must be one of/)
    await refused({ permissionMode: "yolo" }, /Permission mode/)
    await refused({ model: "opus; rm -rf /" }, /model name is not valid/)
    await refused({ model: "-x" }, /model name is not valid/)
    await refused({ name: 5 }, /name is not valid/)
    await assert.rejects(() => f.service.start({ prompt: "ok" }), (error) => error.status === 400 && /directory is required/.test(error.message))
    await assert.rejects(() => f.service.start({ prompt: "ok", directory: os.tmpdir() }), (error) => error.status === 403 && error.code === "directory_not_allowed" && /outside the configured --root boundary/.test(error.message))
    await assert.rejects(() => f.service.start({ prompt: "ok", directory: path.join(f.work, "no-such-dir") }), (error) => error.status === 400 && /does not exist/.test(error.message))
    assert.equal((await f.calls()).filter((call) => call.argv[0] === "--bg").length, 0, "nothing reached the CLI")
  } finally {
    await f.cleanup()
  }
})

test("resume continues a FINISHED agent's session in the background, and refuses a live one", async () => {
  const f = await fixture({ agents: (work) => [background("aaaa0001", "running", { cwd: work }), background("aaaa0002", "done", { cwd: work })] })
  try {
    await assert.rejects(() => f.service.resume("aaaa0001", { prompt: "more" }), (error) => error.code === "agent_active" && error.status === 409)
    await assert.rejects(() => f.service.resume("aaaa0009", { prompt: "more" }), (error) => error.code === "unknown_agent" && error.status === 404)
    const resumed = await f.service.resume("aaaa0002", { prompt: "now add tests" })
    assert.equal(resumed.id, "aaaa0002")
    const call = (await f.calls()).find((candidate) => candidate.argv.includes("--resume"))
    assert.deepEqual(call.argv, ["--bg", "--resume", SESSION("aaaa0002"), "--", "now add tests"])
    assert.equal(call.cwd, f.work, "it continues in the directory the agent worked in")
    assert.equal((await f.state()).agents.find((agent) => agent.id === "aaaa0002").state, "running")
  } finally {
    await f.cleanup()
  }
})

test("stop only stops something running; remove only removes something finished, and never overrides the CLI's safety refusal", async () => {
  const f = await fixture({
    agents: [background("aaaa0001", "running"), background("aaaa0002", "done"), background("aaaa0003", "stopped")],
    rmRefuses: { aaaa0003: "Refusing to remove: the worktree has 2 unpushed commits. Re-run with --discard-unpushed abc123@wt-9 to discard them." }
  })
  try {
    await assert.rejects(() => f.service.remove("aaaa0001"), (error) => error.code === "agent_active" && error.status === 409, "a running agent must be stopped before it can be removed")
    assert.equal((await f.calls()).filter((call) => call.argv[0] === "rm").length, 0, "and nothing was sent to the CLI")
    await assert.rejects(() => f.service.stop("aaaa0002"), (error) => error.code === "agent_finished" && error.status === 409)
    assert.deepEqual(await f.service.stop("aaaa0001"), { id: "aaaa0001" })
    assert.equal((await f.state()).agents.find((agent) => agent.id === "aaaa0001").state, "stopped")

    await assert.rejects(() => f.service.remove("aaaa0009"), (error) => error.status === 404)
    assert.deepEqual(await f.service.remove("aaaa0002"), { id: "aaaa0002" })
    assert.ok(!(await f.state()).agents.some((agent) => agent.id === "aaaa0002"))

    await assert.rejects(() => f.service.remove("aaaa0003"), (error) => error.status === 409 && /unpushed commits/.test(error.message))
    const removeCalls = (await f.calls()).filter((call) => call.argv[0] === "rm")
    assert.ok(removeCalls.every((call) => call.argv.length === 2), "no --discard-unpushed / --force-remove-worktree is ever passed")
  } finally {
    await f.cleanup()
  }
})

test("ids are validated before anything is run", async () => {
  const f = await fixture()
  try {
    for (const bad of ["../etc", "aaaa000", "AAAA0001", "aaaa0001; rm", "--all", "", undefined]) {
      await assert.rejects(() => f.service.logs(bad), (error) => error.status === 400, String(bad))
      await assert.rejects(() => f.service.stop(bad), (error) => error.status === 400, String(bad))
      await assert.rejects(() => f.service.remove(bad), (error) => error.status === 400, String(bad))
    }
    assert.equal((await f.calls()).length, 0)
  } finally {
    await f.cleanup()
  }
})

test("logs returns the agent's recent output without terminal escapes, keeping the newest part", async () => {
  const long = `${"old line\n".repeat(20_000)}\u001B[32mthe newest line\u001B[0m\n`
  const f = await fixture({ agents: [background("aaaa0001", "running")], logs: { aaaa0001: "\u001B[1mhello\u001B[0m\nworld\n", aaaa0002: long } })
  try {
    assert.deepEqual(await f.service.logs("aaaa0001"), { id: "aaaa0001", text: "hello\nworld\n", truncated: false })
    const big = await f.service.logs("aaaa0002")
    assert.equal(big.truncated, true)
    assert.ok(big.text.length <= 64 * 1024)
    assert.ok(big.text.endsWith("the newest line\n"))
    await assert.rejects(() => f.service.logs("aaaa0009"), (error) => error.code === "claude_failed" && /No background session/.test(error.message))
  } finally {
    await f.cleanup()
  }
})

// ---- the HTTP surface ---------------------------------------------------------------------------------

async function serve(service, { username = "harness", password = "pw" } = {}) {
  const inner = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("inner") })
  const server = createBackgroundAgentServer({ innerServer: inner, config: { username, password, corsOrigins: [] }, service })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const call = async (pathname, { method = "GET", body, headers = {}, authorized = true } = {}) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { ...(authorized ? { Authorization: auth } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, headers: response.headers, text, json }
  }
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }) }
}

test("HTTP: routes, auth, methods and error mapping", async () => {
  const f = await fixture({ agents: (work) => [background("aaaa0001", "running", { cwd: work }), background("aaaa0002", "done", { cwd: work })], logs: { aaaa0001: "out\n" } })
  const api = await serve(f.service)
  try {
    assert.equal((await api.call("/v1/background-agents", { authorized: false })).status, 401)
    assert.equal((await api.call("/v1/background-agents/aaaa0001/stop", { method: "POST", authorized: false })).status, 401)
    assert.equal((await api.call("/somewhere/else")).text, "inner", "everything else goes to the next server, untouched")

    const listed = await api.call("/v1/background-agents")
    assert.equal(listed.status, 200)
    assert.equal(listed.json.available, true)
    assert.equal(listed.json.agents.length, 2)
    assert.equal((await api.call("/v1/background-agents?all=0")).json.agents.length, 1, "?all=0 lists only what is still active")
    assert.equal(listed.headers.get("cache-control"), "no-store")

    assert.equal((await api.call("/v1/background-agents/aaaa0001")).json.activity, "working")
    assert.equal((await api.call("/v1/background-agents/aaaa0009")).status, 404)
    assert.equal((await api.call("/v1/background-agents/aaaa0001/logs")).json.text, "out\n")

    const started = await api.call("/v1/background-agents", { method: "POST", body: { prompt: "do it", directory: f.work } })
    assert.equal(started.status, 201)
    assert.equal(started.json.id, "abcd0001")

    assert.equal((await api.call("/v1/background-agents/aaaa0002/stop", { method: "POST" })).status, 409, "already finished")
    assert.equal((await api.call("/v1/background-agents/aaaa0001/stop", { method: "POST" })).status, 200)
    assert.equal((await api.call("/v1/background-agents/aaaa0002", { method: "DELETE" })).status, 200)
    const resumed = await api.call("/v1/background-agents/aaaa0001/resume", { method: "POST", body: { prompt: "and more" } })
    assert.equal(resumed.status, 200, "stopped a moment ago, so it is finished and can be continued")

    assert.equal((await api.call("/v1/background-agents", { method: "POST", body: "{not json" })).status, 400)
    assert.equal((await api.call("/v1/background-agents", { method: "POST", body: [] })).status, 400)
    assert.equal((await api.call("/v1/background-agents", { method: "POST", body: { prompt: "x", directory: os.tmpdir() } })).status, 403, "a directory outside --root is refused")
    assert.equal((await api.call("/v1/background-agents/%E0%A4%A", {})).status, 400)
    assert.equal((await api.call("/v1/background-agents", { method: "PUT", body: {} })).status, 405)
    assert.equal((await api.call("/v1/background-agents/aaaa0001", { method: "POST", body: {} })).status, 405)
    assert.equal((await api.call("/v1/background-agents/aaaa0001/logs", { method: "POST", body: {} })).status, 405)
    assert.equal((await api.call("/v1/background-agents/aaaa0001/stop")).status, 405)
  } finally {
    await api.close()
    await f.cleanup()
  }
})

test("HTTP: a machine without Claude Code answers 200 with available:false, and mutations are 503", async () => {
  const service = createBackgroundAgentService({ command: "definitely-not-a-real-claude-binary-xyz", configDirectory: os.tmpdir() })
  const api = await serve(service)
  try {
    const listed = await api.call("/v1/background-agents")
    assert.equal(listed.status, 200)
    assert.deepEqual([listed.json.available, listed.json.reason], [false, "claude_not_found"])
    assert.equal((await api.call("/v1/background-agents", { method: "POST", body: { prompt: "x", directory: os.tmpdir() } })).status, 503)
  } finally {
    await api.close()
  }
})

// ---- against the real Claude CLI ------------------------------------------------------------------------

const realClaude = spawnSync("claude", ["--version"], { encoding: "utf8" })
const hasRealClaude = realClaude.status === 0 && /Claude Code/.test(realClaude.stdout)

test("against the real `claude agents --json`: job records on disk come out as the activities we claim", { skip: hasRealClaude ? false : "the claude CLI is not installed" }, async () => {
  // A private HOME with hand-written job records and NOTHING else: the CLI runs read-only, unauthenticated, and
  // cannot see or touch any real session. What is verified is the CLI's own JSON shape and state reconciliation.
  const home = await mkdtemp(path.join(os.tmpdir(), "hr-real-claude-"))
  const jobs = path.join(home, ".claude", "jobs")
  const job = async (short, state, extra = {}) => {
    await mkdir(path.join(jobs, short), { recursive: true })
    await writeFile(path.join(jobs, short, "state.json"), JSON.stringify({
      state, detail: `detail ${short}`, tempo: "idle", template: "general-purpose", intent: `intent ${short}`, sessionId: SESSION(short), cwd: `/tmp/proj-${short}`,
      createdAt: "2026-09-29T20:00:00.000Z", updatedAt: new Date().toISOString(), daemonShort: short, ...extra
    }))
  }
  try {
    await job("bbbb0001", "done", { lastTerminalAt: "2026-09-29T20:30:00.000Z" })
    await job("bbbb0002", "blocked", { tempo: "blocked", needs: "Which database?", needs_you: true })
    await job("bbbb0003", "stopped")
    await job("bbbb0004", "failed", { firstTerminalAt: "2026-09-29T20:10:00.000Z" })
    // "running" with no live worker behind it: the CLI itself reconciles that to failed, and so must we.
    await job("bbbb0005", "running", { tempo: "active" })

    const service = createBackgroundAgentService({ configDirectory: path.join(home, ".claude"), environment: { PATH: process.env.PATH, HOME: home } })
    const listed = await service.list({ all: true, force: true })
    assert.equal(listed.available, true, listed.message)
    const byId = Object.fromEntries(listed.agents.map((agent) => [agent.id, agent]))
    assert.equal(byId.bbbb0001.activity, "completed")
    assert.equal(byId.bbbb0002.activity, "needs_input")
    assert.equal(byId.bbbb0002.needs, "Which database?")
    assert.equal(byId.bbbb0003.activity, "stopped")
    assert.equal(byId.bbbb0004.activity, "failed")
    assert.equal(byId.bbbb0005.activity, "failed", "the CLI reports a running job with no worker as failed")
    assert.equal(byId.bbbb0001.directory, "/tmp/proj-bbbb0001")
    assert.equal(byId.bbbb0001.sessionId, SESSION("bbbb0001"))
    assert.equal(byId.bbbb0001.name, "intent bbbb0001")
    assert.equal(byId.bbbb0001.kind, "background")

    const active = await service.list({ all: false, force: true })
    assert.deepEqual(active.agents.map((agent) => agent.id), ["bbbb0002"], "without --all only the still-active agent is listed")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("a missing program is recognised however the platform reports it (ENOENT, or cmd.exe's own message)", async () => {
  assert.equal(commandNotFound({ error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) }), true)
  assert.equal(commandNotFound({ code: 1, stdout: "", stderr: "'claude' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n" }), true, "cmd.exe exits 1 with this text")
  assert.equal(commandNotFound({ code: 9009, stdout: "", stderr: "" }), true)
  // Not the same thing: a program that ran and failed, or timed out, is a failure, not "not installed".
  assert.equal(commandNotFound({ code: 1, stdout: "", stderr: "error: unknown command 'agents'" }), false)
  assert.equal(commandNotFound({ code: 0, stdout: "[]", stderr: "" }), false)
  assert.equal(commandNotFound({ code: 1, stdout: "", stderr: "the word 'recognized' alone is fine" }), false)
  assert.equal(commandNotFound({ error: Object.assign(new Error("boom"), { code: "EACCES" }) }), false)
  assert.equal(commandNotFound(undefined), false)

  // End to end through the service, with the run function answering as cmd.exe does: unavailable, and remembered.
  let runs = 0
  const service = createBackgroundAgentService({
    command: "claude",
    configDirectory: os.tmpdir(),
    run: async () => { runs += 1; return { code: 1, stdout: "", stderr: "'claude' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n" } }
  })
  const first = await service.list()
  assert.deepEqual([first.available, first.reason, first.agents], [false, "claude_not_found", []])
  await service.list({ all: false })
  await service.list()
  assert.equal(runs, 1, "the negative answer is remembered (a machine without Claude is not asked again for minutes)")
  await assert.rejects(() => service.start({ prompt: "hi", directory: os.tmpdir() }), (error) => error.code === "claude_not_found" && error.status === 503)
})
