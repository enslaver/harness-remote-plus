#!/usr/bin/env node
// A stand-in for the parts of the `claude` CLI that manage background agents, driven by a JSON state file so
// tests can assert both what was run and how the "registry" changed.
//
//   FAKE_CLAUDE_STATE  path to { agents: [...], logs: { <id>: "text" }, rmRefuses: { <id>: "message" }, next: "abcd0001" }
//   FAKE_CLAUDE_CALLS  path to a file that gets one JSON line per invocation ({ argv, cwd, leakedSession })
//   FAKE_CLAUDE_OLD=1  behave like a Claude Code that predates `agents` (unknown command, exit 1)
//   FAKE_CLAUDE_SLOW=ms  wait before answering `agents`
import fs from "node:fs"

const argv = process.argv.slice(2)
// `node --test` runs every file under test/, this helper included; with no command there is nothing to do.
if (argv.length === 0) process.exit(0)
const statePath = process.env.FAKE_CLAUDE_STATE
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"))
const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state))
if (process.env.FAKE_CLAUDE_CALLS) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, `${JSON.stringify({ argv, cwd: process.cwd(), leakedSession: process.env.CLAUDE_CODE_SESSION_ID ?? null })}\n`)
}

const TERMINAL = new Set(["done", "failed", "stopped"])
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code) }
const [command, ...rest] = argv

if (command === "--version") {
  console.log("2.1.285 (Claude Code)")
} else if (command === "agents") {
  if (process.env.FAKE_CLAUDE_OLD === "1") fail("error: unknown command 'agents'")
  const emit = () => {
    const includeAll = rest.includes("--all")
    const entries = read().agents.filter((agent) => includeAll || agent.kind !== "background" || !TERMINAL.has(agent.state))
    console.log(JSON.stringify(entries, null, 2))
  }
  const delay = Number(process.env.FAKE_CLAUDE_SLOW) || 0
  if (delay) setTimeout(emit, delay)
  else emit()
} else if (command === "logs") {
  const state = read()
  const id = rest[0]
  if (!(id in (state.logs ?? {}))) fail(`No background session ${id}`)
  process.stdout.write(state.logs[id])
} else if (command === "stop") {
  const state = read()
  const agent = state.agents.find((candidate) => candidate.id === rest[0])
  if (!agent) fail(`No background session ${rest[0]}`)
  agent.state = "stopped"
  write(state)
  console.log(`Stopped ${rest[0]}`)
} else if (command === "rm") {
  const state = read()
  const id = rest[0]
  if (state.rmRefuses?.[id]) fail(state.rmRefuses[id])
  if (!state.agents.some((candidate) => candidate.id === id)) fail(`No background session ${id}`)
  state.agents = state.agents.filter((candidate) => candidate.id !== id)
  write(state)
  console.log(`Removed ${id}`)
} else if (command === "--bg") {
  const state = read()
  const separator = rest.indexOf("--")
  const options = separator === -1 ? rest : rest.slice(0, separator)
  const prompt = separator === -1 ? "" : rest.slice(separator + 1).join(" ")
  const option = (name) => { const index = options.indexOf(name); return index === -1 ? undefined : options[index + 1] }
  const resumed = option("--resume")
  if (resumed) {
    const agent = state.agents.find((candidate) => candidate.sessionId === resumed)
    if (!agent) fail(`No session ${resumed}`)
    agent.state = "running"
    write(state)
    console.log(`Continuing ${agent.id} in the background`)
  } else {
    const id = state.next ?? "abcd0001"
    state.agents.push({
      id, cwd: process.cwd(), kind: "background", startedAt: Date.now(), sessionId: `${id}-1111-2222-3333-444455556666`,
      name: option("--name") ?? prompt.slice(0, 40), state: "running"
    })
    state.started = { id, prompt, name: option("--name"), model: option("--model"), permissionMode: option("--permission-mode") }
    write(state)
    console.log(`Started background session ${id}. Attach with: claude attach ${id}`)
  }
} else {
  fail(`unrecognised: ${argv.join(" ")}`)
}
