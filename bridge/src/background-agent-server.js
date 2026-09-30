import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

// /v1/background-agents            GET list, POST start
// /v1/background-agents/:id        GET one, DELETE remove
// /v1/background-agents/:id/logs   GET recent terminal output
// /v1/background-agents/:id/stop   POST
// /v1/background-agents/:id/resume POST { prompt }  (continue a finished agent in the background)
const COLLECTION = "/v1/background-agents"
const ITEM = /^\/v1\/background-agents\/([^/]+)(?:\/(logs|stop|resume))?$/

const STATUS_BY_CODE = new Map([
  ["invalid_request", 400],
  ["unknown_agent", 404],
  ["agent_active", 409],
  ["agent_finished", 409],
  ["directory_not_allowed", 403],
  ["unsafe_command", 409],
  ["claude_not_found", 503],
  ["background_unavailable", 503],
  ["claude_timeout", 504]
])

function requestError(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 200_000) throw requestError("Request body is too large")
  }
  if (!body) return {}
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw requestError("Request body must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw requestError("Request body must be a JSON object")
  return parsed
}

export function backgroundAgentStatus(error) {
  return typeof error?.status === "number" ? error.status : STATUS_BY_CODE.get(error?.code) ?? 500
}

/**
 * Exposes the machine's Claude Code background agents. Like the other decorator servers it handles only
 * its own paths and hands everything else to `innerServer`, so it can sit anywhere in the chain.
 */
export function createBackgroundAgentServer({ innerServer, config, service, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const item = ITEM.exec(requestURL.pathname)
    if (requestURL.pathname !== COLLECTION && !item) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return

    const method = request.method ?? "GET"
    const allow = (methods) => {
      response.writeHead(405, { Allow: `${methods}, OPTIONS` })
      response.end()
    }
    try {
      if (!item) {
        if (method === "GET") {
          const all = requestURL.searchParams.get("all")
          const listed = await service.list({ all: all === null ? true : all !== "0" && all !== "false" })
          writeJSON(response, 200, listed)
          return
        }
        if (method === "POST") {
          writeJSON(response, 201, await service.start(await readJSONBody(request)))
          return
        }
        return allow("GET, POST")
      }

      let id
      try {
        id = decodeURIComponent(item[1])
      } catch {
        throw requestError("The background agent id is not valid")
      }
      const action = item[2]
      if (!action) {
        if (method === "GET") {
          const agent = await service.get(id)
          if (!agent) return writeJSON(response, 404, { error: `Unknown background agent: ${id}`, code: "unknown_agent" })
          writeJSON(response, 200, agent)
          return
        }
        if (method === "DELETE") {
          writeJSON(response, 200, await service.remove(id))
          return
        }
        return allow("GET, DELETE")
      }
      if (action === "logs") {
        if (method !== "GET") return allow("GET")
        writeJSON(response, 200, await service.logs(id))
        return
      }
      if (method !== "POST") return allow("POST")
      if (action === "stop") {
        writeJSON(response, 200, await service.stop(id))
        return
      }
      writeJSON(response, 200, await service.resume(id, await readJSONBody(request)))
    } catch (error) {
      writeJSON(response, backgroundAgentStatus(error), {
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {})
      })
    }
  })
}
