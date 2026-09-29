/**
 * Ships uncaught errors to the hub's log store, so "the app went blank on my phone" leaves evidence.
 *
 * It is inert unless a hub is present (`installClientErrorReporting` is only called then), it never
 * throws into the app, and it is rate limited: an error inside a render loop must not become a request
 * storm against the hub. Only the message, stack and a few environment facts are sent; the hub strips
 * query strings and scrubs anything secret-looking again on its side.
 */

export type ClientLogEntry = {
  level: "error" | "warn"
  message: string
  stack?: string
  url?: string
  userAgent?: string
  context?: Record<string, unknown>
}

type Sink = (entry: ClientLogEntry) => void
let sink: Sink | null = null

// Browser noise that is not a fault in the app.
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i, /AbortError/, /The operation was aborted/i, /Load failed$/i]

/** `name` matters: an aborted fetch rejects with message "aborted" / "signal is aborted without reason". */
export function isIgnorableClientError(message: string, name?: string): boolean {
  return name === "AbortError" || IGNORED.some((pattern) => pattern.test(message))
}

/** For code that catches an error but still wants it on record (the ErrorBoundary). No-op without a hub. */
export function reportClientError(error: unknown, context?: Record<string, unknown>): void {
  if (!sink) return
  const message = error instanceof Error ? error.message : String(error)
  if (isIgnorableClientError(message, error instanceof Error ? error.name : undefined)) return
  try {
    sink({ level: "error", message, stack: error instanceof Error ? error.stack : undefined, context })
  } catch {
    // Reporting must never be the thing that breaks.
  }
}

export type InstallOptions = {
  post: (entries: ClientLogEntry[]) => void
  target?: Pick<Window, "addEventListener" | "removeEventListener">
  now?: () => number
  maxPerMinute?: number
  environment?: () => Record<string, unknown>
}

export function installClientErrorReporting(options: InstallOptions): () => void {
  const target = options.target ?? window
  const now = options.now ?? (() => Date.now())
  const maxPerMinute = options.maxPerMinute ?? 5
  const sent: number[] = []
  const recent = new Map<string, number>()

  const emit: Sink = (entry) => {
    const time = now()
    while (sent.length && time - sent[0] > 60_000) sent.shift()
    if (sent.length >= maxPerMinute) return
    // The same error repeating (a render loop) is one report, not fifty.
    const key = `${entry.message}\u0000${entry.stack?.slice(0, 200) ?? ""}`
    const last = recent.get(key)
    if (last !== undefined && time - last < 30_000) return
    recent.set(key, time)
    if (recent.size > 50) recent.delete(recent.keys().next().value as string)
    sent.push(time)
    try {
      options.post([{ ...entry, context: { ...options.environment?.(), ...entry.context } }])
    } catch {
      // never throw into the app
    }
  }
  sink = emit

  const onError = (event: Event) => {
    const { message, error } = event as ErrorEvent
    const text = error instanceof Error ? error.message : message
    if (!text || isIgnorableClientError(text, error instanceof Error ? error.name : undefined)) return
    emit({ level: "error", message: text, stack: error instanceof Error ? error.stack : undefined })
  }
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason
    const text = reason instanceof Error ? reason.message : String(reason)
    if (!text || isIgnorableClientError(text, reason instanceof Error ? reason.name : undefined)) return
    emit({ level: "error", message: `Unhandled rejection: ${text}`, stack: reason instanceof Error ? reason.stack : undefined })
  }
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)

  return () => {
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
    if (sink === emit) sink = null
  }
}

/** The transport: a same-origin POST that survives the page being closed. */
export function postClientLogs(baseUrl: string): (entries: ClientLogEntry[]) => void {
  return (entries) => {
    const body = JSON.stringify({
      entries: entries.map((entry) => ({ ...entry, url: entry.url ?? location.href, userAgent: entry.userAgent ?? navigator.userAgent }))
    })
    void fetch(`${baseUrl}api/v1/client-logs`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body
    }).catch(() => {})
  }
}

export function clientEnvironment(): Record<string, unknown> {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  return { app: "web", viewport: `${innerWidth}x${innerHeight}`, standalone }
}
