import http from "node:http"
import https from "node:https"

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/**
 * A small JSON-over-HTTP client on node:http. Not `fetch`: fetch refuses the WHATWG "bad ports" list
 * (6000, 6665-6669, 4045, ...), which a user can legitimately pick with `--port`, and it reports that
 * only as "fetch failed". It also never follows redirects here, so an Authorization header cannot be
 * carried to a different host.
 */
export function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === "https:" ? https : http
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8")
    const request = transport.request(target, {
      method,
      agent: false,
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        ...headers
      }
    }, (response) => {
      const chunks = []
      let size = 0
      response.on("data", (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) return request.destroy(new Error("Response is too large"))
        chunks.push(chunk)
      })
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let json
        try {
          json = text ? JSON.parse(text) : undefined
        } catch {
          json = undefined
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json, text })
      })
      response.on("error", reject)
    })
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })))
    request.on("error", reject)
    request.end(payload)
  })
}

/** `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`... beat a bare "fetch failed" in a log line. */
export function describeNetworkError(error) {
  return error?.code ? `${error.code}` : (error?.message ?? "network error")
}
