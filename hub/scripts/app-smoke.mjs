#!/usr/bin/env node
// The whole product path, in a browser with an iPhone profile:
//
//   real hub  --serves-->  the real built web app (web/dist)
//   phone opens /  ->  not signed in  ->  redirected to the hub console  ->  signs in  ->  back in the app
//   the app gets its machines from the hub and talks to them THROUGH the hub's proxy (cookie only:
//   no gateway credentials in the page), with a fake machine gateway behind it
//
// plus the iPhone-specific behaviour: input sizes, keyboard handling, service-worker caching.
// Emulation, NOT Safari: Chromium's engine with Apple's viewport, touch and user agent. The keyboard is
// simulated by driving a fake `visualViewport`, which proves the app's logic and CSS wiring, not iOS's.
//
//   (cd ../web && npm run build)
//   HUB_TEST_DATABASE_URL=postgres://... node scripts/app-smoke.mjs

import http from "node:http"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, devices } from "playwright"
import { ADMIN_PASSWORD, ENROLLMENT_TOKEN, createTestDatabase, machinePayload, startHub, testConfig } from "../test/helpers.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const artifacts = path.join(here, "..", "browser-artifacts")
await mkdir(artifacts, { recursive: true })
const webDist = path.join(here, "..", "..", "web", "dist")

const failures = []
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`)
  if (!ok) failures.push(name)
}

// ---- a fake machine gateway that answers what the app asks a machine -----------------------------

const now = new Date().toISOString()
const agents = [
  ["codex", "Codex CLI", "acp", "available"],
  ["claude", "Claude Code", "acp", "configured"]
].map(([id, label, transport, state]) => ({
  id, label, backend: id, transport, managed: true, state,
  capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, filesystemBrowser: true, commands: true }
}))
const project = { id: "project-alpha", machineId: "machine_studio", name: "alpha", path: "/work/alpha", kind: "git", configured: true }

// Sessions the harnesses list, and Claude Code background agents the CLI reports. cl2 is BOTH an ordinary Claude
// Session and a finished background agent (the agent's state must win); bgfail and bgrun are agents the harness
// listing does not contain, so the rail has to make rows for them.
const T = Date.now()
const uuid = (short) => `${short}-1111-2222-3333-444455556666`
const sessionsByAgent = {
  codex: [
    { id: "cx1", title: "Fix the flaky checkout test", directory: "/work/alpha", time: { created: T - 3 * 3_600_000, updated: T - 30_000 }, status: { type: "busy" } },
    { id: "cx2", title: "Add rate limiting to the API", directory: "/work/beta", time: { created: T - 9 * 3_600_000, updated: T - 2 * 3_600_000 }, status: { type: "idle" } },
    { id: "cx3", title: "Migrate the build to ESM", directory: "/work/alpha", time: { created: T - 7 * 3_600_000, updated: T - 5 * 3_600_000 }, status: { type: "error" } }
  ],
  claude: [
    { id: "cl1", title: "Write the migration guide", directory: "/work/beta", time: { created: T - 3 * 86_400_000, updated: T - 26 * 3_600_000 }, status: { type: "idle" } },
    { id: uuid("aaaa0002"), title: "Refactor the parser", directory: "/work/alpha", time: { created: T - 3 * 86_400_000, updated: T - 3 * 86_400_000 + 600_000 }, status: { type: "idle" } }
  ]
}
const finishedCaps = { open: true, prompt: true, logs: true, stop: false, resume: true, remove: true }
const liveCaps = { open: true, prompt: false, logs: true, stop: true, resume: false, remove: false }
const backgroundAgents = [
  { key: "background:aaaa0002", kind: "background", id: "aaaa0002", sessionId: uuid("aaaa0002"), name: "Refactor the parser", directory: "/work/alpha", activity: "completed", rawState: "done", startedAt: T - 3 * 86_400_000, updatedAt: T - 3 * 86_400_000 + 600_000, capabilities: finishedCaps },
  { key: "background:aaaa0003", kind: "background", id: "aaaa0003", sessionId: uuid("aaaa0003"), name: "Bump dependencies", directory: "/work/alpha", activity: "failed", rawState: "failed", detail: "Tests failed", startedAt: T - 5 * 3_600_000, updatedAt: T - 4 * 3_600_000, capabilities: finishedCaps },
  { key: "background:aaaa0004", kind: "background", id: "aaaa0004", sessionId: uuid("aaaa0004"), name: "Fix the type errors", directory: "/work/alpha", activity: "working", rawState: "running", startedAt: T - 20 * 60_000, updatedAt: T - 120_000, capabilities: liveCaps }
]
const gatewayRequests = []
const gateway = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gateway.local")
  gatewayRequests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization, cookie: req.headers.cookie })
  const expected = `Basic ${Buffer.from("harness:gateway-pass").toString("base64")}`
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)) }
  if (req.headers.authorization !== expected) { res.writeHead(401, { "WWW-Authenticate": "Basic" }); res.end(); return }
  if (url.pathname === "/v1/machine") return json(200, { machine: { id: "machine_studio", name: "Studio Mac", createdAt: now }, agents })
  if (url.pathname === "/v1/projects") return json(200, { projects: [project] })
  if (url.pathname === "/v1/tasks") return json(200, { tasks: [] })
  if (url.pathname === "/v1/work-threads") return json(200, { workThreads: [] })
  if (url.pathname === "/v1/session-links") return json(200, { links: [] })
  if (/\/global\/event$/.test(url.pathname)) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); return }
  const scopedSessions = /^\/v1\/agents\/([^/]+)\/experimental\/session$/.exec(url.pathname)
  if (scopedSessions) return json(200, sessionsByAgent[scopedSessions[1]] ?? [])
  if (url.pathname === "/v1/background-agents") return json(200, { available: true, agents: backgroundAgents })
  const backgroundAction = /^\/v1\/background-agents\/([a-f0-9]{8})\/(stop|logs)$/.exec(url.pathname)
  if (backgroundAction) {
    const agent = backgroundAgents.find((candidate) => candidate.id === backgroundAction[1])
    if (!agent) return json(404, { error: "unknown agent", code: "unknown_agent" })
    if (backgroundAction[2] === "logs") return json(200, { id: agent.id, text: "running the type checker\n", truncated: false })
    Object.assign(agent, { activity: "stopped", rawState: "stopped", updatedAt: Date.now(), capabilities: finishedCaps })
    return json(200, { id: agent.id })
  }
  if (/\/(experimental\/session|session)$/.test(url.pathname)) return json(200, [])
  if (/\/session\/status$/.test(url.pathname)) return json(200, {})
  return json(404, { error: `No fake route for ${req.method} ${url.pathname}` })
})
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve))
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`

// ---- the hub, serving the real build ------------------------------------------------------------------

const db = await createTestDatabase()
const hub = await startHub({ ...db, config: testConfig({ HUB_WEB_DIR: webDist }) })
const enrolled = await hub.request("/api/v1/machines/enroll", {
  method: "POST", auth: ENROLLMENT_TOKEN,
  json: machinePayload({ machine: { id: "machine_studio", name: "Studio Mac" }, endpoints: [gatewayUrl], credentials: { username: "harness", password: "gateway-pass" } })
})
await hub.request("/api/v1/machines/heartbeat", {
  method: "POST", auth: enrolled.json.token,
  json: { machine: { id: "machine_studio" }, endpoints: [gatewayUrl], agents: agents.map(({ id, label, backend, transport, state }) => ({ id, label, backend, transport, state })), config: { backend: "codex" } }
})
await hub.prober.probeMachine("machine_studio")

// ---- browser -------------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
const consoleErrors = []
const proxied = []
const shot = (page, name) => page.screenshot({ path: path.join(artifacts, `app-${name}.png`) })

async function inputAudit(page, label) {
  const bad = await page.evaluate(() => [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select, textarea")]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden" })
    .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 16)
    .map((element) => `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}(${getComputedStyle(element).fontSize})`))
  check(`${label}: every visible entry field is >=16px (no iOS zoom-on-focus)`, bad.length === 0, bad.join(", "))
}
async function overflow(page, label) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check(`${label}: no horizontal scroll`, extra <= 1, `${extra}px`)
}

try {
  const context = await browser.newContext({ ...devices["iPhone 14"] })
  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() !== "error") return
    // Deliberate 401s: the signed-out bootstrap probe answers 200, but the wrong-credential step does not.
    if (/status of (401|404)/.test(message.text())) return
    consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/m/")) proxied.push(request) })

  // A controllable stand-in for iOS's visualViewport, installed before the app boots.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, width: window.innerWidth, scale: 1 })
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport })
    window.__setVisualViewport = (height) => { viewport.height = height; viewport.dispatchEvent(new Event("resize")) }
  })

  // 1. Not signed in: the app hands over to the hub console and asks to come back.
  await page.goto(`${hub.base}/`)
  await page.waitForURL(/\/hub\/\?next=%2F/, { timeout: 15_000 })
  await page.waitForSelector("#password")
  check("signed out: the app redirects to the hub console with a return address", /next=%2F/.test(page.url()), page.url())
  await shot(page, "01-redirected-to-signin")

  // 2. Sign in: back in the app, with the hub's machines.
  await page.fill("#password", ADMIN_PASSWORD)
  await page.click("button[type=submit]")
  await page.waitForURL(`${hub.base}/`, { timeout: 15_000 })
  await page.waitForSelector(".hr-mobile-nav", { timeout: 20_000 })
  check("signed in: the console returns to the app", new URL(page.url()).pathname === "/")
  check("iOS: the page is recognised as iOS", (await page.evaluate(() => document.documentElement.dataset.hrIos)) === "1")
  await overflow(page, "app home")
  await inputAudit(page, "app home")
  await shot(page, "02-app-home")

  // The New Session form is where the app's own sheets use 12-14px fields, the sizes iOS zooms on.
  await page.getByRole("button", { name: /New Session/ }).first().click()
  await page.waitForFunction(() => document.querySelectorAll("textarea, select").length > 0, null, { timeout: 15_000 })
  await page.waitForTimeout(400)
  const fields = await page.locator("input:not([type=checkbox]):not([type=radio]), select, textarea").evaluateAll((elements) =>
    elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 }).length)
  check("new session: the form has entry fields to audit", fields >= 2, `${fields} visible fields`)
  await inputAudit(page, "new session form")
  await overflow(page, "new session form")
  await shot(page, "02b-new-session")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: /Create Session/ }).waitFor({ state: "hidden" })

  // 2c. The rail: state chips, grouping, time window and Claude Code background agents.
  const rows = page.locator(".hr-native-session-row")
  await rows.first().waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForFunction(() => document.querySelectorAll(".hr-native-session-row").length >= 7, null, { timeout: 20_000 })
  const titlesInRail = async () => page.locator(".hr-native-session-row strong").allTextContents()
  check("rail: harness Sessions and background agents are all listed (agents the harness listing lacks get a row)", (await rows.count()) === 7, String(await rows.count()))
  check("rail: background agents are badged", (await page.locator(".hr-native-session-bg").count()) === 3, String(await page.locator(".hr-native-session-bg").count()))
  const chip = (name) => page.locator(".hr-native-session-filters button", { hasText: name })
  check("rail: Completed and Failed are one tap away, with counts", /1/.test(await chip("Completed").textContent()) && /2/.test(await chip("Failed").textContent()), `${await chip("Completed").textContent()} | ${await chip("Failed").textContent()}`)
  check("rail: the default is still the Machine › Project tree", (await page.locator(".hr-native-machine-heading").count()) >= 1 && (await page.locator(".hr-native-flat-group").count()) === 0)
  check("rail: the finished agent's own state beats the harness listing's 'idle'", /Completed/.test(await page.locator(".hr-native-session-row", { hasText: "Refactor the parser" }).textContent()))
  await overflow(page, "rail with grouping controls")
  await inputAudit(page, "rail controls")
  await shot(page, "02c-rail-tree")

  const groupBySelect = page.getByLabel("Group by")
  await groupBySelect.selectOption("none")
  await page.waitForSelector(".hr-native-flat-group")
  check("group by none: one recent feed across every project, with no machine or project headings", (await page.locator(".hr-native-flat-group").count()) === 1 && (await page.locator(".hr-native-machine-heading").count()) === 0 && (await rows.count()) === 7)
  check("group by none: newest run first", (await titlesInRail())[0] === "Fix the flaky checkout test", (await titlesInRail()).join(" | "))
  check("group by none: each row says where it is from", /Studio Mac · alpha/.test(await rows.first().textContent()))
  await shot(page, "02d-rail-recent")

  await groupBySelect.selectOption("status")
  await page.waitForSelector('.hr-native-flat-group[data-activity="working"]')
  const headings = await page.locator(".hr-native-flat-group > .hr-native-project-heading strong").allTextContents()
  check("group by status: what needs a look comes first, in a fixed order", headings.join(",") === "Working,Failed,Completed,Idle", headings.join(","))
  check("group by status: the failed background agent is under Failed", /Bump dependencies/.test(await page.locator('.hr-native-flat-group[data-activity="failed"]').textContent()))
  check("group by status: the failed harness Session is under Failed too", /Migrate the build to ESM/.test(await page.locator('.hr-native-flat-group[data-activity="failed"]').textContent()))
  check("group by status: the finished agent is under Completed", /Refactor the parser/.test(await page.locator('.hr-native-flat-group[data-activity="completed"]').textContent()))
  await shot(page, "02e-rail-by-status")

  await groupBySelect.selectOption("project")
  await page.waitForFunction(() => document.querySelectorAll(".hr-native-flat-group").length === 2)
  check("group by project: alpha and beta, across harnesses", (await page.locator(".hr-native-flat-group > .hr-native-project-heading strong").allTextContents()).sort().join(",") === "alpha,beta")

  await page.getByLabel("Last ran").selectOption("1h")
  await page.waitForFunction(() => document.querySelectorAll(".hr-native-session-row").length === 2)
  check("time window: only what ran in the last hour", (await titlesInRail()).sort().join("|") === "Fix the flaky checkout test|Fix the type errors", (await titlesInRail()).join("|"))
  await page.getByLabel("Last ran").selectOption("any")
  await page.waitForFunction(() => document.querySelectorAll(".hr-native-session-row").length === 7)

  await groupBySelect.selectOption("status")
  await page.reload()
  await page.waitForSelector(".hr-mobile-nav", { timeout: 20_000 })
  await page.waitForSelector(".hr-native-flat-group")
  check("the chosen grouping is remembered across a reload", (await page.getByLabel("Group by").inputValue()) === "status")

  // Attach to the running background agent: a bar with its state and controls, and it can be stopped.
  const proxyStopBefore = gatewayRequests.filter((request) => /\/stop$/.test(request.path)).length
  await page.locator(".hr-native-session-row", { hasText: "Fix the type errors" }).click()
  await page.locator(".hr-bg-agent-bar").waitFor({ state: "visible", timeout: 20_000 })
  check("attach: a running background agent is shown as Working, read-only", /Working/.test(await page.locator(".hr-bg-agent-pill").textContent()) && /read along but not send messages/.test(await page.locator(".hr-bg-agent-bar").textContent()))
  check("attach: it offers Output and Stop, and not Continue or Remove while running", (await page.getByRole("button", { name: "Stop", exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Output", exact: true }).count()) === 1 && (await page.getByRole("button", { name: /Continue in background/ }).count()) === 0 && (await page.getByRole("button", { name: "Remove", exact: true }).count()) === 0)
  await overflow(page, "background agent bar")
  await shot(page, "02f-background-agent-running")
  await page.getByRole("button", { name: "Output", exact: true }).click()
  await page.locator(".hr-bg-agent-logs pre").waitFor({ state: "visible" })
  // The box opens straight away with a placeholder while the output is fetched through the hub, so wait for
  // the text itself; reading it once raced the request on a slower machine.
  await page.waitForFunction(() => /running the type checker/.test(document.querySelector(".hr-bg-agent-logs pre")?.textContent ?? ""), null, { timeout: 15_000 }).catch(() => {})
  check("attach: its terminal output is shown", /running the type checker/.test(await page.locator(".hr-bg-agent-logs pre").textContent()))
  check("attach: a read-only Session has one Stop (the bar's), not a second that would abort the wrong thing", (await page.getByRole("button", { name: "Stop", exact: true }).count()) === 1)
  await page.locator(".hr-bg-agent-actions").getByRole("button", { name: "Stop", exact: true }).click()
  // Asked inline, not with a native dialog: the first tap only asks.
  await page.locator(".hr-bg-agent-confirm").waitFor({ state: "visible" })
  check("attach: Stop asks first, inline", gatewayRequests.filter((request) => /\/stop$/.test(request.path)).length === proxyStopBefore)
  await page.locator(".hr-bg-agent-confirm").getByRole("button", { name: "Stop", exact: true }).click()
  await page.waitForFunction(() => /Stopped/.test(document.querySelector(".hr-bg-agent-pill")?.textContent ?? ""), null, { timeout: 15_000 })
  const stops = gatewayRequests.filter((request) => /\/stop$/.test(request.path))
  check("attach: Stop reached the machine through the hub with the injected credentials", stops.length === proxyStopBefore + 1 && stops.at(-1).authorization === `Basic ${Buffer.from("harness:gateway-pass").toString("base64")}` && !stops.at(-1).cookie)
  check("attach: once stopped it can be continued in the background or removed", (await page.getByRole("button", { name: /Continue in background/ }).count()) === 1 && (await page.getByRole("button", { name: "Remove", exact: true }).count()) === 1)
  await shot(page, "02g-background-agent-stopped")
  await page.locator(".tdw-mobile-back").first().click().catch(() => {})

  // 3. The machine comes from the hub, and is used through the proxy.
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "visible" })
  await page.locator(".uw-machine-manager").getByText("Studio Mac", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 })
  const card = page.locator(".uw-machine-config-card", { hasText: "Studio Mac" })
  check("machines: the hub's machine is listed and marked as hub-managed", /Managed by your hub/.test(await card.textContent()))
  check("machines: a hub machine has no Edit or Remove", (await card.getByRole("button", { name: /^(Edit|Remove)$/ }).count()) === 0)
  check("machines: it is discovered as online through the proxy", (await card.locator('[data-machine-state="online"], .uw-machine-connection-state.online').count()) > 0 || /agents? detected|Codex/i.test(await card.textContent()), await card.textContent())
  await overflow(page, "machines page")
  await shot(page, "03-machines")

  const throughProxy = gatewayRequests.filter((request) => request.path === "/v1/machine")
  check("proxy: the gateway saw the hub's injected credentials", throughProxy.length > 0 && throughProxy.every((request) => request.authorization === `Basic ${Buffer.from("harness:gateway-pass").toString("base64")}`))
  check("proxy: the browser's session cookie never reached the gateway", gatewayRequests.every((request) => !request.cookie))
  check("proxy: the page sent no Authorization header (it holds no gateway credentials)", proxied.length > 0 && proxied.every((request) => request.headers().authorization === undefined), `${proxied.length} requests`)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  check("storage: no gateway password is stored in the browser", !/gateway-pass/.test(stored))
  check("storage: hub machines are not persisted", !/machine_studio/.test(stored))

  // 4. Entry fields on iOS: the editor is the tightest place for them.
  await page.getByRole("button", { name: /Add another machine/ }).click()
  await page.locator(".uw-machine-editor").waitFor({ state: "visible" })
  await inputAudit(page, "add-machine editor")
  await shot(page, "04-add-machine-editor")
  await page.getByRole("button", { name: /Cancel/ }).click().catch(() => {})
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Settings/ }).click()
  await page.locator(".hr-session-settings-page, .hr-mobile-settings-page").first().waitFor({ state: "visible" })
  await inputAudit(page, "settings")
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ }).click()

  // 5. The keyboard: sized to the visible area, nav out of the way, restored afterwards.
  const height = await page.evaluate(() => window.innerHeight)
  await page.evaluate((visible) => window.__setVisualViewport(visible), 430)
  await page.waitForFunction(() => document.documentElement.dataset.hrKeyboard === "open")
  const keyboard = await page.evaluate(() => ({
    navDisplay: getComputedStyle(document.querySelector(".hr-mobile-nav")).display,
    hostHeight: document.querySelector(".uw-standalone-host").getBoundingClientRect().height,
    variable: document.documentElement.style.getPropertyValue("--hr-vv-height")
  }))
  check("keyboard: the visible height is published", keyboard.variable === "430px", keyboard.variable)
  check("keyboard: the app is sized to the visible area, not the full layout height", Math.round(keyboard.hostHeight) === 430, `${keyboard.hostHeight} (layout ${height})`)
  check("keyboard: the bottom nav steps aside", keyboard.navDisplay === "none", keyboard.navDisplay)
  await shot(page, "05-keyboard-open")
  await page.evaluate((full) => window.__setVisualViewport(full), height)
  await page.waitForFunction(() => document.documentElement.dataset.hrKeyboard === undefined)
  check("keyboard: closing restores the nav and full height", await page.evaluate(() => getComputedStyle(document.querySelector(".hr-mobile-nav")).display !== "none" && Math.round(document.querySelector(".uw-standalone-host").getBoundingClientRect().height) === window.innerHeight))

  // 6. Service worker: it may cache the app, never the hub's live data.
  const registered = await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; return registration.active?.scriptURL ?? null })
  check("service worker: registered for the app", Boolean(registered), String(registered))
  await page.reload()
  await page.waitForSelector(".hr-mobile-nav", { timeout: 20_000 })
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").getByText("Studio Mac", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 })
  const cached = await page.evaluate(async () => {
    const urls = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
    return urls
  })
  check("service worker: nothing under /m/ or /api/ or /hub/ was cached", cached.every((pathname) => !/^\/(m|api|hub)(\/|$)/.test(pathname)), cached.filter((pathname) => /^\/(m|api|hub)/.test(pathname)).join(", "))
  check("service worker: the app shell itself is cached", cached.includes("/") || cached.some((pathname) => pathname.startsWith("/assets/")), cached.join(", "))
  const swHeaders = await page.evaluate(async () => { const response = await fetch("/sw.js", { cache: "no-store" }); return { control: response.headers.get("cache-control"), text: (await response.text()).includes("harness-remote-v4") } })
  check("service worker: served no-cache and is the v4 build", swHeaders.control === "no-cache" && swHeaders.text, JSON.stringify(swHeaders))

  // 7. Home-screen metadata.
  const icon = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="apple-touch-icon"]')
    const image = new Image(); image.src = link.href; await image.decode()
    return { sizes: link.getAttribute("sizes"), width: image.naturalWidth, height: image.naturalHeight, title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content }
  })
  check("home screen: a 180x180 apple-touch-icon that actually loads", icon.width === 180 && icon.height === 180 && icon.sizes === "180x180", JSON.stringify(icon))
  check("home screen: has its own title", icon.title === "Harness Remote")

  await context.close()

  // 8. A visit to a plain host must not be affected: the same build, no hub -> the probe gets a "no".
  //    (Simulated by asking the hub for a path it does not serve as a hub would not; here we assert the
  //    contract the app relies on: unknown api paths are JSON 404s and never SPA HTML.)
  const unknown = await hub.request("/api/v1/nope")
  check("contract: unknown API paths are JSON 404s, never the app shell", unknown.status === 404 && unknown.json?.error === "not_found")
} finally {
  await browser.close()
}

check("no unexpected console errors or uncaught exceptions", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "))

await hub.close()
await new Promise((resolve) => { gateway.closeAllConnections?.(); gateway.close(resolve) })
await db.drop()

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("\nAll app checks passed. Screenshots are in hub/browser-artifacts/.")
