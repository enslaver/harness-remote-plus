/**
 * Copies what this process prints into a bounded queue, without changing what it prints.
 *
 * The daemon already reports everything worth knowing on stdout/stderr (`[codex] ...` from the agent
 * adapters, startup and error messages). Tapping the streams captures all of it, including the lines
 * written by code that predates the hub, without threading a logger through the bridge.
 *
 * Two rules keep this safe to leave on:
 *  - it is invisible: the original write still happens first, with its own return value;
 *  - it never blocks or throws into the caller, and the queue is bounded (oldest lines are dropped and
 *    counted) so a hub outage cannot grow memory without limit.
 *
 * Lines leave the machine, so they are scrubbed of anything that looks like a credential first.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const SOURCE_PREFIX = /^\[([A-Za-z0-9_-]{1,32})\]/

const PATTERNS = [
  [/(Authorization:\s*)(Basic|Bearer)\s+\S+/gi, "$1$2 [redacted]"],
  [/(--(?:password|hub-token)(?:=|\s+))\S+/gi, "$1[redacted]"],
  [/\b((?:HARNESS_REMOTE|OMP_BRIDGE)_(?:PASSWORD|HUB_TOKEN)=)\S+/g, "$1[redacted]"],
  [/\bhr[em]_[A-Za-z0-9_-]{20,}/g, "[redacted-hub-token]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted-github-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted-slack-token]"]
]

/** `secrets` are literal values (this gateway's password, the hub tokens) that must never be shipped verbatim. */
export function createRedactor(secrets = []) {
  const literals = secrets.filter((secret) => typeof secret === "string" && secret.length >= 6)
  return (line) => {
    let result = line
    for (const literal of literals) result = result.split(literal).join("[redacted]")
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement)
    return result
  }
}

export class LogTee {
  constructor({ redact = createRedactor(), maxLines = 5_000, now = () => Date.now(), flushPartialMs = 1_000 } = {}) {
    this.redact = redact
    this.maxLines = maxLines
    this.now = now
    this.flushPartialMs = flushPartialMs
    // Switched off when the hub says it will never store logs, so nothing is queued for nobody.
    this.enabled = true
    this.queue = []
    this.dropped = 0
    this.pending = new Map()
    this.patched = []
    this.timers = new Map()
  }

  get size() {
    return this.queue.length
  }

  /** Test seam and the single entry point for text: splits into lines and queues them. */
  ingest(stream, text) {
    const combined = (this.pending.get(stream) ?? "") + text
    const parts = combined.split(/\r?\n/)
    this.pending.set(stream, parts.pop() ?? "")
    for (const line of parts) this.#enqueue(stream, line)
    this.#schedulePartialFlush(stream)
  }

  #schedulePartialFlush(stream) {
    clearTimeout(this.timers.get(stream))
    if (!this.pending.get(stream)) return
    // A prompt or progress line with no newline should still ship eventually.
    const timer = setTimeout(() => this.flushPartial(stream), this.flushPartialMs)
    timer.unref?.()
    this.timers.set(stream, timer)
  }

  flushPartial(stream) {
    const rest = this.pending.get(stream)
    if (rest) this.#enqueue(stream, rest)
    this.pending.set(stream, "")
  }

  #enqueue(stream, raw) {
    if (!this.enabled) return
    const line = this.redact(raw.replace(ANSI, "")).trimEnd()
    if (!line.trim()) return
    if (this.queue.length >= this.maxLines) {
      this.queue.shift()
      this.dropped += 1
    }
    const source = SOURCE_PREFIX.exec(line)?.[1]?.toLowerCase()
    this.queue.push({ ts: this.now(), line, stream, source: source ?? "daemon" })
  }

  /** Removes and returns up to `max` of the oldest entries. */
  take(max) {
    return this.queue.splice(0, max)
  }

  /**
   * Puts a batch that could not be delivered back at the front. The bound is the same one ingest
   * applies: when over it, the oldest lines go and are counted, so the most recent output survives.
   */
  requeue(entries) {
    this.queue.unshift(...entries)
    const overflow = this.queue.length - this.maxLines
    if (overflow > 0) {
      this.queue.splice(0, overflow)
      this.dropped += overflow
    }
  }

  /**
   * Wraps `stream.write`. The original runs first and its result is returned untouched; the copy is
   * best-effort, and a failure in it is swallowed rather than allowed to break the caller's logging.
   */
  attach(stream, name) {
    const original = stream.write
    const tee = this
    stream.write = function write(chunk, ...rest) {
      const result = original.call(this, chunk, ...rest)
      try {
        tee.ingest(name, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      } catch {
        // never let observation break the thing being observed
      }
      return result
    }
    this.patched.push({ stream, original })
    return () => {
      if (stream.write !== original) stream.write = original
    }
  }

  detach() {
    for (const { stream, original } of this.patched) stream.write = original
    this.patched = []
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.flushPartial("stdout")
    this.flushPartial("stderr")
  }
}
