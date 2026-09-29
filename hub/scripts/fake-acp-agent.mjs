#!/usr/bin/env node
// A minimal ACP agent over stdio (newline-delimited JSON-RPC), for driving the REAL machine daemon in
// end-to-end tests without installing Codex/Claude/OMP. It implements only what the bridge uses to list
// and create Sessions and to answer a prompt. It says something on stderr at startup so the daemon's
// per-agent log prefix (`[omp] ...`) has something to ship.
//
//   node bridge/src/daemon-cli.js --backend omp --acp-command node --acp-arg hub/scripts/fake-acp-agent.mjs ...

import readline from "node:readline"

const sessions = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const reader = readline.createInterface({ input: process.stdin })
reader.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Notifications (no id) need no answer.
  if (message.id === undefined) return
  const { id, method, params = {} } = message
  const ok = (result) => send({ jsonrpc: "2.0", id, result })

  switch (method) {
    case "initialize":
      ok({
        protocolVersion: 1,
        agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
        // No auth methods: the client skips `authenticate`.
        authMethods: [],
        agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { list: {} } }
      })
      break
    case "session/new": {
      const sessionId = `fake-${sessions.size + 1}`
      sessions.set(sessionId, { cwd: params.cwd ?? process.cwd(), title: undefined, updatedAt: new Date().toISOString() })
      process.stderr.write(`created session ${sessionId}\n`)
      ok({ sessionId })
      break
    }
    case "session/list":
      ok({ sessions: [...sessions].map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt })) })
      break
    case "session/prompt":
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } })
      ok({ stopReason: "end_turn" })
      break
    default:
      ok({})
  }
})

process.stderr.write("ready to serve sessions\n")
