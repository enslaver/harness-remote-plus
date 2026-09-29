import { ago, clip, clock, h, installCommands, parseRoute, pretty, proxyState, safeNext, sessionTone } from "./util.js"

const app = document.getElementById("app")
let hub = { name: "Harness Remote Hub", publicUrl: location.origin, installCommand: "npx --yes github:enslaver/harness-remote-plus" }
let timer = null
let renderId = 0

// ---- API ---------------------------------------------------------------------------------------

class AuthError extends Error {}

async function api(path, options) {
  const opts = options || {}
  const response = await fetch(path, {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: opts.json === undefined ? {} : { "Content-Type": "application/json" },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json)
  })
  if (response.status === 401) {
    showLogin()
    throw new AuthError("Signed out")
  }
  let data = null
  try {
    data = await response.json()
  } catch (error) {
    data = null
  }
  if (!response.ok) {
    const failure = new Error((data && data.message) || response.statusText || "Request failed")
    failure.status = response.status
    failure.code = data && data.error
    throw failure
  }
  return data
}

function reportClientError(message, stack) {
  // Best-effort and rate limited: an error loop must not become a request storm.
  const now = Date.now()
  reportClientError.sent = (reportClientError.sent || []).filter((t) => now - t < 60000)
  if (reportClientError.sent.length >= 5) return
  reportClientError.sent.push(now)
  fetch("/api/v1/client-logs", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [{ level: "error", message: String(message), stack: stack ? String(stack) : undefined, url: location.href, userAgent: navigator.userAgent, context: { app: "hub-console", viewport: innerWidth + "x" + innerHeight } }] })
  }).catch(function () {})
}
window.addEventListener("error", (event) => reportClientError(event.message, event.error && event.error.stack))
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason instanceof AuthError) return
  reportClientError(event.reason && event.reason.message ? event.reason.message : "Unhandled rejection", event.reason && event.reason.stack)
})

// ---- small UI pieces -----------------------------------------------------------------------------

const ICONS = {
  machines: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sessions: '<path d="M4 5h16v11H9l-5 4z"/>',
  logs: '<path d="M5 4h14v16H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  enroll: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("aria-hidden", "true")
  // Static strings defined above, never server data.
  svg.innerHTML = ICONS[name]
  return svg
}

function banner(text, tone) {
  return h("div", { class: "banner" + (tone ? " " + tone : ""), role: tone === "bad" ? "alert" : "status" }, text)
}

function errorBox(error, retry) {
  return h("div", { class: "card" }, banner(error.message || "Something went wrong", "bad"), retry ? h("button", { class: "btn", type: "button", onclick: retry }, "Try again") : null)
}

function stat(label, value) {
  return h("div", { class: "stat" }, h("b", {}, String(value)), h("span", {}, label))
}

function statusPill(status) {
  return h("span", { class: "pill " + sessionTone(status) }, status || "unknown")
}

function agentChip(agent) {
  return h("span", { class: "chip " + agent.state, title: agent.state }, h("i"), agent.label)
}

function copyButton(getText, label) {
  const button = h("button", { class: "btn small", type: "button" }, label || "Copy")
  button.addEventListener("click", async () => {
    const text = getText()
    let done = false
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        done = true
      }
    } catch (error) {
      done = false
    }
    if (!done) {
      // Plain-http LAN access has no async clipboard, and iOS needs a real selection to copy from.
      const area = h("textarea", { readonly: true, "aria-hidden": "true" })
      area.value = text
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      area.setSelectionRange(0, text.length)
      try { done = document.execCommand("copy") } catch (error) { done = false }
      area.remove()
    }
    button.textContent = done ? "Copied" : "Press and hold to copy"
    setTimeout(() => { button.textContent = label || "Copy" }, 2000)
  })
  return button
}

// ---- login ---------------------------------------------------------------------------------------

function showLogin(message) {
  stopTimer()
  renderId += 1
  const error = h("p", { class: "banner bad", role: "alert", hidden: true })
  const password = h("input", { id: "password", type: "password", autocomplete: "current-password", enterkeyhint: "go", required: true, autofocus: true })
  const submit = h("button", { class: "btn primary", type: "submit" }, "Sign in")
  const form = h("form", { onsubmit: async (event) => {
    event.preventDefault()
    submit.disabled = true
    error.hidden = true
    try {
      const response = await fetch("/api/v1/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password.value }) })
      if (response.ok) return start()
      const body = await response.json().catch(() => null)
      error.textContent = response.status === 429 ? "Too many attempts. Wait a few minutes and try again." : (body && body.message) || "Sign-in failed"
      error.hidden = false
    } catch (failure) {
      error.textContent = "Cannot reach the hub."
      error.hidden = false
    }
    submit.disabled = false
    password.select()
  } }, h("div", { class: "field" }, h("label", { for: "password" }, "Admin password"), password), error, submit)
  app.replaceChildren(h("main", { class: "login" }, h("div", { class: "logo", "aria-hidden": "true" }, "HR"), h("h1", {}, hub.name), h("p", { class: "muted" }, message || "Sign in to manage your machines."), form))
  password.focus()
}

// ---- shell ---------------------------------------------------------------------------------------

const TABS = [["machines", "Machines"], ["sessions", "Sessions"], ["logs", "Logs"], ["enroll", "Add machine"]]

function showShell() {
  const main = h("main", { id: "view", tabindex: "-1" })
  const tabs = h("nav", { class: "tabs", "aria-label": "Sections" }, TABS.map(([name, label]) =>
    h("a", { class: "tab", href: name === "machines" ? "#/" : "#/" + name, "data-tab": name }, icon(name), h("span", {}, label))
  ))
  app.replaceChildren(
    h("header", { class: "topbar" },
      h("div", { class: "brand" }, h("div", { class: "logo", "aria-hidden": "true" }, "HR"), h("div", { class: "grow" }, h("strong", {}, "Fleet"), h("small", {}, hub.name))),
      h("div", { class: "actions" },
        h("a", { class: "btn small", href: "/" }, "Workspace"),
        h("button", { class: "btn small ghost", type: "button", onclick: signOut }, "Sign out"))),
    tabs,
    main
  )
  return main
}

async function signOut() {
  try {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" })
  } catch (error) { /* signing out locally is enough */ }
  showLogin("You are signed out.")
}

function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

// ---- routing -------------------------------------------------------------------------------------

async function show() {
  stopTimer()
  const id = ++renderId
  const route = parseRoute(location.hash)
  const main = document.getElementById("view")
  if (!main) return
  for (const tab of document.querySelectorAll(".tab")) {
    const current = tab.dataset.tab === (route.name === "machine" ? "machines" : route.name)
    if (current) tab.setAttribute("aria-current", "page")
    else tab.removeAttribute("aria-current")
  }
  const controller = VIEWS[route.name](route)
  main.replaceChildren(controller.node)
  document.title = (controller.title ? controller.title + " · " : "") + hub.name

  let failing = false
  const run = async () => {
    if (id !== renderId) return
    try {
      await controller.load()
      if (failing && controller.banner) controller.banner.replaceChildren()
      failing = false
    } catch (error) {
      if (error instanceof AuthError || id !== renderId) return
      if (!controller.loaded) controller.node.replaceChildren(errorBox(error, run))
      else if (controller.banner) controller.banner.replaceChildren(banner("Connection problem, retrying: " + error.message))
      failing = true
      return
    }
    controller.loaded = true
  }
  await run()
  if (id === renderId && controller.refreshMs) {
    timer = setInterval(() => { if (document.visibilityState === "visible") run() }, controller.refreshMs)
  }
  controller.refresh = run
}

document.addEventListener("visibilitychange", () => {
  // iOS suspends the page in the background; refresh the moment it is back rather than at the next tick.
  if (document.visibilityState === "visible" && document.getElementById("view")) show()
})
window.addEventListener("hashchange", () => { if (document.getElementById("view")) { show(); document.getElementById("view").focus() } })

// ---- machines ------------------------------------------------------------------------------------

function machineCard(machine) {
  const proxy = proxyState(machine)
  const info = [machine.platform, machine.arch].filter(Boolean).join(" ")
  return h("a", { class: "card", href: "#/machines/" + encodeURIComponent(machine.id) },
    h("div", { class: "row" },
      h("span", { class: "dot " + machine.status, role: "img", "aria-label": machine.status }),
      h("strong", { class: "grow" }, machine.name),
      h("span", { class: "chev", "aria-hidden": "true" }, "›")),
    h("div", { class: "meta" }, [info, machine.clientVersion ? "v" + machine.clientVersion : "", "seen " + ago(machine.lastHeartbeatAt)].filter(Boolean).join(" · ")),
    machine.agents.length ? h("div", { class: "foot" }, machine.agents.map(agentChip)) : null,
    h("div", { class: "foot" },
      h("span", { class: "pill " + (machine.sessions.active ? "busy" : "idle") }, machine.sessions.total + " session" + (machine.sessions.total === 1 ? "" : "s") + (machine.sessions.active ? " · " + machine.sessions.active + " active" : "")),
      h("span", { class: "pill " + proxy.tone, title: proxy.detail }, proxy.label)))
}

function machinesView() {
  const summary = h("div", { class: "summary" })
  const list = h("div", { class: "stack" })
  const status = h("div")
  const controller = {
    title: "Machines",
    banner: status,
    refreshMs: 10000,
    node: h("section", {}, h("h1", { class: "sr-only" }, "Machines"), status, summary, list),
    async load() {
      const data = await api("/api/v1/machines")
      const machines = data.machines
      summary.replaceChildren(
        stat("Machines", machines.length),
        stat("Online", machines.filter((m) => m.status === "online").length),
        stat("Active sessions", machines.reduce((sum, m) => sum + m.sessions.active, 0)))
      list.replaceChildren(...(machines.length ? machines.map(machineCard) : [
        h("div", { class: "empty" }, h("strong", {}, "No machines yet"), h("p", { class: "muted" }, "Run one command on a computer to add it to this hub."), h("a", { class: "btn primary", href: "#/enroll" }, "Add your first machine"))
      ]))
    }
  }
  return controller
}

function sessionCard(session, showMachine) {
  return h("div", { class: "card" },
    h("div", { class: "row" }, h("strong", { class: "grow" }, clip(session.title || "Untitled session", 140)), statusPill(session.status)),
    h("div", { class: "meta" }, [showMachine ? session.machineName : "", session.agentId, ago(session.updatedAt || session.lastSeenAt)].filter(Boolean).join(" · ")),
    session.directory ? h("div", { class: "mono muted small" }, session.directory) : null)
}

function logLine(entry, machineNames) {
  const labels = entry.labels || {}
  const level = labels.level || "info"
  return h("div", { class: "logline level-" + level + (labels.kind === "event" ? " kind-event" : "") },
    h("div", { class: "lmeta" },
      h("time", { datetime: new Date(entry.ts).toISOString() }, clock(entry.ts)),
      h("span", { class: "lvl" }, level),
      labels.source ? h("span", {}, labels.source) : null,
      labels.machine_id ? h("span", {}, (machineNames && machineNames[labels.machine_id]) || labels.machine || labels.machine_id) : null),
    h("div", { class: "lmsg" }, entry.line))
}

function machineView(id) {
  const status = h("div")
  const body = h("div")
  const controller = {
    title: "Machine",
    banner: status,
    refreshMs: 10000,
    node: h("section", {}, h("a", { class: "btn small ghost", href: "#/" }, "‹ Machines"), status, body),
    async load() {
      const [detail, logs] = await Promise.all([
        api("/api/v1/machines/" + encodeURIComponent(id)),
        api("/api/v1/logs?machine=" + encodeURIComponent(id) + "&since=6h&limit=40").catch((error) => ({ error }))
      ])
      const machine = detail.machine
      const proxy = proxyState(machine)
      document.title = machine.name + " · " + hub.name

      const renameInput = h("input", { id: "rename", value: machine.displayName || machine.name, maxlength: 128, "aria-label": "Machine name" })
      const rename = h("form", { hidden: true, class: "row", onsubmit: async (event) => {
        event.preventDefault()
        await api("/api/v1/machines/" + encodeURIComponent(id), { method: "PATCH", json: { displayName: renameInput.value } })
        controller.refresh()
      } }, h("div", { class: "grow" }, renameInput), h("button", { class: "btn primary small", type: "submit" }, "Save"))
      const confirmForget = h("div", { hidden: true, class: "card" },
        h("p", {}, "Forget " + machine.name + "? Its logs stay in Loki, but it must enroll again to reappear."),
        h("div", { class: "row wrap" },
          h("button", { class: "btn danger small", type: "button", onclick: async () => { await api("/api/v1/machines/" + encodeURIComponent(id), { method: "DELETE" }); location.hash = "#/" } }, "Forget machine"),
          h("button", { class: "btn small", type: "button", onclick: () => { confirmForget.hidden = true } }, "Cancel")))
      const probeButton = h("button", { class: "btn small", type: "button", onclick: async () => {
        probeButton.disabled = true
        probeButton.textContent = "Checking…"
        try { await api("/api/v1/machines/" + encodeURIComponent(id) + "/probe", { method: "POST" }) } finally { controller.refresh() }
      } }, "Check now")

      const facts = [
        ["Status", h("span", { class: "row" }, h("span", { class: "dot " + machine.status }), machine.status + " · seen " + ago(machine.lastHeartbeatAt))],
        ["Web UI", h("span", {}, h("span", { class: "pill " + proxy.tone }, proxy.label), h("div", { class: "small muted" }, proxy.detail))],
        ["Machine ID", h("span", { class: "mono" }, machine.id)],
        ["Host", [machine.hostname, machine.platform, machine.arch].filter(Boolean).join(" · ") || "unknown"],
        ["Software", [machine.clientVersion ? "Harness Remote " + machine.clientVersion : "", machine.nodeVersion ? "Node " + machine.nodeVersion : ""].filter(Boolean).join(" · ") || "unknown"],
        ["Addresses", machine.endpoints.length ? h("span", {}, machine.endpoints.map((endpoint) => h("div", { class: "mono" }, endpoint + (endpoint === machine.proxy.endpoint ? "  ✓" : "")))) : "none advertised"],
        ["First seen", ago(machine.firstSeenAt)]
      ]

      body.replaceChildren(
        h("div", { class: "row wrap" },
          h("h1", { class: "grow" }, machine.name),
          h("button", { class: "btn small", type: "button", onclick: () => { rename.hidden = !rename.hidden; if (!rename.hidden) renameInput.focus() } }, "Rename"),
          proxy.tone === "ok" ? h("a", { class: "btn primary small", href: "/" }, "Open workspace") : null),
        rename,
        h("div", { class: "card", style: undefined },
          h("dl", { class: "kv" }, facts.map(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]))),
        h("div", { class: "row wrap", }, proxy.tone === "off" ? null : probeButton),
        h("h2", {}, "Agents"),
        machine.agents.length ? h("div", { class: "card foot" }, machine.agents.map(agentChip)) : h("p", { class: "muted" }, "No agents reported yet."),
        h("h2", {}, "Sessions (" + machine.sessions.total + ")"),
        h("div", { class: "stack" }, detail.sessions.length ? detail.sessions.slice(0, 30).map((session) => sessionCard(session, false)) : [h("p", { class: "muted" }, "No sessions reported. Only agents that are already running are inventoried, so idle harnesses stay asleep.")]),
        h("h2", {}, "Recent logs"),
        logs.error
          ? h("p", { class: "muted" }, logs.error.status === 501 ? "Log collection is not enabled on this hub." : "Logs are unavailable: " + logs.error.message)
          : logs.entries.length
            ? h("div", { class: "loglist" }, logs.entries.map((entry) => logLine(entry)))
            : h("p", { class: "muted" }, "No logs from this machine in the last 6 hours."),
        logs.error ? null : h("p", {}, h("a", { class: "btn small", href: "#/logs" }, "Open the log viewer")),
        h("h2", {}, "Configuration"),
        h("details", { class: "card" }, h("summary", {}, "Reported configuration"), h("pre", { class: "code" }, pretty(machine.config))),
        detail.configHistory.length > 1
          ? h("details", { class: "card" }, h("summary", {}, "Configuration history (" + detail.configHistory.length + ")"),
            h("div", { class: "stack" }, detail.configHistory.map((entry) => h("div", {}, h("div", { class: "small muted" }, ago(entry.changedAt)), h("pre", { class: "code" }, pretty(entry.config))))))
          : null,
        h("h2", {}, "Danger zone"),
        h("button", { class: "btn danger", type: "button", onclick: () => { confirmForget.hidden = false } }, "Forget this machine"),
        confirmForget)
    }
  }
  return controller
}

// ---- sessions ------------------------------------------------------------------------------------

function sessionsView() {
  const status = h("div")
  const query = h("input", { id: "q", type: "search", placeholder: "Title or folder", enterkeyhint: "search", autocomplete: "off" })
  const stateFilter = h("select", { id: "state" }, [["", "Any status"], ["active", "Active"], ["waiting", "Needs attention"], ["idle", "Idle"]].map(([value, label]) => h("option", { value }, label)))
  const machineFilter = h("select", { id: "machine" }, h("option", { value: "" }, "All machines"))
  const list = h("div", { class: "stack" })
  let debounce = null
  const controller = {
    title: "Sessions",
    banner: status,
    refreshMs: 10000,
    node: h("section", {}, h("h1", { class: "sr-only" }, "Sessions"), status,
      h("div", { class: "filters" },
        h("div", { class: "field wide" }, h("label", { for: "q" }, "Search"), query),
        h("div", { class: "field" }, h("label", { for: "state" }, "Status"), stateFilter),
        h("div", { class: "field" }, h("label", { for: "machine" }, "Machine"), machineFilter)),
      list),
    async load() {
      const machines = (await api("/api/v1/machines")).machines
      const chosen = machineFilter.value
      machineFilter.replaceChildren(h("option", { value: "" }, "All machines"), ...machines.map((m) => h("option", { value: m.id }, m.name)))
      machineFilter.value = chosen
      const params = new URLSearchParams()
      if (query.value.trim()) params.set("q", query.value.trim())
      if (stateFilter.value) params.set("status", stateFilter.value)
      if (machineFilter.value) params.set("machine", machineFilter.value)
      params.set("limit", "100")
      const sessions = (await api("/api/v1/sessions?" + params)).sessions
      list.replaceChildren(...(sessions.length ? sessions.map((s) => sessionCard(s, true)) : [h("div", { class: "empty" }, h("strong", {}, "No sessions match"), h("p", { class: "muted" }, "Sessions appear once a machine reports them."))]))
    }
  }
  const reload = () => controller.refresh && controller.refresh()
  query.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(reload, 250) })
  stateFilter.addEventListener("change", reload)
  machineFilter.addEventListener("change", reload)
  return controller
}

// ---- logs ----------------------------------------------------------------------------------------

function logsView() {
  const status = h("div")
  const machineSelect = h("select", { id: "lmachine" }, h("option", { value: "" }, "All machines"))
  const levelSelect = h("select", { id: "llevel" }, [["", "Any level"], ["error", "Errors"], ["warn", "Warnings"], ["info", "Info"]].map(([value, label]) => h("option", { value }, label)))
  const kindSelect = h("select", { id: "lkind" }, [["", "Logs and events"], ["log", "Logs only"], ["event", "Events only"]].map(([value, label]) => h("option", { value }, label)))
  const rangeSelect = h("select", { id: "lrange" }, [["15m", "Last 15 minutes"], ["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"]].map(([value, label]) => h("option", { value }, label)))
  rangeSelect.value = "1h"
  const search = h("input", { id: "lq", type: "search", placeholder: "Contains…", enterkeyhint: "search", autocomplete: "off" })
  const live = h("input", { id: "live", type: "checkbox" })
  const list = h("div", { class: "loglist" })
  const note = h("p", { class: "muted small", "aria-live": "polite" })
  let names = {}
  let debounce = null
  const controller = {
    title: "Logs",
    banner: status,
    node: h("section", {}, h("h1", { class: "sr-only" }, "Logs"), status,
      h("div", { class: "filters" },
        h("div", { class: "field" }, h("label", { for: "lmachine" }, "Machine"), machineSelect),
        h("div", { class: "field" }, h("label", { for: "llevel" }, "Level"), levelSelect),
        h("div", { class: "field" }, h("label", { for: "lkind" }, "Type"), kindSelect),
        h("div", { class: "field" }, h("label", { for: "lrange" }, "Range"), rangeSelect),
        h("div", { class: "field wide" }, h("label", { for: "lq" }, "Search"), search),
        h("label", { class: "switch wide", for: "live" }, live, "Live (refresh every 3 s)")),
      note, list),
    async load() {
      if (!machineSelect.dataset.filled) {
        const machines = (await api("/api/v1/machines")).machines
        names = Object.fromEntries(machines.map((m) => [m.id, m.name]))
        machineSelect.replaceChildren(h("option", { value: "" }, "All machines"), ...machines.map((m) => h("option", { value: m.id }, m.name)))
        machineSelect.dataset.filled = "1"
      }
      const params = new URLSearchParams({ since: rangeSelect.value, limit: "300" })
      if (machineSelect.value) params.set("machine", machineSelect.value)
      if (levelSelect.value) params.set("level", levelSelect.value)
      if (kindSelect.value) params.set("kind", kindSelect.value)
      if (search.value.trim()) params.set("q", search.value.trim())
      let data
      try {
        data = await api("/api/v1/logs?" + params)
      } catch (error) {
        if (error.status === 501) {
          note.textContent = "Log collection is not enabled on this hub (HUB_LOKI_URL is not set)."
          list.replaceChildren()
          return
        }
        throw error
      }
      note.textContent = data.entries.length ? "Showing the newest " + data.entries.length + " lines." : "No log lines match."
      list.replaceChildren(...data.entries.map((entry) => logLine(entry, names)))
    }
  }
  const reload = () => controller.refresh && controller.refresh()
  for (const control of [machineSelect, levelSelect, kindSelect, rangeSelect]) control.addEventListener("change", reload)
  search.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(reload, 300) })
  live.addEventListener("change", () => {
    stopTimer()
    if (live.checked) timer = setInterval(() => { if (document.visibilityState === "visible") reload() }, 3000)
  })
  return controller
}

// ---- add machine ---------------------------------------------------------------------------------

function enrollView() {
  const status = h("div")
  const label = h("input", { id: "tlabel", value: "New machine", maxlength: 100, autocomplete: "off" })
  const expiry = h("select", { id: "texpiry" }, [["24", "Expires in 24 hours"], ["168", "Expires in 7 days"], ["", "Never expires"]].map(([value, text]) => h("option", { value }, text)))
  const created = h("div")
  const tokens = h("div", { class: "stack" })
  const staticNote = h("p", { class: "muted small", hidden: true })
  const create = h("button", { class: "btn primary", type: "submit" }, "Create token")
  const controller = {
    title: "Add machine",
    banner: status,
    node: h("section", { class: "stack" }, h("h1", {}, "Add a machine"),
      h("p", { class: "muted" }, "On the computer you want to add, install Node.js 20+ and at least one supported agent CLI, then run the command this page gives you. It appears here within a minute."),
      h("form", { class: "card stack", onsubmit: async (event) => {
        event.preventDefault()
        create.disabled = true
        try {
          const hours = expiry.value === "" ? null : Number(expiry.value)
          const token = await api("/api/v1/enrollment-tokens", { method: "POST", json: { label: label.value.trim() || "New machine", expiresInHours: hours } })
          showCreated(token)
          controller.refresh()
        } catch (error) {
          if (!(error instanceof AuthError)) created.replaceChildren(banner(error.message, "bad"))
        } finally {
          create.disabled = false
        }
      } },
        h("div", { class: "field" }, h("label", { for: "tlabel" }, "Name this token (so you can revoke it later)"), label),
        h("div", { class: "field" }, h("label", { for: "texpiry" }, "Lifetime"), expiry),
        create),
      created,
      h("h2", {}, "Active tokens"), tokens, staticNote),
    async load() {
      const data = await api("/api/v1/enrollment-tokens")
      staticNote.hidden = !data.staticToken
      staticNote.textContent = "This hub also accepts the HUB_ENROLLMENT_TOKEN from its own environment; it is not listed here."
      const live = data.tokens.filter((token) => !token.revokedAt)
      tokens.replaceChildren(...(live.length ? live.map(tokenRow) : [h("p", { class: "muted" }, "No tokens yet.")]))
    }
  }

  function showCreated(token) {
    const commands = installCommands({ installCommand: hub.installCommand, publicUrl: hub.publicUrl, token: token.token })
    const block = (title, text) => h("div", { class: "stack" }, h("div", { class: "row" }, h("strong", { class: "grow" }, title), copyButton(() => text)), h("pre", { class: "cmd", tabindex: "0" }, text))
    created.replaceChildren(h("div", { class: "card stack", role: "status" },
      h("strong", {}, "Token created: " + token.label),
      h("p", { class: "small muted" }, "This is the only time the token is shown. Run one of these on the new machine and keep that terminal open."),
      block("macOS / Linux", commands.posix),
      block("Windows PowerShell", commands.powershell),
      hub.publicUrl.indexOf("http://") === 0 ? banner("This hub is reached over plain http, so the token and the machine's gateway password travel unencrypted. Use it only on a network you trust, or put the hub behind HTTPS.") : null))
  }

  function tokenRow(token) {
    const revoke = h("button", { class: "btn danger small", type: "button", onclick: async () => {
      revoke.disabled = true
      await api("/api/v1/enrollment-tokens/" + encodeURIComponent(token.id), { method: "DELETE" })
      controller.refresh()
    } }, "Revoke")
    return h("div", { class: "card" },
      h("div", { class: "row wrap" }, h("strong", { class: "grow" }, token.label), revoke),
      h("div", { class: "meta" }, ["created " + ago(token.createdAt), "used " + token.useCount + "×", token.expiresAt ? (Date.parse(token.expiresAt) < Date.now() ? "expired" : "expires " + new Date(token.expiresAt).toLocaleString()) : "no expiry"].join(" · ")))
  }
  return controller
}

const VIEWS = {
  machines: machinesView,
  machine: (route) => machineView(route.id),
  sessions: sessionsView,
  logs: logsView,
  enroll: enrollView
}

// ---- boot ----------------------------------------------------------------------------------------

async function start() {
  try {
    const boot = await api("/api/v1/bootstrap")
    if (!boot.authenticated) {
      hub.name = boot.name || hub.name
      showLogin()
      return
    }
    hub = { name: boot.name, publicUrl: boot.publicUrl, installCommand: boot.installCommand || hub.installCommand }
    // The web app sends people here to sign in and asks to be returned to.
    const next = safeNext(location.search)
    if (next) {
      location.replace(next)
      return
    }
  } catch (error) {
    if (error instanceof AuthError) return
    app.replaceChildren(errorBox(error, start))
    return
  }
  showShell()
  await show()
}

start()
