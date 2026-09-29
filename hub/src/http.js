export class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
    this.headers = headers
  }
}

/** Security headers that are safe for every response, SPA and API alike. */
export const BASE_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
})

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...headers
  })
  res.end(payload)
}

export function sendError(res, error) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message }, error.headers)
    return
  }
  sendJson(res, 500, { error: "internal_error", message: "Internal server error" })
}

export async function readBody(req, limitBytes) {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > limitBytes) throw new HttpError(413, "payload_too_large", `Request body exceeds ${limitBytes} bytes`)
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new HttpError(413, "payload_too_large", `Request body exceeds ${limitBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req, limitBytes = 256 * 1024) {
  const raw = await readBody(req, limitBytes)
  if (!raw.length) return {}
  try {
    const parsed = JSON.parse(raw.toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
    return parsed
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object")
  }
}

export function bearerToken(req) {
  const header = req.headers.authorization
  if (typeof header !== "string") return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}

export function parseCookies(header) {
  const cookies = {}
  if (typeof header !== "string") return cookies
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name || name in cookies) continue
    cookies[name] = part.slice(index + 1).trim()
  }
  return cookies
}

/**
 * The entry appended by the proxy that faces the hub, i.e. the LAST one. An appending proxy (nginx's
 * `$proxy_add_x_forwarded_for`) keeps whatever the client sent in front of its own entry, so the first
 * value is client-controlled and would let anyone rotate their apparent address to dodge the login and
 * enrollment throttles. `HUB_TRUST_PROXY` therefore means "exactly one trusted proxy hop".
 */
function lastForwarded(value) {
  if (typeof value !== "string") return ""
  const parts = value.split(",")
  return parts[parts.length - 1].trim()
}

/** Forwarded headers are attacker-controlled unless a trusted proxy sits in front, so honour them only on request. */
export function isSecureRequest(req, trustProxy) {
  if (req.socket?.encrypted) return true
  return trustProxy && lastForwarded(req.headers["x-forwarded-proto"]).toLowerCase() === "https"
}

export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = lastForwarded(req.headers["x-forwarded-for"])
    if (forwarded) return forwarded
  }
  return req.socket?.remoteAddress ?? "unknown"
}

export function requestHost(req, trustProxy) {
  return (trustProxy && lastForwarded(req.headers["x-forwarded-host"])) || req.headers.host || "localhost"
}

/** The URL machines and browsers should use to reach this hub. Configuration wins over inference. */
export function publicUrl(req, config) {
  if (config.publicUrl) return config.publicUrl
  return `${isSecureRequest(req, config.trustProxy) ? "https" : "http"}://${requestHost(req, config.trustProxy)}`
}

/**
 * Cookies are ambient authority, so a state-changing request that carries one must provably come from
 * this site. Browsers label every request with Sec-Fetch-Site; older ones at least send Origin on
 * unsafe methods. A request with neither is not a browser (curl, a script), and a script already has to
 * hold the cookie value to matter.
 */
export function isSameSiteRequest(req, config) {
  const site = req.headers["sec-fetch-site"]
  if (typeof site === "string") return site === "same-origin" || site === "none"
  const origin = req.headers.origin
  if (typeof origin !== "string") return true
  try {
    return new URL(origin).host === requestHost(req, config.trustProxy)
  } catch {
    return false
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
export function isSafeMethod(method) {
  return SAFE_METHODS.has(method)
}

/** `/api/v1/machines/:id` style routes, matched in registration order. */
export class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    const names = []
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === ":" ? char : `\\${char}`)).replace(/:([A-Za-z]+)/g, (_, name) => {
      names.push(name)
      return "([^/]+)"
    })
    this.routes.push({ method, regex: new RegExp(`^${source}$`), names, handler })
    return this
  }

  match(method, pathname) {
    let pathMatched = false
    for (const route of this.routes) {
      const found = route.regex.exec(pathname)
      if (!found) continue
      pathMatched = true
      if (route.method !== method) continue
      const params = {}
      for (const [index, name] of route.names.entries()) {
        try {
          params[name] = decodeURIComponent(found[index + 1])
        } catch {
          throw new HttpError(400, "bad_request", "Malformed URL parameter")
        }
      }
      return { handler: route.handler, params }
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed")
    return null
  }
}
