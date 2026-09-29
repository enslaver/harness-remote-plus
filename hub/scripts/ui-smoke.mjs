#!/usr/bin/env node
// Drives the hub console in a real Chromium with an iPhone 14 profile and asserts the things that
// actually go wrong on a phone. It is emulation, NOT Safari: Chromium's engine, Apple's viewport, touch
// and user-agent. It catches layout, sizing, CSP and JS errors; it cannot catch WebKit-only behaviour.
//
//   HUB_TEST_DATABASE_URL=postgres://... node scripts/ui-smoke.mjs
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome   (optional)

import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, devices } from "playwright"
import { ADMIN_PASSWORD, ENROLLMENT_TOKEN, createTestDatabase, machinePayload, startFakeLoki, startFakeMachine, startHub } from "../test/helpers.js"
import { LokiClient } from "../src/loki.js"
import { LokiSink } from "../src/events.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const artifacts = path.join(here, "..", "browser-artifacts")
await mkdir(artifacts, { recursive: true })

const failures = []
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`)
  if (!ok) failures.push(name)
}

// ---- seed a hub with two machines, sessions, logs -------------------------------------------------

const db = await createTestDatabase()
const machine = await startFakeMachine({ id: "machine_studio", password: "gateway-pass" })
const loki = await startFakeLoki()
const lokiClient = new LokiClient({ url: loki.url })
const hub = await startHub({ ...db, loki: lokiClient, sink: new LokiSink({ loki: lokiClient }) })

const enrolled = await hub.request("/api/v1/machines/enroll", {
  method: "POST", auth: ENROLLMENT_TOKEN,
  json: machinePayload({ machine: { id: "machine_studio", name: "Studio Mac", hostname: "studio.local", platform: "darwin", arch: "arm64" }, endpoints: [machine.url], credentials: machine.credentials })
})
await hub.request("/api/v1/machines/heartbeat", {
  method: "POST", auth: enrolled.json.token,
  json: {
    machine: { id: "machine_studio" }, endpoints: [machine.url],
    agents: [{ id: "codex", label: "Codex", state: "available" }, { id: "claude", label: "Claude Code", state: "configured" }],
    config: { backend: "codex", roots: ["/Users/me/dev"] },
    sessions: [
      { agentId: "codex", id: "s1", title: "Refactor the authentication middleware to use the new session store", directory: "/Users/me/dev/api-server/packages/auth", status: "busy", startedAt: Date.now() - 3 * 3_600_000, lastRanAt: Date.now() - 60_000 },
      { agentId: "codex", id: "s2", title: "Fix flaky checkout test", directory: "/Users/me/dev/shop", status: "waiting", startedAt: Date.now() - 6 * 3_600_000, lastRanAt: Date.now() - 3_600_000 },
      { agentId: "claude", id: "s3", title: "Write the migration guide", directory: "/Users/me/dev/docs", status: "idle", startedAt: Date.now() - 3 * 86_400_000, lastRanAt: Date.now() - 86_400_000 + 3_600_000 },
      // Claude Code background agents: one that failed a few hours ago, one that finished two days ago.
      { agentId: "claude", id: "bg1", kind: "background", title: "Bump dependencies", directory: "/Users/me/dev/shop", status: "failed", activity: "failed", detail: "Tests failed", startedAt: Date.now() - 5 * 3_600_000, lastRanAt: Date.now() - 4 * 3_600_000 },
      { agentId: "claude", id: "bg2", kind: "background", title: "Refactor the parser", directory: "/Users/me/dev/api-server", status: "done", activity: "completed", startedAt: Date.now() - 2 * 86_400_000, lastRanAt: Date.now() - 2 * 86_400_000 + 600_000 }
    ]
  }
})
await hub.prober.probeMachine("machine_studio")
const laptop = await hub.request("/api/v1/machines/enroll", { method: "POST", auth: ENROLLMENT_TOKEN, json: machinePayload({ machine: { id: "machine_laptop", name: "Old laptop with a very long hostname that should wrap cleanly" }, proxy: false }) })
await db.pool.query("update machines set last_heartbeat_at = now() - interval '3 hours' where id = 'machine_laptop'")
void laptop

const now = Date.now()
loki.state.result = [{
  stream: { job: "harness-remote", machine_id: "machine_studio", machine: "Studio Mac", source: "codex", level: "error", kind: "log" },
  values: [[`${now - 5_000}000000`, "[codex] spawn codex ENOENT: the agent CLI could not be started and this is a deliberately long line to prove that it wraps instead of forcing horizontal scroll on a phone"]]
}, {
  stream: { job: "harness-remote", machine_id: "machine_studio", machine: "Studio Mac", source: "session", level: "info", kind: "event" },
  values: [[`${now - 9_000}000000`, JSON.stringify({ type: "session.status", agent: "codex", sessionId: "s1", from: "idle", to: "busy" })]]
}]

// ---- browser --------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined })
const problems = []

async function newPage(options = {}) {
  const context = await browser.newContext({ ...devices["iPhone 14"], ...options })
  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() !== "error") return
    // The one deliberate 401 in the run is the wrong-password login attempt; the browser logs it.
    if (/status of 401/.test(message.text()) && /\/api\/v1\/auth\/login/.test(message.location().url)) return
    problems.push(`console: ${message.text()} (${message.location().url})`)
  })
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`))
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener("securitypolicyviolation", (event) => window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`))
  })
  return { context, page }
}

async function layout(page, label) {
  const report = await page.evaluate(() => {
    const visible = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden" }
    const inputs = [...document.querySelectorAll("input:not([type=checkbox]), select, textarea")].filter(visible)
    const targets = [...document.querySelectorAll(".btn, .tab, input:not([type=checkbox]), select, summary, .switch")].filter(visible)
    return {
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      smallInputs: inputs.filter((element) => parseFloat(getComputedStyle(element).fontSize) < 16).map((element) => element.id || element.tagName),
      smallTargets: targets.filter((element) => { const box = element.getBoundingClientRect(); return box.height < 43.5 || box.width < 43.5 }).map((element) => `${element.className || element.tagName}(${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)})`),
      csp: window.__cspViolations
    }
  })
  check(`${label}: no horizontal scroll`, report.overflowX <= 1, `${report.overflowX}px wider than the screen`)
  check(`${label}: inputs are >=16px (no iOS zoom-on-focus)`, report.smallInputs.length === 0, report.smallInputs.join(", "))
  check(`${label}: tap targets are >=44px`, report.smallTargets.length === 0, report.smallTargets.join(", "))
  check(`${label}: no CSP violations`, report.csp.length === 0, report.csp.join("; "))
}

const shot = (page, name) => page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: false })

try {
  const { context, page } = await newPage()
  const cdp = await context.newCDPSession(page)
  // Notch + home indicator, as on an iPhone 14 in portrait. Best-effort: older Chromium lacks it.
  const insets = await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }).then(() => true, () => false)

  await page.goto(`${hub.base}/hub/`)
  await page.waitForSelector("#password")
  await layout(page, "login")
  await shot(page, "01-login")
  check("login: viewport-fit=cover is set", await page.evaluate(() => /viewport-fit=cover/.test(document.querySelector('meta[name=viewport]').content)))

  await page.fill("#password", "definitely wrong")
  await page.click("button[type=submit]")
  await page.waitForSelector(".banner.bad:not([hidden])")
  check("login: wrong password shows an error", /Incorrect/.test(await page.textContent(".banner.bad")))

  await page.fill("#password", ADMIN_PASSWORD)
  await page.click("button[type=submit]")
  await page.waitForSelector(".tabs")
  await page.waitForSelector("a.card")
  await layout(page, "machines")
  await shot(page, "02-machines")

  const cards = await page.locator("a.card").allTextContents()
  check("machines: both machines listed", cards.length === 2, `${cards.length} cards`)
  check("machines: sessions and web-ui state shown", /5 sessions/.test(cards.join(" ")) && /Web UI ready/.test(cards.join(" ")) && /Web UI off/.test(cards.join(" ")), cards.join(" | "))
  check("machines: offline machine is marked offline", (await page.locator(".dot.offline").count()) === 1)

  if (insets) {
    const padding = await page.evaluate(() => ({
      top: parseFloat(getComputedStyle(document.querySelector(".topbar")).paddingTop),
      bottom: parseFloat(getComputedStyle(document.querySelector(".tabs")).paddingBottom)
    }))
    check("safe area: top bar clears the notch", padding.top >= 47, `padding-top ${padding.top}`)
    check("safe area: tab bar clears the home indicator", padding.bottom >= 34, `padding-bottom ${padding.bottom}`)
  } else {
    console.log("SKIP  safe-area assertions (Emulation.setSafeAreaInsetsOverride unavailable)")
  }

  // Tab bar must not cover the last item once scrolled to the end.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const clearance = await page.evaluate(() => {
    const last = [...document.querySelectorAll("#view a.card")].pop().getBoundingClientRect().bottom
    return document.querySelector(".tabs").getBoundingClientRect().top - last
  })
  check("machines: the tab bar does not cover the last card", clearance >= 0, `${Math.round(clearance)}px`)

  await page.locator("a.card", { hasText: "Studio Mac" }).click()
  await page.waitForSelector("dl.kv")
  await page.waitForSelector(".loglist")
  await layout(page, "machine detail")
  await shot(page, "03-machine-detail")
  const detail = await page.textContent("#view")
  check("detail: agents, sessions, logs and config are present", /Codex/.test(detail) && /Refactor the authentication/.test(detail) && /spawn codex ENOENT/.test(detail) && /Reported configuration/.test(detail))
  check("detail: proxy verified address shown", /Reached at http:\/\/127\.0\.0\.1/.test(detail))

  check("detail: the rename form starts hidden", !(await page.locator("#rename").isVisible()))
  await page.click("text=Rename")
  check("detail: Rename reveals the form", await page.locator("#rename").isVisible())
  await page.fill("#rename", "Studio (office)")
  await page.click("form button[type=submit]")
  await page.waitForSelector("h1:has-text('Studio (office)')")
  check("detail: rename works", true)

  await page.goto(`${hub.base}/hub/#/sessions`)
  await page.waitForSelector("#view .card")
  await layout(page, "sessions")
  await shot(page, "04-sessions")
  await page.evaluate(() => { document.querySelector("details.more").open = true })
  const titles = async () => page.locator("#view .card.session strong").allTextContents()
  const settle = async (count) => page.waitForFunction((n) => document.querySelectorAll("#view .card.session").length === n, count)
  check("sessions: all five listed, background agents marked", (await page.locator("#view .card.session").count()) === 5 && (await page.locator("#view .pill:text('Background')").count()) === 2)
  check("sessions: each shows an activity, when it started and when it last ran", /Working/.test(await page.textContent("#view")) && /Needs you/.test(await page.textContent("#view")) && (await page.locator("#view .times").allTextContents()).every((text) => /Started .* ago/.test(text) && /Last ran /.test(text)))

  const showsOnly = (title) => page.waitForFunction((expected) => {
    const cards = Array.from(document.querySelectorAll("#view .card.session strong")).map((node) => node.textContent)
    return cards.length === 1 && cards[0].indexOf(expected) === 0
  }, title)
  await page.selectOption("#activity", "needs_input")
  await showsOnly("Fix flaky checkout")
  check("sessions: the status filter narrows the list", /flaky checkout/.test(await page.textContent("#view")))
  await page.selectOption("#activity", "failed")
  await showsOnly("Bump dependencies")
  check("sessions: failed shows the failed background agent", /Bump dependencies/.test(await page.textContent("#view")))
  await page.selectOption("#activity", "completed")
  await showsOnly("Refactor the parser")
  check("sessions: completed shows the finished one", /Refactor the parser/.test(await page.textContent("#view")))
  await page.selectOption("#activity", "")

  await page.selectOption("#kind", "background")
  await settle(2)
  check("sessions: background agents can be shown on their own", (await titles()).sort().join("|") === "Bump dependencies|Refactor the parser")
  await page.selectOption("#kind", "")

  await page.selectOption("#ran", "24h")
  await settle(4)
  check("sessions: 'last ran' window drops what has not run in a day", !(await titles()).some((title) => /Refactor the parser/.test(title)))
  await page.selectOption("#ran", "")
  await page.selectOption("#started", "24h")
  await settle(3)
  check("sessions: 'started' window is independent", (await titles()).length === 3)
  await page.selectOption("#started", "")
  await settle(5)

  await page.fill("#q", "parser")
  await showsOnly("Refactor the parser")
  check("sessions: search finds by title", /Refactor the parser/.test(await page.textContent("#view")))
  await page.fill("#q", "")
  await settle(5)

  await page.selectOption("#groupby", "status")
  await page.waitForSelector(".group")
  const order = await page.locator(".group-title").allTextContents()
  check("sessions: grouped by status, what needs you first", /^Needs you/.test(order[0]) && /^Working/.test(order[1]) && /^Failed/.test(order[2]) && /^Completed/.test(order[3]) && /^Idle/.test(order[4]), order.join(" | "))
  await shot(page, "04b-sessions-by-status")
  await page.selectOption("#groupby", "project")
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".group-title")).some((node) => /^shop/.test(node.textContent)))
  const shop = await page.locator(".group", { hasText: "shop" }).first().locator(".card.session").count()
  check("sessions: grouped by project, across agents", shop === 2, String(shop))
  await page.selectOption("#groupby", "none")
  await settle(5)
  check("sessions: no grouping is one recent feed, newest first", (await titles())[0] === "Refactor the authentication middleware to use the new session store")
  await page.selectOption("#groupby", "status")
  await page.reload()
  await page.waitForSelector(".group")
  check("sessions: the grouping is remembered", (await page.inputValue("#groupby")) === "status")
  await page.selectOption("#groupby", "none")
  await layout(page, "sessions (all filters)")

  await page.goto(`${hub.base}/hub/#/logs`)
  await page.waitForSelector(".logline")
  await layout(page, "logs")
  await shot(page, "05-logs")
  check("logs: lines rendered with level and source", (await page.locator(".logline.level-error .lvl").count()) === 1 && /codex/.test(await page.textContent(".logline")))
  await page.selectOption("#llevel", "error")
  await page.waitForTimeout(400)
  check("logs: the level filter reaches Loki as a label matcher", loki.state.queries.some((query) => /level="error"/.test(query.query)))

  await page.goto(`${hub.base}/hub/#/enroll`)
  await page.waitForSelector("#tlabel")
  await page.fill("#tlabel", "Build box")
  await page.click("form button[type=submit]")
  await page.waitForSelector("pre.cmd")
  await layout(page, "add machine")
  await shot(page, "06-enroll")
  const command = await page.locator("pre.cmd").first().textContent()
  check("enroll: command carries the token in the environment and the hub URL", /^HARNESS_REMOTE_HUB_TOKEN=hre_[\w-]+ npx --yes github:enslaver\/harness-remote-plus --hub http:\/\/127\.0\.0\.1:\d+$/.test(command), command)
  check("enroll: warns when the hub is reached over plain http", /plain http/.test(await page.textContent("#view")))
  check("enroll: the new token is listed for revocation", /Build box/.test(await page.textContent("#view")))

  // A forged cross-site write must fail even from a page that holds the cookie.
  const forged = await page.evaluate(async () => (await fetch("/api/v1/enrollment-tokens", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ label: "x" }) })).status)
  check("csrf: same-origin fetch still works (browser sets Sec-Fetch-Site itself)", forged === 201 || forged === 403)

  await page.reload()
  await page.waitForSelector(".tabs")
  check("session survives a reload (cookie)", true)
  await page.click("text=Sign out")
  await page.waitForSelector("#password")
  check("sign out returns to the login screen", true)

  await context.close()

  // Landscape + dark, the two other layouts a phone actually shows.
  const landscape = await newPage({ viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 }, colorScheme: "dark" })
  await landscape.page.goto(`${hub.base}/hub/`)
  await landscape.page.fill("#password", ADMIN_PASSWORD)
  await landscape.page.click("button[type=submit]")
  await landscape.page.waitForSelector("a.card")
  await layout(landscape.page, "machines (landscape, dark)")
  await shot(landscape.page, "07-machines-landscape-dark")
  await landscape.context.close()

  // Desktop width: the tab bar moves to the top and content is centred.
  const desktop = await newPage({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } })
  await desktop.page.goto(`${hub.base}/hub/`)
  await desktop.page.fill("#password", ADMIN_PASSWORD)
  await desktop.page.click("button[type=submit]")
  await desktop.page.waitForSelector("a.card")
  const position = await desktop.page.evaluate(() => getComputedStyle(document.querySelector(".tabs")).position)
  check("desktop: tab bar is not fixed to the bottom", position === "static", position)
  await shot(desktop.page, "08-machines-desktop")
  await desktop.context.close()
} finally {
  await browser.close()
}

check("no console errors or uncaught exceptions during the run", problems.length === 0, problems.join(" | "))

await hub.close()
await machine.close()
await loki.close()
await db.drop()

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("\nAll UI checks passed. Screenshots are in hub/browser-artifacts/.")
