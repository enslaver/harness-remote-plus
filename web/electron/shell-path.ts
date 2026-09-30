import { spawn, type ChildProcess } from "node:child_process"
import { userInfo } from "node:os"
import { delimiter as platformPathDelimiter } from "node:path"

const PATH_START_MARKER = "__HARNESS_REMOTE_PATH_START__"
const PATH_END_MARKER = "__HARNESS_REMOTE_PATH_END__"
const DEFAULT_SHELL_TIMEOUT_MS = 2_000
const MAX_CAPTURED_STDOUT = 262_144

// Keep this command static. The shell is used only to materialize its exported environment; no user
// or repository-controlled value is interpolated into the command string. Reading PATH through env
// also avoids shell-specific list semantics (for example Fish exposes PATH internally as a list).
// Everything that is exported is read once, then PATH and the provider settings are picked out of it
// here, so nothing else the user has exported is ever kept.
const PRINT_ENVIRONMENT_COMMAND = `printf '${PATH_START_MARKER}\\n'; /usr/bin/env; printf '${PATH_END_MARKER}\\n'`

// A desktop app launched from the Dock or a menu does not inherit the variables a user exports in
// their shell profile, and those variables are how Claude Code is pointed at Bedrock, Vertex or a
// gateway, Codex at an OpenAI-compatible endpoint, and OpenCode at Bedrock or Azure. This is a
// deliberate allow-list of provider and network settings, not the whole environment. Session
// identity variables (CLAUDE_CODE_SESSION*, ...) are excluded on purpose.
const PROVIDER_ENVIRONMENT_NAME = new RegExp([
  "^ANTHROPIC_",
  "^CLAUDE_CODE_(?:USE|SKIP)_",
  "^CLAUDE_CONFIG_DIR$",
  "^AWS_",
  "^CLOUD_ML_REGION$",
  "^GOOGLE_(?:APPLICATION_CREDENTIALS|CLOUD_PROJECT|CLOUD_LOCATION|GENAI_USE_VERTEXAI)$",
  "^VERTEX_",
  "^OPENAI_",
  "^CODEX_",
  "^AZURE_",
  "^OPENROUTER_",
  "^OPENCODE_(?!SERVER_)",
  "^NODE_EXTRA_CA_CERTS$",
  "^(?:HTTPS?|NO|ALL)_PROXY$"
].join("|"), "i")

type ShellPathReader = (environment: NodeJS.ProcessEnv) => Promise<string | undefined>
type ShellEnvironmentReader = (environment: NodeJS.ProcessEnv) => Promise<Record<string, string>>

/**
 * The provider settings in a login shell's `env` output. A value that spans several lines (a
 * certificate, say) is dropped rather than kept truncated: an entry counts only when the next line
 * starts another variable or closes the block.
 */
export function parseLoginShellProviderEnvironment(output: string): Record<string, string> {
  const start = output.lastIndexOf(PATH_START_MARKER)
  if (start < 0) return {}
  const valueStart = start + PATH_START_MARKER.length
  const end = output.indexOf(PATH_END_MARKER, valueStart)
  if (end < 0) return {}
  const lines = output.slice(valueStart, end).split(/\r?\n/)
  const result: Record<string, string> = {}
  const startsVariable = (line: string | undefined) => line === undefined || line === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)
  lines.forEach((line, index) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || !PROVIDER_ENVIRONMENT_NAME.test(match[1]) || !match[2]) return
    if (!startsVariable(lines[index + 1])) return
    result[match[1]] = match[2]
  })
  return result
}

export function parseLoginShellPathOutput(output: string): string | undefined {
  const start = output.lastIndexOf(PATH_START_MARKER)
  if (start < 0) return undefined
  const valueStart = start + PATH_START_MARKER.length
  const end = output.indexOf(PATH_END_MARKER, valueStart)
  if (end < 0) return undefined
  const block = output.slice(valueStart, end)
  const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("PATH="))
  if (!pathLine) return undefined
  const value = pathLine.slice("PATH=".length)
  if (!value || /[\u0000\r\n]/.test(value)) return undefined
  return value
}

export function mergeExecutablePath(
  shellPath: string | undefined,
  processPath: string | undefined,
  delimiter: string = platformPathDelimiter
): string | undefined {
  const values: string[] = []
  const seen = new Set<string>()
  for (const source of [shellPath, processPath]) {
    if (!source) continue
    for (const entry of source.split(delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      values.push(entry)
    }
  }
  return values.length > 0 ? values.join(delimiter) : undefined
}

function loginShell(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  try {
    const configured = userInfo().shell
    if (configured) return configured
  } catch {
    // userInfo can fail in unusual sandbox/container setups; SHELL and the platform default remain.
  }
  return environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")
}

export async function readLoginShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; shell?: string } = {}
): Promise<string | undefined> {
  const output = await readLoginShellOutput(environment, options)
  return output === undefined ? undefined : parseLoginShellPathOutput(output)
}

/** The raw, marker-delimited `env` output of the user's login shell. */
export async function readLoginShellOutput(
  environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; shell?: string } = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  if (platform === "win32") return undefined
  const shell = options.shell || loginShell(environment, platform)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS

  return await new Promise<string | undefined>((resolve) => {
    let stdout = ""
    let settled = false
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child?.stdout?.removeAllListeners("data")
      child?.removeAllListeners("error")
      child?.removeAllListeners("exit")
      resolve(value)
    }

    try {
      child = spawn(shell, ["-ilc", PRINT_ENVIRONMENT_COMMAND], {
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      })
    } catch {
      finish()
      return
    }
    timer = setTimeout(() => {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL")
      finish()
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-MAX_CAPTURED_STDOUT)
    })
    child.once("error", () => finish())
    child.once("exit", (code) => finish(code === 0 ? stdout : undefined))
  })
}

export async function resolveDesktopRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform
    delimiter?: string
    readShellPath?: ShellPathReader
    readShellEnvironment?: ShellEnvironmentReader
  } = {}
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  const resolved = { ...environment }
  if (platform === "win32") return resolved

  let shellPath: string | undefined
  let shellProvider: Record<string, string> = {}
  try {
    if (options.readShellPath || options.readShellEnvironment) {
      shellPath = await (options.readShellPath ?? (async () => undefined))(environment)
      shellProvider = await (options.readShellEnvironment ?? (async () => ({})))(environment)
    } else {
      // One login shell answers both questions; starting a second would double the startup cost.
      const output = await readLoginShellOutput(environment, { platform })
      if (output !== undefined) {
        shellPath = parseLoginShellPathOutput(output)
        shellProvider = parseLoginShellProviderEnvironment(output)
      }
    }
  } catch {
    // Discovery is a reliability enhancement, never a startup dependency. The inherited PATH remains
    // usable for terminals, CI and machines whose shell startup is slow or intentionally unusual.
    return resolved
  }
  const mergedPath = mergeExecutablePath(shellPath, environment.PATH, options.delimiter)
  if (mergedPath) resolved.PATH = mergedPath
  // What the app was launched with wins; the shell only fills in what a GUI launch left out.
  for (const [name, value] of Object.entries(shellProvider)) {
    if (resolved[name] === undefined) resolved[name] = value
  }
  return resolved
}
