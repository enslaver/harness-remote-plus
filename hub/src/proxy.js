import http from "node:http"
import https from "node:https"
import { HttpError, BASE_HEADERS, sendJson } from "./http.js"
import { basicAuthorization } from "./prober.js"

/**
 * Same-origin reverse proxy: `/m/<machineId>/<anything>` -> `<verified endpoint>/<anything>`.
 *
 * Why it exists: an HTTPS page (which iOS needs for a service worker and a proper home-screen app)
 * cannot call `http://192.168.x.x` machines — browsers block that as mixed content — and every machine
 * would otherwise need `--cors` for the hub's origin plus its Basic credentials stored in the phone's
 * localStorage. Behind the proxy the browser talks to exactly one origin and holds only a session
 * cookie; the machine's credentials never leave the hub.
 *
 * The proxy is a transparent pipe, not an API: it does not interpret the machine protocol.
 */

// Only these request headers are forwarded. Anything else — Cookie above all — stays with the hub.
const FORWARD_REQUEST = ["accept", "content-type", "content-length", "x-harness-backend", "last-event-id"]
// Only these response headers come back. Never Set-Cookie, and never WWW-Authenticate (a 401 carrying
// it makes the browser throw up its native password dialog for a credential the user never had).
const FORWARD_RESPONSE = ["content-type", "content-length", "x-next-cursor", "x-has-more", "x-session-model", "etag", "last-modified"]

// Connecting is quick or it is not going to happen. Waiting for the *response* is a different matter: a
// machine legitimately takes a long time to answer the first request that wakes a sleeping harness
// (its ACP adapter may take up to 90 s to start), so the header wait is as generous as the idle limit.
const CONNECT_TIMEOUT_MS = 8_000
const IDLE_TIMEOUT_MS = 120_000

// Everything a machine sends back is served from the hub's own origin, next to the admin console and the
// admin's session cookie. `sandbox` gives such a response an opaque origin with no scripting, so a
// hostile machine returning `text/html` cannot run script as the admin; `default-src 'none'` stops it
// loading anything either. JSON and event streams are unaffected.
const PROXIED_RESPONSE_HEADERS = Object.freeze({ "Content-Security-Policy": "sandbox; default-src 'none'" })

const agents = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: 128 }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: 128 })
}

const PROXY_PATH = /^\/m\/([^/]+)(\/[^?]*)?$/

export function parseProxyPath(pathname) {
  const match = PROXY_PATH.exec(pathname)
  if (!match) return null
  let id
  try {
    id = decodeURIComponent(match[1])
  } catch {
    return null
  }
  return { id, rest: match[2] ?? "/" }
}

/**
 * Builds the upstream URL by concatenation onto the already-verified origin, then proves the result
 * did not leave it. `new URL("//evil.example/x", base)` would happily treat the path as a
 * network-path reference and hand the request (and the machine's credentials) to another host.
 */
export function upstreamUrl(endpoint, rest, search) {
  const base = new URL(endpoint)
  const target = new URL(`${base.origin}${rest}${search ?? ""}`)
  if (target.origin !== base.origin) throw new HttpError(400, "bad_path", "Path escapes the machine")
  return target
}

export function createMachineProxy({
  store,
  config,
  sink,
  prober,
  log = () => {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  headerTimeoutMs = IDLE_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS
}) {
  return async function proxy({ req, res, url, id, rest }) {
    const started = Date.now()
    const method = req.method ?? "GET"

    const target = await store.getMachine(id)
    if (!target) throw new HttpError(404, "unknown_machine", "Unknown machine")
    const credentials = target.proxy_enabled ? await store.machineCredentials(id) : null
    if (!credentials) {
      throw new HttpError(409, "proxy_disabled", "This machine did not share credentials with the hub, so it cannot be opened here")
    }

    // A verified address is only trusted while the last probe of it succeeded. After a failed probe the
    // address may belong to another device by now (a recycled DHCP lease), and this request would carry
    // the machine's credentials to it; prove the address again first.
    let endpoint = target.last_probe_ok === false ? null : target.verified_endpoint
    if (!endpoint) {
      // First use, right after an address change, or after a failed probe: prove the address now rather than make the user wait a cycle.
      const probe = await prober.probeMachine(id)
      if (!probe.ok) throw new HttpError(502, "machine_unreachable", `The hub cannot reach this machine: ${probe.error}`)
      endpoint = probe.endpoint
    }

    const upstream = upstreamUrl(endpoint, rest, url.search)
    const headers = { authorization: basicAuthorization(credentials), "accept-encoding": "identity" }
    for (const name of FORWARD_REQUEST) if (req.headers[name] !== undefined) headers[name] = req.headers[name]

    const declared = Number(req.headers["content-length"])
    if (Number.isFinite(declared) && declared > config.proxyMaxBodyBytes) {
      throw new HttpError(413, "payload_too_large", `Request body exceeds ${config.proxyMaxBodyBytes} bytes`)
    }

    const transport = upstream.protocol === "https:" ? https : http
    let upstreamReq
    let streaming = false
    let finished = false
    const audit = (status, extra = {}) => {
      if (finished) return
      finished = true
      // Routine polling reads are noise; record writes, failures and stream lifecycle.
      if (method === "GET" && status < 400 && !streaming) return
      void sink.proxyEvent(target, { method, path: upstream.pathname, status, ms: Date.now() - started, ...extra })
    }

    await new Promise((resolve) => {
      const fail = (status, code, message) => {
        if (res.headersSent) {
          res.destroy()
        } else {
          sendJson(res, status, { error: code, message })
        }
        audit(status, { error: code })
        resolve()
      }

      upstreamReq = transport.request(upstream, { method, headers, agent: agents[upstream.protocol] }, (upstreamRes) => {
        if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
          upstreamRes.resume()
          fail(502, "machine_auth_failed", "The machine rejected the credentials the hub holds for it. Restart its Harness Remote gateway so it registers again.")
          return
        }

        const type = String(upstreamRes.headers["content-type"] ?? "")
        streaming = type.startsWith("text/event-stream")
        // Connect timeout is over. A stream may sit silent between events; a plain response may not stall.
        upstreamReq.setTimeout(streaming ? 0 : idleTimeoutMs)
        const out = { ...BASE_HEADERS, ...PROXIED_RESPONSE_HEADERS, "Cache-Control": streaming ? "no-cache, no-transform" : "no-store" }
        for (const name of FORWARD_RESPONSE) {
          if (upstreamRes.headers[name] === undefined) continue
          // A stream has no length; forwarding one from a proxy that re-frames it would truncate it.
          if (streaming && name === "content-length") continue
          out[name] = upstreamRes.headers[name]
        }
        if (streaming) {
          out["X-Accel-Buffering"] = "no"
          req.socket.setTimeout(0)
          req.socket.setNoDelay(true)
        }
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        if (streaming) res.flushHeaders()
        upstreamRes.pipe(res)
        upstreamRes.on("error", () => res.destroy())
        upstreamRes.on("end", () => { audit(upstreamRes.statusCode ?? 0); resolve() })
        res.on("close", () => {
          upstreamRes.destroy()
          audit(upstreamRes.statusCode ?? 0, streaming ? { closed: "client" } : {})
          resolve()
        })
      })

      // Two different clocks: a short one while the connection is being made, then a long one for the
      // response. (`timeout` on the request options would apply one value to both and cut a slow
      // first response short at the connect limit.)
      upstreamReq.on("socket", (socket) => {
        if (socket.connecting) {
          upstreamReq.setTimeout(connectTimeoutMs)
          socket.once("connect", () => upstreamReq.setTimeout(headerTimeoutMs))
        } else {
          upstreamReq.setTimeout(headerTimeoutMs)
        }
      })
      upstreamReq.on("timeout", () => {
        upstreamReq.destroy()
        fail(504, "machine_timeout", "The machine did not answer in time")
      })
      upstreamReq.on("error", (error) => {
        if (res.writableEnded || finished) return resolve()
        if (res.destroyed) {
          // The browser went away first (a fetch aborted on unmount, an iOS tab suspended). The reset we
          // see is our own doing; recording it as a machine outage would fill the logs with false alarms.
          if (method !== "GET") audit(499, { closed: "client" })
          else finished = true
          return resolve()
        }
        log(`proxy to ${id} failed: ${error.code ?? error.message}`)
        fail(502, "machine_unreachable", `The hub cannot reach this machine (${error.code ?? "network error"})`)
      })

      // If the browser goes away mid-request there is nothing left to deliver.
      res.on("close", () => { if (!res.writableEnded) upstreamReq.destroy() })

      // Stream the body through, counting: a chunked upload declares no length up front.
      let received = 0
      req.on("data", (chunk) => {
        received += chunk.length
        if (received > config.proxyMaxBodyBytes) {
          req.unpipe(upstreamReq)
          upstreamReq.destroy()
          fail(413, "payload_too_large", `Request body exceeds ${config.proxyMaxBodyBytes} bytes`)
        }
      })
      req.pipe(upstreamReq)
    })
  }
}
