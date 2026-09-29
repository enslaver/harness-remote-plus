import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTestDatabase, skipDatabase, startHub, testConfig } from "./helpers.js"

let db
let hub
let unbuilt
before(async () => {
  if (skipDatabase) return
  db = await createTestDatabase()
  hub = await startHub({ ...db })
  unbuilt = await startHub({ ...db, config: testConfig({ HUB_WEB_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), "does-not-exist") }) })
})
after(async () => {
  await hub?.close()
  await unbuilt?.close()
  await db?.drop()
})

test("/ serves the web app and /hub/ serves the console", { skip: skipDatabase }, async () => {
  const app = await hub.request("/")
  assert.equal(app.status, 200)
  assert.match(app.text, /fixture app/)
  assert.equal(app.headers.get("content-security-policy"), "frame-ancestors 'none'")

  const consolePage = await hub.request("/hub/")
  assert.equal(consolePage.status, 200)
  assert.match(consolePage.text, /Harness Remote Hub/)
  assert.match(consolePage.text, /viewport-fit=cover/, "the console must opt in to the safe-area insets")
})

test("the console is served under a strict CSP with no inline script or style", { skip: skipDatabase }, async () => {
  const page = await hub.request("/hub/")
  const csp = page.headers.get("content-security-policy")
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)[^>]*>/i, "no inline <script> that the CSP would block")
  assert.doesNotMatch(page.text, /<style/i)
  assert.doesNotMatch(page.text, /\sstyle=/i)
  assert.equal((await hub.request("/hub/app.js")).status, 200)
  assert.equal((await hub.request("/hub/hub.css")).status, 200)
  assert.equal((await hub.request("/hub/util.js")).headers.get("content-type"), "text/javascript; charset=utf-8")
})

test("/hub redirects to /hub/ so relative URLs resolve", { skip: skipDatabase }, async () => {
  const response = await hub.request("/hub")
  assert.equal(response.status, 301)
  assert.equal(response.headers.get("location"), "/hub/")
})

test("client-side routes fall back to the app shell; unknown API paths stay JSON 404s", { skip: skipDatabase }, async () => {
  assert.match((await hub.request("/some/client/route")).text, /fixture app/)
  const api = await hub.request("/api/v1/does-not-exist")
  assert.equal(api.status, 404)
  assert.equal(api.json.error, "not_found")
  assert.equal((await hub.request("/api")).status, 404)
  assert.equal((await hub.request("/assets/missing-123.js")).status, 404)
})

test("internal routes are not shadowed by static files", { skip: skipDatabase }, async () => {
  assert.deepEqual((await hub.request("/healthz")).json, { ok: true })
  assert.equal((await hub.request("/readyz")).status, 200)
})

test("static files cannot be written or posted to", { skip: skipDatabase }, async () => {
  assert.equal((await hub.request("/", { method: "POST", json: {} })).status, 405)
  assert.equal((await hub.request("/hub/app.js", { method: "DELETE" })).status, 405)
})

test("request targets that are not paths are refused", { skip: skipDatabase }, async () => {
  const net = await import("node:net")
  const port = new URL(hub.base).port
  const send = (line) => new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`))
    let data = ""
    socket.on("data", (chunk) => { data += chunk })
    socket.on("close", () => resolve(data.split("\r\n")[0]))
  })
  assert.match(await send("GET http://evil.example/ HTTP/1.1"), / 400 /)
  assert.match(await send("GET //evil.example/x HTTP/1.1"), / (200|404) /, "a leading // is a path, never a host")
})

test("without a built web client, / explains what to do instead of failing", { skip: skipDatabase }, async () => {
  const page = await unbuilt.request("/")
  assert.equal(page.status, 200)
  assert.match(page.text, /Web app not built/)
  assert.match(page.text, /href="\/hub\/"/)
})

test("bootstrap tells the console what to put in the install command", { skip: skipDatabase }, async () => {
  await hub.login()
  const boot = (await hub.request("/api/v1/bootstrap")).json
  assert.equal(boot.installCommand, "npx --yes github:enslaver/harness-remote-plus")
})
