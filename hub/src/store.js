/**
 * All SQL lives here so the HTTP layer never builds a query and the schema has one owner.
 * Every method takes plain, already-validated values (see validate.js).
 */

import { LIVE_ACTIVITIES, resolveActivity } from "./activity.js"

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export class Store {
  constructor(pool, secretbox) {
    this.pool = pool
    this.secretbox = secretbox
  }

  async ping() {
    await this.pool.query("select 1")
  }

  async close() {
    await this.pool.end()
  }

  async transaction(work) {
    const client = await this.pool.connect()
    try {
      await client.query("begin")
      const result = await work(client)
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  // ---- machines -----------------------------------------------------------------------------

  /**
   * Enrollment is idempotent per machine id: a re-install (or a machine that lost its hub.json)
   * enrolls again and simply receives a fresh token, invalidating the old one.
   */
  async enrollMachine({ info, endpoints, credentials, proxyEnabled, config, tokenHash, enrolledVia }) {
    const sealed = proxyEnabled && credentials ? this.secretbox.seal(JSON.stringify(credentials)) : null
    return this.transaction(async (client) => {
      const previous = await client.query("select config from machines where id = $1 for update", [info.id])
      const { rows } = await client.query(
        `insert into machines
           (id, name, hostname, platform, arch, node_version, client_version, endpoints, proxy_enabled,
            credentials_enc, config, token_hash, enrolled_via, last_heartbeat_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13, now())
         on conflict (id) do update set
           name = excluded.name, hostname = excluded.hostname, platform = excluded.platform, arch = excluded.arch,
           node_version = excluded.node_version, client_version = excluded.client_version,
           endpoints = excluded.endpoints, proxy_enabled = excluded.proxy_enabled,
           credentials_enc = excluded.credentials_enc, config = excluded.config,
           token_hash = excluded.token_hash, enrolled_via = excluded.enrolled_via,
           verified_endpoint = null, last_heartbeat_at = now(), updated_at = now()
         returning *`,
        [info.id, info.name, info.hostname, info.platform, info.arch, info.nodeVersion, info.clientVersion,
          JSON.stringify(endpoints), Boolean(proxyEnabled), sealed, JSON.stringify(config), tokenHash, enrolledVia]
      )
      if (!previous.rows[0] || stable(previous.rows[0].config) !== stable(config)) {
        await client.query("insert into machine_config_history (machine_id, config) values ($1, $2::jsonb)", [info.id, JSON.stringify(config)])
      }
      return rows[0]
    })
  }

  async machineByTokenHash(tokenHash) {
    const { rows } = await this.pool.query("select * from machines where token_hash = $1", [tokenHash])
    return rows[0]
  }

  /**
   * Applies one heartbeat and returns the Session transitions it caused, so the caller can emit them
   * as events. `credentials` is `undefined` to keep what is stored, an object to replace it.
   */
  async recordHeartbeat(machineId, { info, endpoints, credentials, proxyEnabled, config, agents, stats, sessions, sessionAgents = [] }) {
    return this.transaction(async (client) => {
      const current = (await client.query("select config, endpoints, verified_endpoint from machines where id = $1 for update", [machineId])).rows[0]
      if (!current) return null

      const sealed = credentials ? this.secretbox.seal(JSON.stringify(credentials)) : null
      const clearCredentials = proxyEnabled === false
      const verified = current.verified_endpoint && endpoints.includes(current.verified_endpoint) ? current.verified_endpoint : null
      await client.query(
        `update machines set
           name = coalesce($2, name), hostname = coalesce($3, hostname), platform = coalesce($4, platform),
           arch = coalesce($5, arch), node_version = coalesce($6, node_version), client_version = coalesce($7, client_version),
           endpoints = $8::jsonb, verified_endpoint = $9, config = $10::jsonb, agents = $11::jsonb, stats = $12::jsonb,
           proxy_enabled = case when $13::boolean is null then proxy_enabled else $13::boolean end,
           credentials_enc = case when $14::boolean then null when $15::bytea is not null then $15::bytea else credentials_enc end,
           last_heartbeat_at = now(), updated_at = now()
         where id = $1`,
        [machineId, info.name, info.hostname, info.platform, info.arch, info.nodeVersion, info.clientVersion,
          JSON.stringify(endpoints), verified, JSON.stringify(config), JSON.stringify(agents), JSON.stringify(stats),
          proxyEnabled ?? null, clearCredentials, sealed]
      )

      const configChanged = stable(current.config) !== stable(config)
      if (configChanged) {
        await client.query("insert into machine_config_history (machine_id, config) values ($1, $2::jsonb)", [machineId, JSON.stringify(config)])
      }
      const transitions = await this.upsertSessions(client, machineId, sessions)
      await this.markMissingSessions(client, machineId, sessionAgents, sessions)
      return { configChanged, transitions }
    })
  }

  async upsertSessions(client, machineId, sessions) {
    const unique = new Map()
    for (const session of sessions) unique.set(`${session.agent_id}\u0000${session.session_id}`, session)
    // Defaults for callers that predate kind/activity/detail; activity falls back to the harness's own status.
    const batch = [...unique.values()].map((session) => ({
      ...session,
      kind: session.kind ?? "session",
      detail: session.detail ?? "",
      activity: resolveActivity(session.activity, session.status)
    }))
    if (!batch.length) return []

    const agentIds = [...new Set(batch.map((session) => session.agent_id))]
    const existing = new Map(
      (await client.query("select agent_id, session_id, status from sessions where machine_id = $1 and agent_id = any($2::text[])", [machineId, agentIds]))
        .rows.map((row) => [`${row.agent_id}\u0000${row.session_id}`, row.status])
    )
    const transitions = []
    for (const session of batch) {
      const before = existing.get(`${session.agent_id}\u0000${session.session_id}`)
      if (before === undefined) transitions.push({ type: "session.created", session, from: null, to: session.status })
      else if (before !== session.status) transitions.push({ type: "session.status", session, from: before, to: session.status })
    }

    // started_at: the earliest start anyone has told us about (a harness that later reports an older creation
    //   time wins over "first seen"); a Session no harness dated starts when the hub first saw it.
    // last_ran_at: the later of the harness's last-activity time and the last moment the hub saw it WORKING
    //   (not merely waiting on a person: a Session blocked for three days has not run for three days), so a
    //   harness that reports no timestamps at all still has a usable "last ran".
    await client.query(
      `insert into sessions (machine_id, agent_id, session_id, title, directory, status, kind, activity, detail,
                             created_at, updated_at, started_at, last_ran_at, last_seen_at)
       select $1, t.agent_id, t.session_id, t.title, t.directory, t.status, t.kind, t.activity, t.detail,
              t.created_at, t.updated_at, coalesce(t.created_at, now()),
              greatest(t.updated_at, case when t.activity = any($3::text[]) then now() end), now()
       from jsonb_to_recordset($2::jsonb) as t(agent_id text, session_id text, title text, directory text, status text,
                                              kind text, activity text, detail text, created_at timestamptz, updated_at timestamptz)
       on conflict (machine_id, agent_id, session_id) do update set
         title = excluded.title, directory = excluded.directory, status = excluded.status,
         kind = excluded.kind, activity = excluded.activity, detail = excluded.detail,
         created_at = coalesce(excluded.created_at, sessions.created_at),
         updated_at = coalesce(excluded.updated_at, sessions.updated_at),
         started_at = least(sessions.started_at, excluded.created_at),
         last_ran_at = greatest(sessions.last_ran_at, excluded.updated_at, case when excluded.activity = any($3::text[]) then now() end),
         last_seen_at = now()`,
      [machineId, JSON.stringify(batch), ["working"]]
    )
    return transitions
  }

  /**
   * A Session the machine no longer lists (deleted, or removed on disk) is marked `gone` rather than left
   * showing its last status, which would keep a long-dead `busy` Session inflating the active count until
   * the retention sweep. Rows are kept for the retention window so the history stays inspectable.
   */
  async markMissingSessions(client, machineId, sessionAgents, sessions) {
    if (!sessionAgents.length) return
    await client.query(
      `update sessions set status = 'gone', activity = 'gone'
       where machine_id = $1 and agent_id = any($2::text[]) and activity <> 'gone'
         and not exists (
           select 1 from jsonb_to_recordset($3::jsonb) as t(agent_id text, session_id text)
           where t.agent_id = sessions.agent_id and t.session_id = sessions.session_id
         )`,
      [machineId, sessionAgents, JSON.stringify(sessions.map((session) => ({ agent_id: session.agent_id, session_id: session.session_id })))]
    )
  }

  async listMachines() {
    const { rows } = await this.pool.query(
      `select m.*, coalesce(s.total, 0) as session_total, coalesce(s.active, 0) as session_active
       from machines m
       left join (
         select machine_id, count(*)::int as total, count(*) filter (where activity = any($1::text[]))::int as active
         from sessions group by machine_id
       ) s on s.machine_id = m.id
       order by lower(coalesce(m.display_name, m.name)), m.id`,
      [LIVE_ACTIVITIES]
    )
    return rows
  }

  async getMachine(id) {
    return (await this.listMachines()).find((machine) => machine.id === id)
  }

  async configHistory(machineId, limit = 20) {
    const { rows } = await this.pool.query(
      "select config, changed_at from machine_config_history where machine_id = $1 order by changed_at desc, id desc limit $2",
      [machineId, limit]
    )
    return rows
  }

  async deleteMachine(id) {
    const { rowCount } = await this.pool.query("delete from machines where id = $1", [id])
    return rowCount > 0
  }

  async setDisplayName(id, displayName) {
    const { rowCount } = await this.pool.query("update machines set display_name = $2, updated_at = now() where id = $1", [id, displayName])
    return rowCount > 0
  }

  /** Decrypts on demand and only for the proxy/prober; no API response ever carries this. */
  async machineCredentials(id) {
    const { rows } = await this.pool.query("select credentials_enc from machines where id = $1", [id])
    const sealed = rows[0]?.credentials_enc
    if (!sealed) return null
    try {
      return JSON.parse(this.secretbox.open(sealed))
    } catch {
      // A rotated HUB_SECRET_KEY makes old ciphertext unreadable. Treat it as "no credentials" so the
      // machine looks unproxyable until its next heartbeat re-sends them, instead of crashing the loop.
      return null
    }
  }

  async proxyTargets() {
    const { rows } = await this.pool.query(
      "select id, endpoints, verified_endpoint from machines where proxy_enabled and credentials_enc is not null order by id"
    )
    return rows
  }

  async recordProbe(id, { ok, endpoint, ms, error }) {
    await this.pool.query(
      `update machines set
         last_probe_at = now(), last_probe_ok = $2, last_probe_ms = $3, last_probe_error = $4,
         verified_endpoint = case when $2 then $5 else verified_endpoint end
       where id = $1`,
      [id, ok, ok ? ms : null, ok ? null : String(error ?? "unreachable").slice(0, 300), endpoint ?? null]
    )
  }

  // ---- sessions -----------------------------------------------------------------------------

  async listSessions(filters = {}) {
    return (await this.searchSessions(filters)).rows
  }

  /**
   * The Session search: every filter is optional and ANDed. Times are compared as instants, so the
   * caller may pass either an ISO date or an age (see validate.js `parseWhen`). `total` counts every
   * match, not just the page, so a UI can say "showing 100 of 412".
   */
  async searchSessions({
    machineId, agentId, kind, status, activities, query,
    startedAfter, startedBefore, ranAfter, ranBefore,
    sort = "last_ran", limit = 100, offset = 0
  } = {}) {
    const where = []
    const values = []
    const add = (clause, value) => {
      values.push(value)
      where.push(clause.replace("?", `$${values.length}`))
    }
    if (machineId) add("s.machine_id = ?", machineId)
    if (agentId) add("s.agent_id = ?", agentId)
    if (kind) add("s.kind = ?", kind)
    // `status` is the harness's own word ("busy"); `active` is kept as shorthand for anything live right now.
    if (status === "active") add("s.activity = any(?::text[])", LIVE_ACTIVITIES)
    else if (status) add("s.status = ?", status)
    if (activities?.length) {
      const expanded = activities.flatMap((activity) => (activity === "active" ? LIVE_ACTIVITIES : [activity]))
      add("s.activity = any(?::text[])", expanded)
    }
    if (startedAfter) add("s.started_at >= ?", startedAfter)
    if (startedBefore) add("s.started_at < ?", startedBefore)
    if (ranAfter) add("s.last_ran_at >= ?", ranAfter)
    if (ranBefore) add("s.last_ran_at < ?", ranBefore)
    if (query) {
      // Escape LIKE wildcards so a search for "100%" or "a_b" matches literally.
      values.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`)
      const n = values.length
      where.push(`(s.title ilike $${n} or s.directory ilike $${n} or s.session_id ilike $${n} or s.agent_id ilike $${n} or coalesce(m.display_name, m.name) ilike $${n})`)
    }
    // Whitelisted, never interpolated from input.
    const order = sort === "started"
      ? "s.started_at desc, s.session_id"
      : "coalesce(s.last_ran_at, s.started_at) desc, s.session_id"
    values.push(Math.min(Math.max(limit, 1), 500))
    const limitParam = values.length
    values.push(Math.min(Math.max(offset, 0), 10_000))
    const { rows } = await this.pool.query(
      `select s.*, coalesce(m.display_name, m.name) as machine_name, count(*) over()::int as total_count
       from sessions s join machines m on m.id = s.machine_id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by ${order}
       limit $${limitParam} offset $${values.length}`,
      values
    )
    return { rows, total: rows[0]?.total_count ?? 0 }
  }

  async pruneSessions(retentionDays) {
    const { rowCount } = await this.pool.query(
      "delete from sessions where last_seen_at < now() - ($1::int * interval '1 day')",
      [retentionDays]
    )
    return rowCount
  }

  // ---- enrollment tokens --------------------------------------------------------------------

  async createEnrollmentToken({ label, tokenHash, expiresAt }) {
    const { rows } = await this.pool.query(
      "insert into enrollment_tokens (label, token_hash, expires_at) values ($1, $2, $3) returning id, label, created_at, expires_at, revoked_at, last_used_at, use_count",
      [label, tokenHash, expiresAt ?? null]
    )
    return rows[0]
  }

  async listEnrollmentTokens() {
    const { rows } = await this.pool.query(
      "select id, label, created_at, expires_at, revoked_at, last_used_at, use_count from enrollment_tokens order by created_at desc"
    )
    return rows
  }

  async revokeEnrollmentToken(id) {
    const { rowCount } = await this.pool.query("update enrollment_tokens set revoked_at = now() where id = $1 and revoked_at is null", [id])
    return rowCount > 0
  }

  /** Atomically validates and counts one use. Returns the token row, or undefined if not usable. */
  async consumeEnrollmentToken(tokenHash) {
    const { rows } = await this.pool.query(
      `update enrollment_tokens set last_used_at = now(), use_count = use_count + 1
       where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       returning id, label`,
      [tokenHash]
    )
    return rows[0]
  }

  async stats() {
    const { rows } = await this.pool.query(
      `select
         (select count(*)::int from machines) as machines,
         (select count(*)::int from sessions) as sessions,
         (select count(*)::int from sessions where activity = any($1::text[])) as active_sessions`,
      [LIVE_ACTIVITIES]
    )
    return rows[0]
  }
}
