import { readFileSync } from "node:fs"

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid hub configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
    this.name = "ConfigError"
    this.problems = problems
  }
}

const MIN_ADMIN_PASSWORD = 12
const MIN_SECRET_KEY = 32
const MIN_ENROLLMENT_TOKEN = 16

function truthy(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

/**
 * Secrets may come from a file (`HUB_ADMIN_PASSWORD_FILE=/run/secrets/x`) so they never have to sit in
 * `docker inspect` output. Only the trailing newline an editor or `echo` adds is stripped; a secret
 * with meaningful leading/trailing whitespace is the operator's own problem to avoid.
 */
function readValue(env, name, problems, readFile) {
  const direct = env[name]
  const file = env[`${name}_FILE`]
  if (direct !== undefined && file !== undefined) {
    problems.push(`Set either ${name} or ${name}_FILE, not both`)
    return undefined
  }
  if (file !== undefined) {
    try {
      return readFile(file, "utf8").replace(/\r?\n$/, "")
    } catch (error) {
      problems.push(`${name}_FILE could not be read: ${error.message}`)
      return undefined
    }
  }
  return direct === "" ? undefined : direct
}

function integer(env, name, fallback, { min, max }, problems) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`)
    return fallback
  }
  return value
}

function optionalUrl(env, name, problems) {
  const raw = env[name]
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
    return url.href.replace(/\/$/, "")
  } catch {
    problems.push(`${name} must be an http(s) URL`)
    return undefined
  }
}

/**
 * Everything the hub needs comes from the environment (twelve-factor), because it ships as a
 * container. All problems are reported together so a first `docker compose up` does not turn into a
 * fix-one-restart-fix-the-next loop.
 */
export function loadConfig(env = process.env, { readFile = readFileSync } = {}) {
  const problems = []
  const databaseUrl = readValue(env, "HUB_DATABASE_URL", problems, readFile)
  const adminPassword = readValue(env, "HUB_ADMIN_PASSWORD", problems, readFile)
  const secretKey = readValue(env, "HUB_SECRET_KEY", problems, readFile)
  const enrollmentToken = readValue(env, "HUB_ENROLLMENT_TOKEN", problems, readFile)

  if (!databaseUrl) problems.push("HUB_DATABASE_URL is required (postgres://user:password@host:5432/db)")
  if (!adminPassword) problems.push("HUB_ADMIN_PASSWORD is required")
  else if (adminPassword.length < MIN_ADMIN_PASSWORD) problems.push(`HUB_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD} characters`)
  if (!secretKey) problems.push("HUB_SECRET_KEY is required (generate one with: openssl rand -base64 32)")
  else if (secretKey.length < MIN_SECRET_KEY) problems.push(`HUB_SECRET_KEY must be at least ${MIN_SECRET_KEY} characters`)
  if (enrollmentToken !== undefined && enrollmentToken.length < MIN_ENROLLMENT_TOKEN) {
    problems.push(`HUB_ENROLLMENT_TOKEN must be at least ${MIN_ENROLLMENT_TOKEN} characters`)
  }

  const config = {
    name: env.HUB_NAME || "Harness Remote Hub",
    host: env.HUB_HOST || "0.0.0.0",
    port: integer(env, "HUB_PORT", 8080, { min: 1, max: 65_535 }, problems),
    databaseUrl,
    databaseSchema: env.HUB_DATABASE_SCHEMA || undefined,
    adminPassword,
    secretKey,
    enrollmentToken,
    lokiUrl: optionalUrl(env, "HUB_LOKI_URL", problems),
    publicUrl: optionalUrl(env, "HUB_PUBLIC_URL", problems),
    trustProxy: truthy(env.HUB_TRUST_PROXY),
    webDir: env.HUB_WEB_DIR || "./web",
    publicDir: env.HUB_PUBLIC_DIR || "./public",
    migrationsDir: env.HUB_MIGRATIONS_DIR || "./migrations",
    probeIntervalMs: integer(env, "HUB_PROBE_INTERVAL_MS", 30_000, { min: 1_000, max: 3_600_000 }, problems),
    offlineAfterMs: integer(env, "HUB_OFFLINE_AFTER_MS", 90_000, { min: 5_000, max: 86_400_000 }, problems),
    sessionTtlHours: integer(env, "HUB_SESSION_TTL_HOURS", 24 * 30, { min: 1, max: 24 * 365 }, problems),
    sessionRetentionDays: integer(env, "HUB_SESSION_RETENTION_DAYS", 90, { min: 1, max: 3650 }, problems),
    // Cap for a proxied request body. The machine bridge itself accepts 25MB (image attachments).
    proxyMaxBodyBytes: integer(env, "HUB_PROXY_MAX_BODY_BYTES", 30_000_000, { min: 1_024, max: 500_000_000 }, problems)
  }

  if (problems.length) throw new ConfigError(problems)
  return Object.freeze(config)
}
