import assert from "node:assert/strict"
import test from "node:test"

const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}

const {
  DESKTOP_LOCAL_MACHINE_ID,
  HUB_MACHINE_ID_PREFIX,
  WORKSPACE_MACHINES_STORAGE_KEY,
  isHubMachine,
  isRuntimeOwnedMachine,
  loadWorkspaceMachines,
  persistWorkspaceMachines
} = await import("./workspaceMachines.ts")

const remote = {
  id: "remote-machine",
  name: "Remote",
  config: {
    backend: "opencode",
    host: "192.168.1.50",
    port: 4097,
    username: "harness",
    password: "saved-secret"
  }
}
const local = {
  id: DESKTOP_LOCAL_MACHINE_ID,
  name: "This computer",
  config: {
    backend: "opencode",
    host: "127.0.0.1",
    port: 4123,
    username: "",
    password: ""
  }
}

test("desktop local runtime is never persisted with workspace machines", () => {
  storage.clear()
  persistWorkspaceMachines([local, remote])
  const raw = storage.get(WORKSPACE_MACHINES_STORAGE_KEY)
  assert.match(raw, /remote-machine/)
  assert.doesNotMatch(raw, /desktop-local-runtime/)
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})

test("a stale persisted runtime projection is discarded on load", () => {
  storage.set(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify([local, remote]))
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})

const hub = {
  id: `${HUB_MACHINE_ID_PREFIX}machine_from_hub`,
  name: "Studio Mac",
  config: { backend: "opencode", host: "https://hub.example.com", port: 443, username: "", password: "", basePath: "/m/machine_from_hub" }
}

test("runtime-owned means the desktop runtime or a hub machine, and nothing else", () => {
  assert.equal(isRuntimeOwnedMachine(local), true)
  assert.equal(isRuntimeOwnedMachine(hub), true)
  assert.equal(isRuntimeOwnedMachine(remote), false)
  assert.equal(isHubMachine(hub), true)
  assert.equal(isHubMachine(local), false)
})

test("hub machines are never persisted, whichever way they arrive", () => {
  storage.clear()
  persistWorkspaceMachines([local, hub, remote])
  const raw = storage.get(WORKSPACE_MACHINES_STORAGE_KEY)
  assert.doesNotMatch(raw, /machine_from_hub/)
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})

test("a hub-prefixed entry found in storage is discarded: storage cannot masquerade as the hub", () => {
  storage.set(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify([hub, remote, { ...remote, id: "hub:forged" }]))
  assert.deepEqual(loadWorkspaceMachines().map((machine) => machine.id), ["remote-machine"])
})
