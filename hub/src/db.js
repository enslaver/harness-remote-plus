import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import pg from "pg"

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

// Postgres returns bigint/numeric as strings by default; nothing here stores values past 2^53, and a
// silent string in a JSON API is a worse surprise than a number.
pg.types.setTypeParser(20, (value) => Number(value))

export function createPool({ databaseUrl, schema }) {
  const options = { connectionString: databaseUrl, max: 10 }
  if (schema) {
    if (!IDENTIFIER.test(schema)) throw new Error("HUB_DATABASE_SCHEMA must be a lowercase identifier")
    // Lets several test suites share one database without seeing each other's rows.
    options.options = `-c search_path=${schema}`
  }
  return new pg.Pool(options)
}

/**
 * Forward-only SQL migrations: `migrations/NNN_name.sql`, applied in filename order, each in its own
 * transaction and recorded in `schema_migrations`. A session-level advisory lock serialises
 * concurrent starts (two hub replicas, or a restart racing a slow first boot) so nobody applies the
 * same file twice.
 */
export async function migrate(pool, directory, { log = () => {} } = {}) {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort()
  const client = await pool.connect()
  try {
    await client.query("select pg_advisory_lock(hashtext('harness-remote-hub:migrate'))")
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())")
    const applied = new Set((await client.query("select name from schema_migrations")).rows.map((row) => row.name))
    const ran = []
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(path.join(directory, file), "utf8")
      await client.query("begin")
      try {
        await client.query(sql)
        await client.query("insert into schema_migrations (name) values ($1)", [file])
        await client.query("commit")
      } catch (error) {
        await client.query("rollback").catch(() => {})
        throw new Error(`Migration ${file} failed: ${error.message}`)
      }
      log(`applied migration ${file}`)
      ran.push(file)
    }
    return ran
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('harness-remote-hub:migrate'))").catch(() => {})
    client.release()
  }
}
