import { safeEqual, signValue, verifySignedValue } from "./crypto.js"
import { isSecureRequest, parseCookies } from "./http.js"

export const SESSION_COOKIE = "hr_hub_session"
const REFRESH_AFTER_SECONDS = 24 * 3600

/**
 * Sliding-window limiter for anything an unauthenticated caller can guess at: the admin password and
 * enrollment tokens. In memory, per process: it exists to make online guessing impractical, not to
 * be a distributed rate limiter, and a restart forgiving the counters is harmless.
 */
export class AttemptThrottle {
  constructor({ max, windowMs, now = () => Date.now() }) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
    this.failures = new Map()
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs
    const recent = (this.failures.get(key) ?? []).filter((at) => at > cutoff)
    if (recent.length) this.failures.set(key, recent)
    else this.failures.delete(key)
    return recent
  }

  /** Seconds to wait, or 0 if the caller may try. */
  retryAfter(key) {
    const recent = this.#recent(key)
    if (recent.length < this.max) return 0
    return Math.max(1, Math.ceil((recent[0] + this.windowMs - this.now()) / 1000))
  }

  fail(key) {
    const recent = this.#recent(key)
    recent.push(this.now())
    this.failures.set(key, recent)
    // Bound memory against a spray of distinct keys.
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value)
  }

  succeed(key) {
    this.failures.delete(key)
  }
}

/**
 * One shared administrator. The session is a signed, stateless cookie: nothing to look up, nothing to
 * clean up, and rotating HUB_SECRET_KEY signs everyone out at once.
 */
export class AdminAuth {
  constructor({ config, keys, now = () => Date.now() }) {
    this.config = config
    this.key = keys.cookie
    this.now = now
  }

  verifyPassword(candidate) {
    return safeEqual(String(candidate ?? ""), this.config.adminPassword)
  }

  #cookie(req, value, maxAgeSeconds) {
    const attributes = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`]
    // Secure only over TLS: a Secure cookie set on plain-http LAN access is silently dropped by Safari,
    // which would look like "login does nothing".
    if (isSecureRequest(req, this.config.trustProxy)) attributes.push("Secure")
    return attributes.join("; ")
  }

  issue(req) {
    const iat = Math.floor(this.now() / 1000)
    const ttl = this.config.sessionTtlHours * 3600
    return this.#cookie(req, signValue(this.key, { v: 1, iat, exp: iat + ttl }), ttl)
  }

  clear(req) {
    return this.#cookie(req, "", 0)
  }

  /** Returns `{ refresh }` (a Set-Cookie value when the session is due for renewal) or null. */
  authenticate(req) {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    const session = verifySignedValue(this.key, value)
    const nowSeconds = Math.floor(this.now() / 1000)
    if (!session || session.v !== 1 || !Number.isFinite(session.exp) || session.exp <= nowSeconds) return null
    const refresh = nowSeconds - session.iat > REFRESH_AFTER_SECONDS ? this.issue(req) : null
    return { refresh }
  }
}
