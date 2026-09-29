import http from "node:http"

/**
 * A stand-in for the hub's machine-facing API: enrollment, heartbeat and log ingest, with switches for
 * the ways a real hub misbehaves (revoked tokens, no Loki, overload, rate limiting).
 */
export async function startFakeHub({ enrollmentToken = "hre_test_enrollment_token_value" } = {}) {
  const calls = []
  const state = {
    enrollmentToken,
    tokens: new Set(),
    enrollStatus: 200,
    heartbeatStatus: 200,
    ingestStatus: 200,
    needCredentials: false,
    retryAfter: undefined,
    issued: 0
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString("utf8")
    const body = text ? JSON.parse(text) : undefined
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    const call = { method: req.method, path: req.url, bearer, body }
    calls.push(call)
    const reply = (status, payload, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...(state.retryAfter ? { "Retry-After": String(state.retryAfter) } : {}), ...headers })
      res.end(payload === undefined ? undefined : JSON.stringify(payload))
    }

    if (req.url === "/api/v1/machines/enroll") {
      if (state.enrollStatus !== 200) return reply(state.enrollStatus, { error: "nope" })
      if (bearer !== state.enrollmentToken) return reply(401, { error: "invalid_enrollment_token" })
      state.issued += 1
      const token = `hrm_fake_${state.issued}`
      state.tokens.add(token)
      return reply(200, { machineId: body.machine.id, token, heartbeatIntervalMs: 30_000 })
    }
    if (req.url === "/api/v1/machines/heartbeat") {
      if (!state.tokens.has(bearer)) return reply(401, { error: "invalid_token" })
      if (state.heartbeatStatus !== 200) return reply(state.heartbeatStatus, { error: "nope" })
      return reply(200, { ok: true, intervalMs: 30_000, needCredentials: state.needCredentials })
    }
    if (req.url === "/api/v1/ingest/logs") {
      if (!state.tokens.has(bearer)) return reply(401, { error: "invalid_token" })
      if (state.ingestStatus !== 200) return reply(state.ingestStatus, { error: "nope" })
      return reply(200, { accepted: body.entries.length })
    }
    reply(404, { error: "not_found" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    state,
    of: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),
    /** Lines the hub has accepted so far, in order. */
    shippedLines: () => calls.filter((call) => call.path.endsWith("/ingest/logs")).flatMap((call) => call.body.entries.map((entry) => entry.line)),
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

/** A writable that records what it is given, standing in for process.stdout/stderr. */
export function fakeStream() {
  return {
    out: "",
    write(chunk) {
      this.out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    }
  }
}
