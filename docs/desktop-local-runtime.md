# Desktop local runtime

Harness Remote Plus Desktop owns the local embedded daemon for the machine on which the desktop app is running. Remote machines continue to use their own independently authoritative daemon/runtime.

## Executable discovery

GUI-launched applications on macOS and Linux can inherit a narrower `PATH` than the user's terminal. That can make an installed Codex, Claude, OpenCode, OMP or PI executable invisible to the embedded daemon even though it works from the user's shell.

Before each embedded-daemon start or retry, the desktop main process asks the user's login shell for its exported `PATH`. The command is static, bounded by a short timeout and delimited so shell startup output cannot be mistaken for the value. Only `PATH` is imported; the rest of the shell environment is ignored. The discovered directories are placed before, and merged with, the `PATH` already inherited by Electron.

If shell discovery fails or times out, startup continues with the inherited Electron environment. Windows keeps its native process environment and does not perform shell discovery.

This recovery is deliberately part of daemon start/retry rather than application startup, so a user can install or expose a harness and retry the local runtime without restarting Harness Remote Plus Desktop.

## Provider settings

On macOS and Linux the app reads your login shell once at start and imports `PATH` plus an allow-list of
provider and network variables (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*`, `OPENAI_*`, `AZURE_*`, proxies, ...),
so a Dock-launched app can reach Bedrock, Vertex or a gateway configured in your shell profile. Variables the app
was launched with take precedence. See [PROVIDERS.md](PROVIDERS.md).
