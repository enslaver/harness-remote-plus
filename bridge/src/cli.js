#!/usr/bin/env node
import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { parseConfig, usage } from "./config.js"
import { harnessProfile } from "./harness-profiles.js"
import { extractHubArgs } from "./hub-options.js"
import { prepareHubReporting } from "./hub-reporter.js"
import { loadMachineIdentity, MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
import { createBridgeServer } from "./server.js"

let config
let hubFlags
try {
  const extracted = extractHubArgs(process.argv.slice(2))
  hubFlags = extracted.flags
  config = parseConfig(extracted.rest)
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`)
  process.exitCode = 1
}

if (config?.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}

if (config) {
  const hub = await prepareHubReporting({ flags: hubFlags, config })
  const profile = harnessProfile(config.backend)
  const machineIdentity = await loadMachineIdentity(config.stateDirectory)
  const machineRegistry = new MachineRegistry(machineIdentity)
  machineRegistry.registerHost({
    id: profile.id,
    label: profile.label,
    backend: profile.id,
    transport: "acp",
    state: "configured",
    capabilities: profile.capabilities
  })

  const acp = trackAgentHostLifecycle(
    new AcpClient({ command: config.acpCommand, args: config.acpArgs, permissionMode: profile.permissionMode, preferredAuthMethod: profile.authMethod }),
    machineRegistry,
    profile.id
  )
  const server = createBridgeServer({
    config,
    acp,
    machineRegistry,
    serviceOptions: {
      snapshotDirectory: path.join(config.stateDirectory, profile.id),
      historyLoader: profile.historyLoader,
      preserveListedTimestamps: profile.preserveListedTimestamps,
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
      replaySettleMs: profile.replaySettleMs,
      promptSettleMs: profile.promptSettleMs
    }
  })
  let shuttingDown = false

  acp.on("stderr", (line) => process.stderr.write(`[${config.backend}] ${line}\n`))
  acp.on("permission", ({ optionId }) => {
    process.stderr.write(`[${config.backend}] granted tool permission (${optionId ?? "none offered"})\n`)
  })
  acp.on("agent-request", (message) => {
    process.stderr.write(`[${config.backend}] handled agent request: ${message.method}\n`)
  })
  acp.on("exit", (error) => {
    if (!shuttingDown) process.stderr.write(`[${config.backend}] ${error.message}\n`)
  })

  server.listen(config.port, config.host, () => {
    if (process.env.HARNESS_REMOTE_LAUNCHED_BY_LAUNCHER === "1") {
      process.stdout.write("\nHarness Remote is ready. Keep this terminal open while you use it.\n")
    } else {
      process.stdout.write(`${config.backend.toUpperCase()} bridge listening on http://${config.host}:${config.port}\n`)
      process.stdout.write(`Machine: ${machineIdentity.name} (${machineIdentity.id})\n`)
    }
    // Not awaited: the hub is optional, and enrolling over a slow network must not delay "ready".
    hub?.start({ identity: machineIdentity, snapshot: () => machineRegistry.snapshot(), scoped: false }).catch((error) => process.stderr.write(`[hub] ${error.message}\n`))
  })

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    acp.close()
    const finish = () => server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
    if (hub) hub.stop().then(finish, finish)
    else finish()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
