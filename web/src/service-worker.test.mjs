import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")

/** Runs the real sw.js in a sandbox with a fake worker global and lets a test dispatch fetch events. */
function worker({ scope = "https://hub.example.com/", origin = "https://hub.example.com", network = async () => new Response("net", { headers: { "content-type": "text/plain" } }) } = {}) {
  const listeners = {}
  const cacheStore = new Map()
  const cacheNames = new Set(["harness-remote-v3", "unrelated"])
  const cache = {
    put: async (key, response) => { cacheStore.set(typeof key === "string" ? key : key.url, response) },
    addAll: async () => {}
  }
  const self = {
    registration: { scope },
    location: { origin },
    addEventListener: (type, listener) => { listeners[type] = listener },
    skipWaiting: () => {},
    clients: { claim: async () => {} }
  }
  const sandbox = {
    self,
    URL,
    Response,
    caches: {
      open: async () => cache,
      keys: async () => [...cacheNames],
      delete: async (name) => cacheNames.delete(name),
      match: async (key) => cacheStore.get(typeof key === "string" ? key : key.url)
    },
    fetch: (...args) => network(...args)
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  return {
    cacheStore,
    cacheNames,
    listeners,
    /** Returns null if the worker declined to handle it (the browser goes to the network by itself). */
    async fetchEvent(url, { method = "GET", mode = "cors" } = {}) {
      let handled = null
      const pending = []
      listeners.fetch({
        request: { url, method, mode },
        respondWith: (promise) => { handled = Promise.resolve(promise) },
        waitUntil: (promise) => pending.push(promise)
      })
      const response = handled ? await handled : null
      await Promise.all(pending)
      return response
    }
  }
}

test("this is the v4 cache and an old one is dropped on activate", async () => {
  const w = worker()
  assert.match(source, /const CACHE_NAME = "harness-remote-v4"/)
  await new Promise((resolve) => { w.listeners.activate({ waitUntil: (promise) => promise.then(resolve) }) })
  assert.deepEqual([...w.cacheNames], [], "nothing but the (not yet created) v4 cache is left")
  assert.equal(w.cacheNames.has("harness-remote-v3"), false)
  assert.equal(w.cacheNames.has("unrelated"), false, "only the current cache survives")
})

test("machine traffic proxied by a hub is never handled by the worker (no cache-first session data)", async () => {
  const w = worker()
  for (const path of [
    "/m/machine_abc/v1/machine", "/m/machine_abc/session", "/m/machine_abc/v1/agents/codex/global/event",
    "/api/v1/bootstrap", "/api/v1/machines", "/hub/", "/hub/app.js", "/hub"
  ]) {
    assert.equal(await w.fetchEvent(`https://hub.example.com${path}`), null, `${path} must bypass the worker`)
    assert.equal(w.cacheStore.size, 0, `${path} must not have been stored`)
  }
})

test("live routes bypass navigations too, so /hub/ is never replaced by the cached app shell", async () => {
  const w = worker()
  assert.equal(await w.fetchEvent("https://hub.example.com/hub/", { mode: "navigate" }), null)
  assert.equal(await w.fetchEvent("https://hub.example.com/m/machine_abc/", { mode: "navigate" }), null)
})

test("the prefixes are matched by path segment, not by string prefix", async () => {
  const w = worker()
  for (const path of ["/assets/m.js", "/manual.css", "/apiary.js", "/hubble.png", "/assets/api/x.js"]) {
    assert.notEqual(await w.fetchEvent(`https://hub.example.com${path}`), null, `${path} is an ordinary static file`)
  }
})

test("under a base path (GitHub Pages) the prefixes are relative to the scope", async () => {
  const w = worker({ scope: "https://user.github.io/harness-remote-plus/", origin: "https://user.github.io" })
  assert.equal(await w.fetchEvent("https://user.github.io/harness-remote-plus/m/machine_abc/v1/machine"), null)
  assert.equal(await w.fetchEvent("https://user.github.io/harness-remote-plus/api/v1/bootstrap"), null)
  assert.notEqual(await w.fetchEvent("https://user.github.io/harness-remote-plus/assets/app-1.js"), null)
})

test("ordinary static assets are still served cache-first-with-refresh and stored", async () => {
  const w = worker()
  const response = await w.fetchEvent("https://hub.example.com/assets/app-1.js")
  assert.equal(await response.text(), "net")
  assert.ok(w.cacheStore.has("https://hub.example.com/assets/app-1.js"))
})

test("a response that says no-store or private is not kept, even for a static-looking URL", async () => {
  for (const cacheControl of ["no-store", "private, max-age=0", "no-cache, no-store, must-revalidate"]) {
    const w = worker({ network: async () => new Response("secret", { headers: { "cache-control": cacheControl } }) })
    await w.fetchEvent("https://hub.example.com/assets/data.json")
    assert.equal(w.cacheStore.size, 0, cacheControl)
  }
  const ok = worker({ network: async () => new Response("fine", { headers: { "cache-control": "public, max-age=31536000, immutable" } }) })
  await ok.fetchEvent("https://hub.example.com/assets/app-2.js")
  assert.equal(ok.cacheStore.size, 1)
})

test("failed responses are not cached", async () => {
  const w = worker({ network: async () => new Response("nope", { status: 500 }) })
  await w.fetchEvent("https://hub.example.com/assets/broken.js")
  assert.equal(w.cacheStore.size, 0)
})

test("non-GET and cross-origin requests are left alone", async () => {
  const w = worker()
  assert.equal(await w.fetchEvent("https://hub.example.com/assets/app.js", { method: "POST" }), null)
  assert.equal(await w.fetchEvent("https://other.example.com/assets/app.js"), null)
})

test("the marketing landing page is still left to the browser", async () => {
  const w = worker()
  assert.equal(await w.fetchEvent("https://hub.example.com/v3/", { mode: "navigate" }), null)
})
