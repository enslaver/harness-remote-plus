/**
 * Minimal Loki client: push, query_range and readiness. No dependency, and no query language exposed
 * to callers. The HTTP layer hands us validated filter values; the LogQL is assembled here with every
 * value escaped, so a request can narrow a search but never widen it past the labels the hub owns.
 */

export class LokiError extends Error {
  constructor(message, { status, retryable }) {
    super(message)
    this.name = "LokiError"
    this.status = status
    this.retryable = retryable
  }
}

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export const JOB = "harness-remote"

export function sanitizeLabels(labels) {
  const result = {}
  for (const [name, value] of Object.entries(labels)) {
    if (value === undefined || value === null || value === "") continue
    if (!LABEL_NAME.test(name)) throw new Error(`Invalid Loki label name: ${name}`)
    result[name] = String(value).slice(0, 128)
  }
  return result
}

/** Escapes a value for use inside a double-quoted LogQL string. */
export function quoteLogQL(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`
}

const FILTERABLE = ["machine_id", "kind", "source", "level", "stream"]
const FILTER_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/

/** `{job="harness-remote",machine_id="..."} |= "text"` — only known labels, only safe values. */
export function buildQuery({ filters = {}, contains } = {}) {
  const matchers = [`job=${quoteLogQL(JOB)}`]
  for (const name of FILTERABLE) {
    const value = filters[name]
    if (value === undefined || value === null || value === "") continue
    if (typeof value !== "string" || !FILTER_VALUE.test(value)) throw new RangeError(`Invalid value for ${name}`)
    matchers.push(`${name}=${quoteLogQL(value)}`)
  }
  return `{${matchers.join(",")}}${contains ? ` |= ${quoteLogQL(contains)}` : ""}`
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Accepts an epoch-ms number/string or a relative duration such as `15m`, `2h`, `7d`. */
export function parseTime(value, now, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const text = String(value).trim()
  const relative = /^(\d{1,4})([smhd])$/.exec(text)
  if (relative) return now - Number(relative[1]) * UNIT_MS[relative[2]]
  if (/^\d{10,16}$/.test(text)) return Number(text)
  throw new RangeError(`Invalid time: ${text}`)
}

const nanos = (ms) => `${Math.trunc(ms)}000000`

export class LokiClient {
  constructor({ url, fetchImpl = fetch, timeoutMs = 8_000 }) {
    this.url = url.replace(/\/$/, "")
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async #request(path, init = {}) {
    let response
    try {
      response = await this.fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      throw new LokiError(`Loki is unreachable: ${error?.cause?.code ?? error?.message ?? "network error"}`, { status: 0, retryable: true })
    }
    if (response.ok) return response
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300)
    // 429 and 5xx are worth retrying; a 400 (bad or too-old sample) never gets better by repeating it.
    throw new LokiError(`Loki responded ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500
    })
  }

  async ready() {
    try {
      await this.#request("/ready")
      return true
    } catch {
      return false
    }
  }

  /**
   * `streams` is `[{ labels, entries: [{ ts (ms), line }] }]`. Entries are sorted per stream because
   * Loki rejects out-of-order writes beyond a small window.
   */
  async push(streams) {
    const payload = streams
      .filter((stream) => stream.entries.length)
      .map((stream) => ({
        stream: sanitizeLabels({ job: JOB, ...stream.labels }),
        values: [...stream.entries].sort((a, b) => a.ts - b.ts).map((entry) => [nanos(entry.ts), entry.line])
      }))
    if (!payload.length) return
    await this.#request("/loki/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streams: payload })
    })
  }

  /** Returns entries as `{ ts (ms), line, labels }`, ordered per `direction`. */
  async query({ filters, contains, start, end, limit = 200, direction = "backward" }) {
    const params = new URLSearchParams({
      query: buildQuery({ filters, contains }),
      start: nanos(start),
      end: nanos(end),
      limit: String(limit),
      direction: direction === "forward" ? "forward" : "backward"
    })
    const body = await (await this.#request(`/loki/api/v1/query_range?${params}`)).json()
    const forward = direction === "forward"
    const entries = []
    for (const stream of body?.data?.result ?? []) {
      for (const [ns, line] of stream.values ?? []) {
        entries.push({ order: BigInt(ns), ts: Number(BigInt(ns) / 1_000_000n), line, labels: publicLabels(stream.stream) })
      }
    }
    // Streams arrive grouped by label set; merge them into one timeline in the requested direction.
    entries.sort((a, b) => {
      const delta = a.order < b.order ? -1 : a.order > b.order ? 1 : 0
      return forward ? delta : -delta
    })
    return entries.slice(0, limit).map(({ ts, line, labels }) => ({ ts, line, labels }))
  }
}

/** Hide Loki's own bookkeeping labels (`service_name`, `detected_level`) from the UI. */
function publicLabels(labels = {}) {
  const { service_name: _service, detected_level: _detected, job: _job, ...rest } = labels
  return rest
}
