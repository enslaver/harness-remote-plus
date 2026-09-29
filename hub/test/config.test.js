import test from "node:test"
import assert from "node:assert/strict"
import { ConfigError, loadConfig } from "../src/config.js"

const valid = {
  HUB_DATABASE_URL: "postgres://hub:pw@db:5432/hub",
  HUB_ADMIN_PASSWORD: "a-long-enough-password",
  HUB_SECRET_KEY: "s".repeat(32)
}

test("loads a minimal valid environment with safe defaults", () => {
  const config = loadConfig(valid)
  assert.equal(config.port, 8080)
  assert.equal(config.host, "0.0.0.0")
  assert.equal(config.trustProxy, false)
  assert.equal(config.lokiUrl, undefined)
  assert.equal(config.probeIntervalMs, 30_000)
  assert.equal(Object.isFrozen(config), true)
})

test("reports every problem at once instead of one per restart", () => {
  assert.throws(
    () => loadConfig({ HUB_PORT: "nope" }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.problems.length >= 4, error.message)
      assert.match(error.message, /HUB_DATABASE_URL is required/)
      assert.match(error.message, /HUB_ADMIN_PASSWORD is required/)
      assert.match(error.message, /HUB_SECRET_KEY is required/)
      assert.match(error.message, /HUB_PORT must be an integer/)
      return true
    }
  )
})

test("rejects weak secrets", () => {
  assert.throws(() => loadConfig({ ...valid, HUB_ADMIN_PASSWORD: "short" }), /at least 12 characters/)
  assert.throws(() => loadConfig({ ...valid, HUB_SECRET_KEY: "tooshort" }), /at least 32 characters/)
  assert.throws(() => loadConfig({ ...valid, HUB_ENROLLMENT_TOKEN: "abc" }), /HUB_ENROLLMENT_TOKEN must be at least 16/)
})

test("reads secrets from *_FILE and strips only the trailing newline", () => {
  const files = { "/run/secrets/admin": "file-based-password\n", "/run/secrets/key": `${"k".repeat(40)}\r\n` }
  const config = loadConfig(
    { HUB_DATABASE_URL: valid.HUB_DATABASE_URL, HUB_ADMIN_PASSWORD_FILE: "/run/secrets/admin", HUB_SECRET_KEY_FILE: "/run/secrets/key" },
    { readFile: (file) => files[file] }
  )
  assert.equal(config.adminPassword, "file-based-password")
  assert.equal(config.secretKey, "k".repeat(40))
})

test("refuses a secret given both directly and by file, and reports unreadable files", () => {
  assert.throws(
    () => loadConfig({ ...valid, HUB_ADMIN_PASSWORD_FILE: "/x" }, { readFile: () => "whatever-password-123" }),
    /either HUB_ADMIN_PASSWORD or HUB_ADMIN_PASSWORD_FILE/
  )
  assert.throws(
    () => loadConfig({ ...valid, HUB_ADMIN_PASSWORD: undefined, HUB_ADMIN_PASSWORD_FILE: "/missing" }, { readFile: () => { throw new Error("ENOENT") } }),
    /HUB_ADMIN_PASSWORD_FILE could not be read: ENOENT/
  )
})

test("validates URLs and numeric ranges", () => {
  assert.throws(() => loadConfig({ ...valid, HUB_LOKI_URL: "ftp://loki" }), /HUB_LOKI_URL must be an http\(s\) URL/)
  assert.throws(() => loadConfig({ ...valid, HUB_PUBLIC_URL: "not a url" }), /HUB_PUBLIC_URL/)
  assert.throws(() => loadConfig({ ...valid, HUB_PROBE_INTERVAL_MS: "10" }), /HUB_PROBE_INTERVAL_MS/)
  const config = loadConfig({ ...valid, HUB_LOKI_URL: "http://loki:3100/", HUB_PUBLIC_URL: "https://hub.example.com/", HUB_TRUST_PROXY: "1" })
  assert.equal(config.lokiUrl, "http://loki:3100")
  assert.equal(config.publicUrl, "https://hub.example.com")
  assert.equal(config.trustProxy, true)
})
