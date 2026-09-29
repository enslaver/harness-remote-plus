import assert from "node:assert/strict"
import test from "node:test"
import { sameMachineConnection } from "./machineConnection.ts"
import { liveSessionIndexStatus, noteSessionIndexLiveEvent } from "./session-index-live-state.ts"
import { baseUrl, machineBaseUrl } from "./serverConfig.ts"

// Two machines behind one hub share host and port. Only basePath tells them apart, so every place that
// decides "is this the same machine?" has to look at it, or one machine's state shows up on the other.
const hubA = { backend: "opencode", host: "https://hub.example.com", port: 443, username: "", password: "", basePath: "/m/machine_a" }
const hubB = { ...hubA, basePath: "/m/machine_b" }

test("machines that differ only by base path are different connections", () => {
  assert.equal(sameMachineConnection(hubA, hubB), false)
  assert.equal(sameMachineConnection(hubA, { ...hubA }), true)
  assert.equal(sameMachineConnection(hubA, { ...hubA, basePath: " /m/machine_a " }), true)
  assert.equal(sameMachineConnection({ ...hubA, basePath: undefined }, { ...hubA, basePath: "" }), true, "absent and empty are the same thing")
  assert.equal(sameMachineConnection(hubA, { ...hubA, basePath: undefined }), false, "a hub machine is not the hub root")
})

test("machines that differ only by base path have different URLs", () => {
  assert.notEqual(machineBaseUrl(hubA), machineBaseUrl(hubB))
  assert.notEqual(baseUrl({ ...hubA, agentId: "codex" }), baseUrl({ ...hubB, agentId: "codex" }))
})

test("a live session status on one hub machine is never shown on another", () => {
  const now = 1_000_000
  noteSessionIndexLiveEvent(hubA, { type: "session.status", sessionID: "ses_shared_id", status: "busy" }, now)
  assert.equal(liveSessionIndexStatus(hubA, "ses_shared_id", now + 1)?.type, "busy")
  assert.equal(liveSessionIndexStatus(hubB, "ses_shared_id", now + 1), undefined, "machine B must not inherit machine A's busy state")
})
