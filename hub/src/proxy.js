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

const CONNECT_TIMEOUT_MS = 8_000
const IDLE_TIMEOUT_MS = 120_000

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

export function createMachineProxy({ store, config, sink, prober, log = () => {} }) {
  return async function proxy({ req, res, url, id, rest }) {
    const started = Date.now()
    const method = req.method ?? "GET"

    const target = await store.getMachine(id)
    if (!target) throw new HttpError(404, "unknown_machine", "Unknown machine")
    const credentials = target.proxy_enabled ? await store.machineCredentials(id) : null
    if (!credentials) {
      throw new HttpError(409, "proxy_disabled", "This machine did not share credentials with the hub, so it cannot be opened here")
    }

    let endpoint = target.verified_endpoint
    if (!endpoint) {
      // First use (or right after an address change): prove the address now rather than make the user wait a cycle.
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

      upstreamReq = transport.request(upstream, { method, headers, agent: agents[upstream.protocol], timeout: CONNECT_TIMEOUT_MS }, (upstreamRes) => {
        if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
          upstreamRes.resume()
          fail(502, "machine_auth_failed", "The machine rejected the credentials the hub holds for it. Restart its Harness Remote gateway so it registers again.")
          return
        }

        const type = String(upstreamRes.headers["content-type"] ?? "")
        streaming = type.startsWith("text/event-stream")
        // Connect timeout is over. A stream may sit silent between events; a plain response may not stall.
        upstreamReq.setTimeout(streaming ? 0 : IDLE_TIMEOUT_MS)
        const out = { ...BASE_HEADERS, "Cache-Control": streaming ? "no-cache, no-transform" : "no-store" }
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

      upstreamReq.on("timeout", () => {
        upstreamReq.destroy()
        fail(504, "machine_timeout", "The machine did not answer in time")
      })
      upstreamReq.on("error", (error) => {
        if (res.writableEnded || finished) return resolve()
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
