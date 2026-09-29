import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { createStaticServer, parseRange } from "../src/static.js"

let dir
let outside
let server
let base
const big = "console.log('x');\n".repeat(200)

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hub-static-"))
  outside = await mkdtemp(path.join(os.tmpdir(), "hub-outside-"))
  await mkdir(path.join(dir, "assets"))
  await mkdir(path.join(dir, "hub"))
  await mkdir(path.join(dir, "audio"))
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>app</title>")
  await writeFile(path.join(dir, "sw.js"), "// worker")
  await writeFile(path.join(dir, "manifest.webmanifest"), "{}")
  await writeFile(path.join(dir, "assets", "app-abc123.js"), big)
  await writeFile(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(path.join(dir, "hub", "index.html"), "<!doctype html><title>hub</title>")
  await writeFile(path.join(dir, "audio", "beep.aac"), Buffer.from("0123456789abcdefghij"))
  await writeFile(path.join(dir, ".secret"), "top secret")
  await writeFile(path.join(outside, "leak.txt"), "outside the root")
  await symlink(path.join(outside, "leak.txt"), path.join(dir, "link.txt"))

  const serve = createStaticServer({ root: dir, spa: true, headers: { "X-Test": "1" } })
  server = http.createServer(async (req, res) => {
    const url = new URL(`http://x${req.url}`)
    await serve(req, res, url.pathname)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

// fetch() normalises `..` away, which would hide the very requests we need to send.
function raw(target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base + target, { method, headers, agent: false }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.on("error", reject)
    request.end()
  })
}
const rawPath = (target, options) => new Promise((resolve, reject) => {
  const request = http.request({ host: "127.0.0.1", port: server.address().port, path: target, method: "GET", ...options }, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
  })
  request.on("error", reject)
  request.end()
})

test("serves index.html for / and applies base + extra headers", async () => {
  const response = await raw("/")
  assert.equal(response.status, 200)
  assert.match(response.body.toString(), /<title>app<\/title>/)
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8")
  assert.equal(response.headers["x-content-type-options"], "nosniff")
  assert.equal(response.headers["x-test"], "1")
})

test("cache policy: shell revalidates, fingerprinted assets are immutable, the rest is short-lived", async () => {
  assert.equal((await raw("/index.html")).headers["cache-control"], "no-cache")
  assert.equal((await raw("/sw.js")).headers["cache-control"], "no-cache", "a cached service worker strands users on an old app")
  assert.equal((await raw("/manifest.webmanifest")).headers["cache-control"], "no-cache")
  assert.equal((await raw("/hub/")).headers["cache-control"], "no-cache")
  assert.equal((await raw("/assets/app-abc123.js")).headers["cache-control"], "public, max-age=31536000, immutable")
  assert.equal((await raw("/icon.png")).headers["cache-control"], "public, max-age=3600")
})

test("conditional requests get 304 via ETag", async () => {
  const first = await raw("/icon.png")
  const second = await raw("/icon.png", { headers: { "If-None-Match": first.headers.etag } })
  assert.equal(second.status, 304)
  assert.equal(second.body.length, 0)
})

test("SPA fallback serves index.html for client routes but 404s a missing file", async () => {
  const route = await raw("/some/deep/link")
  assert.equal(route.status, 200)
  assert.match(route.body.toString(), /<title>app<\/title>/)
  const missing = await raw("/assets/gone-123.js")
  assert.equal(missing.status, 404)
  assert.doesNotMatch(missing.body.toString(), /<title>/, "a missing script must not be answered with HTML")
})

test("directories redirect to a trailing slash and serve their index", async () => {
  const redirect = await raw("/hub")
  assert.equal(redirect.status, 301)
  assert.equal(redirect.headers.location, "/hub/")
  assert.match((await raw("/hub/")).body.toString(), /<title>hub<\/title>/)
})

test("cannot escape the root: traversal, encoded traversal, backslashes, NUL, dotfiles, symlinks", async () => {
  for (const target of [
    "/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%5c%2e%2e%5cwindows",
    "/assets/../../etc/passwd", "/%00", "/.secret", "/hub/../.secret", "/link.txt", "/%252e%252e/x"
  ]) {
    const response = await rawPath(target)
    assert.ok(![200, 206].includes(response.status) || !/top secret|outside the root|root:/.test(response.body), `${target} leaked (${response.status})`)
  }
  // Extensionless paths that match no file get the SPA shell (by design), so assert on *content*: what
  // matters is that the protected bytes are never served, not which harmless status carried the shell.
  for (const [target, secret] of [["/.secret", "top secret"], ["/%2e%2e/%2e%2e/etc/passwd", "root:"], ["/hub/../.secret", "top secret"]]) {
    const response = await rawPath(target)
    assert.ok(!response.body.includes(secret), `${target} served protected content`)
    assert.ok(response.status === 404 || /<title>app<\/title>/.test(response.body), `${target} should be the shell or a 404`)
  }
  assert.equal((await rawPath("/link.txt")).status, 404, "a symlink pointing outside the root is not served")
  assert.ok((await rawPath("/assets/%ZZ")).status < 500, "malformed escapes are not a server error")
})

test("compresses large text when asked, never small or binary files", async () => {
  const gz = await raw("/assets/app-abc123.js", { headers: { "Accept-Encoding": "gzip" } })
  assert.equal(gz.headers["content-encoding"], "gzip")
  assert.equal(gunzipSync(gz.body).toString(), big)
  assert.ok(gz.body.length < big.length / 4)
  assert.equal(gz.headers.vary, "Accept-Encoding")
  assert.equal((await raw("/assets/app-abc123.js")).headers["content-encoding"], undefined)
  assert.equal((await raw("/sw.js", { headers: { "Accept-Encoding": "gzip" } })).headers["content-encoding"], undefined, "too small to be worth it")
  assert.equal((await raw("/icon.png", { headers: { "Accept-Encoding": "gzip" } })).headers["content-encoding"], undefined)
})

test("byte ranges: 206 for media (Safari will not play audio without them), 416 when unsatisfiable", async () => {
  const head = await raw("/audio/beep.aac", { method: "HEAD" })
  assert.equal(head.headers["accept-ranges"], "bytes")
  assert.equal(head.headers["content-type"], "audio/aac")

  const first = await raw("/audio/beep.aac", { headers: { Range: "bytes=0-1" } })
  assert.equal(first.status, 206)
  assert.equal(first.headers["content-range"], "bytes 0-1/20")
  assert.equal(first.body.toString(), "01")

  const open = await raw("/audio/beep.aac", { headers: { Range: "bytes=15-" } })
  assert.equal(open.body.toString(), "fghij")
  const suffix = await raw("/audio/beep.aac", { headers: { Range: "bytes=-3" } })
  assert.equal(suffix.body.toString(), "hij")
  const clamped = await raw("/audio/beep.aac", { headers: { Range: "bytes=10-999" } })
  assert.equal(clamped.headers["content-range"], "bytes 10-19/20")

  const bad = await raw("/audio/beep.aac", { headers: { Range: "bytes=50-60" } })
  assert.equal(bad.status, 416)
  assert.equal(bad.headers["content-range"], "bytes */20")
  assert.equal((await raw("/audio/beep.aac", { headers: { Range: "items=0-1" } })).status, 200, "unknown units are ignored")
})

test("parseRange edge cases", () => {
  assert.deepEqual(parseRange("bytes=0-0", 10), { start: 0, end: 0 })
  assert.deepEqual(parseRange("bytes=-100", 10), { start: 0, end: 9 })
  assert.deepEqual(parseRange("bytes=9-", 10), { start: 9, end: 9 })
  for (const unsatisfiable of ["bytes=10-", "bytes=5-2", "bytes=-0"]) assert.deepEqual(parseRange(unsatisfiable, 10), { unsatisfiable: true }, unsatisfiable)
  for (const ignored of ["bytes=-", "bytes=a-b", "bytes=0-1,4-5", "", undefined]) assert.equal(parseRange(ignored, 10), null, String(ignored))
})

test("only GET and HEAD are allowed", async () => {
  const response = await raw("/index.html", { method: "POST" })
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, "GET, HEAD")
})
