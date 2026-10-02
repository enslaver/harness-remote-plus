import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { clearHubToken, extractHubArgs, normalizeHubUrl, readHubState, resolveHubOptions, writeHubState } from "../src/hub-options.js"

test("extractHubArgs removes hub flags and leaves everything else in order", () => {
  const { flags, rest } = extractHubArgs([
    "--port", "4900", "--hub", "https://hub.example.com", "--root", "/dev", "--hub-token", "hre_abc",
    "--hub-name", "Desk", "--hub-advertise", "http://100.64.0.5:4097", "--hub-advertise", "http://desk:4097",
    "--hub-no-proxy", "--cors", "http://localhost:5173"
  ])
  assert.deepEqual(rest, ["--port", "4900", "--root", "/dev", "--cors", "http://localhost:5173"])
  assert.deepEqual(flags, {
    url: "https://hub.example.com", token: "hre_abc", name: "Desk", noProxy: true,
    advertise: ["http://100.64.0.5:4097", "http://desk:4097"], advertiseHosts: []
  })
})

test("--hub-advertise-name and --hub-advertise-host are parsed; --hub-name stays an alias", () => {
  const { flags, rest } = extractHubArgs(["--hub", "https://h", "--hub-advertise-name", "jedi", "--hub-advertise-host", "jedi.ts.net"])
  assert.deepEqual(rest, [])
  assert.equal(flags.name, "jedi")
  assert.deepEqual(flags.advertiseHosts, ["jedi.ts.net"])
})

test("extractHubArgs handles --no-hub and no hub flags at all", () => {
  assert.equal(extractHubArgs(["--no-hub"]).flags.disabled, true)
  const plain = extractHubArgs(["--port", "1"])
  assert.deepEqual(plain.rest, ["--port", "1"])
  assert.deepEqual(plain.flags, { advertise: [], advertiseHosts: [] })
})

test("a hub flag missing its value fails loudly instead of eating the next option", () => {
  assert.throws(() => extractHubArgs(["--hub"]), /--hub requires a value/)
  assert.throws(() => extractHubArgs(["--hub-token", "--port", "4097"]), /--hub-token requires a value/)
})

test("normalizeHubUrl keeps origin and path, drops trailing slashes, refuses credentials and other schemes", () => {
  assert.equal(normalizeHubUrl("https://hub.example.com/"), "https://hub.example.com")
  assert.equal(normalizeHubUrl("http://192.168.1.10:8080"), "http://192.168.1.10:8080")
  assert.equal(normalizeHubUrl("https://example.com/hub//"), "https://example.com/hub")
  assert.throws(() => normalizeHubUrl("ftp://hub"), /http\(s\) URL/)
  assert.throws(() => normalizeHubUrl("hub.example.com"), /http\(s\) URL/)
  assert.throws(() => normalizeHubUrl("https://user:pass@hub.example.com"), /must not contain credentials/)
})

async function withState(work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hr-hub-opts-"))
  try {
    await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("nothing configured means no hub", async () => {
  await withState(async (dir) => {
    assert.equal(await resolveHubOptions({ flags: { advertise: [] }, environment: {}, stateDirectory: dir }), null)
  })
})

test("--no-hub wins over flags, environment and saved state", async () => {
  await withState(async (dir) => {
    await writeHubState(dir, { url: "https://hub.example.com", machineToken: "hrm_x" })
    const options = await resolveHubOptions({
      flags: { advertise: [], disabled: true, url: "https://other" }, environment: { HARNESS_REMOTE_HUB_URL: "https://env" }, stateDirectory: dir
    })
    assert.equal(options, null)
  })
})

test("precedence: flags over environment over saved state", async () => {
  await withState(async (dir) => {
    await writeHubState(dir, { url: "https://saved.example.com", machineToken: "hrm_saved" })
    const environment = { HARNESS_REMOTE_HUB_URL: "https://env.example.com", HARNESS_REMOTE_HUB_TOKEN: "hre_env", HARNESS_REMOTE_HUB_NAME: "EnvName" }

    const fromSaved = await resolveHubOptions({ flags: { advertise: [] }, environment: {}, stateDirectory: dir })
    assert.equal(fromSaved.url, "https://saved.example.com")
    assert.equal(fromSaved.machineToken, "hrm_saved", "a bare run reconnects with the saved machine token")

    const fromEnv = await resolveHubOptions({ flags: { advertise: [] }, environment, stateDirectory: dir })
    assert.equal(fromEnv.url, "https://env.example.com")
    assert.equal(fromEnv.enrollmentToken, "hre_env")
    assert.equal(fromEnv.name, "EnvName")
    assert.equal(fromEnv.machineToken, undefined, "a saved token belongs to the hub that issued it, not to this one")

    const fromFlags = await resolveHubOptions({ flags: { advertise: [], url: "https://flag.example.com", token: "hre_flag", name: "FlagName" }, environment, stateDirectory: dir })
    assert.equal(fromFlags.url, "https://flag.example.com")
    assert.equal(fromFlags.enrollmentToken, "hre_flag")
    assert.equal(fromFlags.name, "FlagName")
  })
})

test("advertise, no-proxy and interval come from flags or environment", async () => {
  await withState(async (dir) => {
    const options = await resolveHubOptions({
      flags: { advertise: [] },
      environment: { HARNESS_REMOTE_HUB_URL: "https://h", HARNESS_REMOTE_HUB_ADVERTISE: "http://a:1, http://b:2 ,", HARNESS_REMOTE_HUB_NO_PROXY: "1", HARNESS_REMOTE_HUB_INTERVAL_MS: "2500" },
      stateDirectory: dir
    })
    assert.deepEqual(options.advertise, ["http://a:1", "http://b:2"])
    assert.equal(options.noProxy, true)
    assert.equal(options.intervalMs, 2500)

    const flagged = await resolveHubOptions({ flags: { advertise: ["http://c:3"] }, environment: { HARNESS_REMOTE_HUB_URL: "https://h", HARNESS_REMOTE_HUB_ADVERTISE: "http://ignored:9", HARNESS_REMOTE_HUB_INTERVAL_MS: "10" }, stateDirectory: dir })
    assert.deepEqual(flagged.advertise, ["http://c:3"])
    assert.equal(flagged.intervalMs, undefined, "an interval under one second is ignored")
  })
})

test("a malformed hub URL is an error at startup, not a silent no-hub", async () => {
  await withState(async (dir) => {
    await assert.rejects(resolveHubOptions({ flags: { advertise: [], url: "not-a-url" }, environment: {}, stateDirectory: dir }), /http\(s\) URL/)
  })
})

test("hub state is written atomically, owner-only, and tolerates junk", async () => {
  await withState(async (dir) => {
    assert.equal(await readHubState(dir), null)
    await writeHubState(dir, { url: "https://h", machineId: "m", machineToken: "hrm_1", enrolledAt: "2026-01-01T00:00:00Z" })
    assert.equal((await readHubState(dir)).machineToken, "hrm_1")
    if (process.platform !== "win32") assert.equal((await stat(path.join(dir, "hub.json"))).mode & 0o777, 0o600, "holds a bearer credential")

    await clearHubToken(dir)
    const cleared = await readHubState(dir)
    assert.equal(cleared.machineToken, "")
    assert.equal(cleared.url, "https://h", "the hub address is kept so the next message can say which hub needs a token")
    assert.equal(JSON.parse(await readFile(path.join(dir, "hub.json"), "utf8")).url, "https://h")
    const resolved = await resolveHubOptions({ flags: { advertise: [] }, environment: {}, stateDirectory: dir })
    assert.equal(resolved.machineToken, undefined, "an emptied token counts as not enrolled")

    await writeFile(path.join(dir, "hub.json"), "{not json")
    assert.equal(await readHubState(dir), null)
    await writeFile(path.join(dir, "hub.json"), JSON.stringify({ url: 5 }))
    assert.equal(await readHubState(dir), null)
  })
})
