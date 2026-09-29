import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The bootstrap script is what a new user runs first, so it is tested like code: in a scratch copy of the
// repository layout (it works relative to its own location), never touching a real .env.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const skip = process.platform === "win32" ? "POSIX shell script" : false

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hub-init-env-"))
  mkdirSync(path.join(dir, "deploy"))
  copyFileSync(path.join(repo, "deploy/init-env.sh"), path.join(dir, "deploy/init-env.sh"))
  copyFileSync(path.join(repo, ".env.example"), path.join(dir, ".env.example"))
  const run = (...args) => spawnSync("sh", ["deploy/init-env.sh", ...args], { cwd: dir, encoding: "utf8" })
  const env = () => Object.fromEntries(
    readFileSync(path.join(dir, ".env"), "utf8").split("\n").map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]])
  )
  return { dir, run, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("init-env.sh writes an owner-only .env with fresh secrets", { skip }, () => {
  const { dir, run, env, cleanup } = scratch()
  try {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    if (process.platform !== "win32") assert.equal(statSync(path.join(dir, ".env")).mode & 0o077, 0, ".env must not be group/world readable")
    const values = env()
    assert.match(values.POSTGRES_PASSWORD, /^[A-Za-z0-9]{32}$/)
    assert.match(values.HUB_ADMIN_PASSWORD, /^[A-Za-z0-9]{20}$/)
    assert.match(values.HUB_SECRET_KEY, /^[A-Za-z0-9]{48}$/)
    assert.match(values.HUB_ENROLLMENT_TOKEN, /^hre_[A-Za-z0-9]{40}$/)
    assert.equal(values.HUB_TRUST_PROXY, "0")
    assert.equal(values.COMPOSE_PROFILES, undefined, "plain HTTP mode must not switch Caddy on")
    // The secrets are shown once so the user can sign in; they match what was written.
    assert.ok(result.stdout.includes(values.HUB_ADMIN_PASSWORD) && result.stdout.includes(values.HUB_ENROLLMENT_TOKEN))
    assert.match(result.stdout, /--hub http:\/\/localhost:8080/)
  } finally {
    cleanup()
  }
})

test("init-env.sh generates different secrets each time", { skip }, () => {
  const first = scratch()
  const second = scratch()
  try {
    first.run()
    second.run()
    assert.notEqual(first.env().HUB_SECRET_KEY, second.env().HUB_SECRET_KEY)
    assert.notEqual(first.env().POSTGRES_PASSWORD, second.env().POSTGRES_PASSWORD)
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

test("init-env.sh never overwrites a .env that is already in use", { skip }, () => {
  const { run, env, cleanup } = scratch()
  try {
    run()
    const before = env()
    const again = run()
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already exists/)
    assert.deepEqual(env(), before)
  } finally {
    cleanup()
  }
})

test("init-env.sh --domain turns on HTTPS consistently", { skip }, () => {
  const { run, env, cleanup } = scratch()
  try {
    const result = run("--domain", "hub.example.com")
    assert.equal(result.status, 0, result.stderr)
    const values = env()
    // These four only make sense together: Caddy, its name, the public address and trust in its headers.
    assert.equal(values.COMPOSE_PROFILES, "tls")
    assert.equal(values.HUB_DOMAIN, "hub.example.com")
    assert.equal(values.HUB_PUBLIC_URL, "https://hub.example.com")
    assert.equal(values.HUB_TRUST_PROXY, "1")
    assert.match(result.stdout, /--hub https:\/\/hub\.example\.com/)
  } finally {
    cleanup()
  }
})

test("init-env.sh --domain refuses anything that is not a bare DNS name", { skip }, () => {
  for (const bad of ["", "-x", "a/b", "https://hub.example.com", ".example.com", "example.com.", "hub example.com", "hub;rm.example.com"]) {
    const { dir, run, cleanup } = scratch()
    try {
      const result = run("--domain", bad)
      assert.equal(result.status, 2, `${JSON.stringify(bad)} should be refused`)
      assert.ok(!existsSync(path.join(dir, ".env")), "a refused domain must not leave a half-written .env")
    } finally {
      cleanup()
    }
  }
})

test("init-env.sh rejects unknown options and a missing --domain value", { skip }, () => {
  const { run, cleanup } = scratch()
  try {
    assert.equal(run("--bogus").status, 2)
    assert.equal(run("--domain").status, 2)
  } finally {
    cleanup()
  }
})

test(".env.example lists every variable the compose file reads", () => {
  const compose = readFileSync(path.join(repo, "docker-compose.yml"), "utf8")
  const example = readFileSync(path.join(repo, ".env.example"), "utf8")
  const used = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:?}-]/g)].map((match) => match[1]))
  assert.ok(used.size >= 8, `expected to find the compose variables, found ${[...used].join(",")}`)
  for (const name of used) {
    assert.match(example, new RegExp(`^#?\\s*${name}=`, "m"), `${name} is used by docker-compose.yml but not documented in .env.example`)
  }
})
