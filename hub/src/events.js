/**
 * The hub's own observations (machine lifecycle, Session status changes, proxied writes) go to Loki
 * next to the machines' logs, so one query shows "what did this machine print, and what happened
 * around it". Each record is one JSON line: greppable in Grafana, parseable with `| json`.
 */

export const nullSink = Object.freeze({
  async machineEvent() {},
  async sessionTransitions() {},
  async proxyEvent() {}
})

const LEVELS = [
  ["error", /\b(error|err|fatal|panic|exception|failed|failure|uncaught|unhandled)\b/i],
  ["warn", /\b(warn|warning|deprecated|retrying)\b/i]
]

/** Machines mostly ship raw terminal lines, which carry no level. A cheap guess beats no filter at all. */
export function detectLevel(line) {
  for (const [level, pattern] of LEVELS) if (pattern.test(line)) return level
  return "info"
}

function machineLabels(machine, extra = {}) {
  return {
    machine_id: machine?.id,
    machine: machine ? (machine.display_name || machine.name) : undefined,
    ...extra
  }
}

const json = (value) => JSON.stringify(value)

export class LokiSink {
  constructor({ loki, log = () => {}, now = () => Date.now() }) {
    this.loki = loki
    this.log = log
    this.now = now
    this.lastFailureLogAt = 0
  }

  /** The hub's own events are best-effort: losing one must never fail the request that caused it. */
  async #safely(streams) {
    try {
      await this.loki.push(streams)
    } catch (error) {
      if (this.now() - this.lastFailureLogAt > 60_000) {
        this.lastFailureLogAt = this.now()
        this.log(`could not write events to Loki: ${error.message}`)
      }
    }
  }

  async machineEvent(machine, type, detail = {}) {
    await this.#safely([{
      labels: { kind: "event", source: "hub", level: type.endsWith("failed") ? "warn" : "info", ...machineLabels(machine) },
      entries: [{ ts: this.now(), line: json({ type, ...detail }) }]
    }])
  }

  async sessionTransitions(machine, transitions) {
    await this.#safely([{
      labels: { kind: "event", source: "session", level: "info", ...machineLabels(machine) },
      entries: transitions.map((transition) => ({
        ts: this.now(),
        line: json({
          type: transition.type,
          agent: transition.session.agent_id,
          sessionId: transition.session.session_id,
          title: transition.session.title,
          directory: transition.session.directory,
          from: transition.from,
          to: transition.to
        })
      }))
    }])
  }

  async proxyEvent(machine, detail) {
    await this.#safely([{
      labels: { kind: "event", source: "proxy", level: detail.status >= 500 ? "warn" : "info", ...machineLabels(machine) },
      entries: [{ ts: this.now(), line: json(detail) }]
    }])
  }

  /** Machine logs are not best-effort: a failure propagates so the machine keeps its buffer and retries. */
  async ingestLogs(machine, entries) {
    const groups = new Map()
    for (const entry of entries) {
      const level = entry.level ?? detectLevel(entry.line)
      const key = `${entry.source}\u0000${entry.stream}\u0000${level}`
      if (!groups.has(key)) {
        groups.set(key, { labels: { kind: "log", source: entry.source, stream: entry.stream, level, ...machineLabels(machine) }, entries: [] })
      }
      groups.get(key).entries.push({ ts: entry.ts, line: entry.line })
    }
    await this.loki.push([...groups.values()])
    return entries.length
  }

  async clientLogs(entries) {
    const groups = new Map()
    for (const entry of entries) {
      if (!groups.has(entry.level)) groups.set(entry.level, { labels: { kind: "log", source: "web", stream: "client", level: entry.level }, entries: [] })
      groups.get(entry.level).entries.push({ ts: entry.ts, line: entry.line })
    }
    await this.loki.push([...groups.values()])
  }
}
