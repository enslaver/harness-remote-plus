#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigError, loadConfig } from "./config.js"
import { SecretBox, deriveKeys } from "./crypto.js"
import { createPool, migrate } from "./db.js"
import { createHub } from "./server.js"
import { Store } from "./store.js"

const log = (message) => process.stdout.write(`[hub] ${message}\n`)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
  // Relative directory settings resolve against the package root, not the process cwd.
  const resolved = { ...config, migrationsDir: path.resolve(root, config.migrationsDir) }

  const keys = deriveKeys(config.secretKey)
  const pool = createPool({ databaseUrl: config.databaseUrl, schema: config.databaseSchema })
  await migrate(pool, resolved.migrationsDir, { log })
  const store = new Store(pool, new SecretBox(keys.secretbox))

  const { server } = createHub({ config: resolved, store, keys })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, resolve)
  })
  log(`${config.name} listening on http://${config.host}:${config.port}`)

  const retention = setInterval(() => {
    store.pruneSessions(config.sessionRetentionDays).catch((error) => log(`session pruning failed: ${error.message}`))
  }, 6 * 3_600_000)
  retention.unref()

  let closing = false
  const shutdown = (signal) => {
    if (closing) return
    closing = true
    log(`${signal} received, shutting down`)
    clearInterval(retention)
    server.close(() => store.close().finally(() => process.exit(0)))
    server.closeAllConnections?.()
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((error) => {
  process.stderr.write(`[hub] fatal: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
