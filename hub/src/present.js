/**
 * The single place that decides what a machine row looks like to a client. It is an allow-list on
 * purpose: `credentials_enc` and `token_hash` are simply never copied, so a future column cannot leak
 * by being added to `select *`.
 */

export function machineStatus(row, now, offlineAfterMs) {
  const last = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0
  return last && now - last < offlineAfterMs ? "online" : "offline"
}

export function publicMachine(row, { now = Date.now(), offlineAfterMs }) {
  return {
    id: row.id,
    name: row.display_name || row.name,
    reportedName: row.name,
    displayName: row.display_name ?? null,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    nodeVersion: row.node_version,
    clientVersion: row.client_version,
    status: machineStatus(row, now, offlineAfterMs),
    firstSeenAt: row.first_seen_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endpoints: row.endpoints,
    proxy: {
      enabled: Boolean(row.proxy_enabled),
      hasCredentials: Boolean(row.credentials_enc),
      reachable: row.last_probe_ok ?? null,
      endpoint: row.verified_endpoint,
      latencyMs: row.last_probe_ms,
      error: row.last_probe_error,
      checkedAt: row.last_probe_at
    },
    agents: row.agents,
    config: row.config,
    stats: row.stats,
    sessions: { total: row.session_total ?? 0, active: row.session_active ?? 0 }
  }
}

export function publicSession(row) {
  return {
    machineId: row.machine_id,
    machineName: row.machine_name,
    agentId: row.agent_id,
    id: row.session_id,
    title: row.title,
    directory: row.directory,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  }
}

/**
 * What the web app needs to add a hub-managed machine. `basePath` is where the hub proxies that
 * machine; credentials are deliberately absent because the hub authenticates the browser itself and
 * injects the machine's own credentials server-side.
 */
export function bootstrapMachine(row, options) {
  const machine = publicMachine(row, options)
  return {
    id: machine.id,
    name: machine.name,
    status: machine.status,
    basePath: `/m/${encodeURIComponent(machine.id)}`,
    proxyReady: machine.proxy.enabled && machine.proxy.hasCredentials && machine.proxy.reachable === true,
    agents: machine.agents.map((agent) => ({ id: agent.id, label: agent.label, state: agent.state }))
  }
}
