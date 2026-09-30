# What Harness Remote Plus adds to Harness Remote

Harness Remote Plus is a fork of [giuliastro/harness-remote](https://github.com/giuliastro/harness-remote),
created by Giulio Ardoino and contributors. It tracks the upstream architecture (native Sessions stay
authoritative, the harness owns its own state) and adds the following. Everything else is upstream's work.

## The hub

A self-hosted server for people with more than one machine. See [HUB.md](HUB.md).

- Registry server with a Postgres schema, one-time enrollment tokens and heartbeats.
- A mobile-first admin console, served together with the web app.
- Log collection into Loki, a Grafana fleet dashboard, a same-origin proxy to each machine and a reachability
  prober.
- A Docker image and a Compose stack (hub, Postgres, Loki, Grafana, Caddy) with an `init-env.sh` that writes
  fresh secrets. CI runs the hub tests, an iPhone-profile browser smoke test and the Compose end-to-end test.

## The bridge

- `--hub <url> --hub-token <token>` (or `HARNESS_REMOTE_HUB_URL` / `HARNESS_REMOTE_HUB_TOKEN`): the machine
  enrolls once, remembers the hub, then reports its heartbeat, a Session inventory and redacted logs.
- Claude Code background agents (`claude --bg`): list, start, follow, stop, continue, remove. See
  [BACKGROUND_AGENTS.md](BACKGROUND_AGENTS.md).
- A shared activity vocabulary (working, needs input, idle, completed, failed, stopped) across all harnesses.
- Provider hardening, below.

## The web app

- Uses a hub's machine list, with path-prefixed machines and client error reports.
- iPhone Safari support, and a service worker that leaves live data alone.
- Session start and last-run times, search, time filters, and grouping by status, project, machine or agent.

## Provider hardening

Found by auditing every harness against its default provider and against custom endpoints (Bedrock, Vertex,
OpenAI-/Anthropic-compatible gateways). Details in [PROVIDERS.md](PROVIDERS.md).

| Area | Change |
| --- | --- |
| ACP handshake (Claude Code, Codex, OMP, PI) | Tries every advertised authentication method; if none is accepted the harness still starts, and a real credential problem is reported by `session/new` |
| Desktop app (macOS, Linux) | Imports an allow-list of provider and network variables from the login shell, in addition to `PATH` |
| Claude background agents | Model names accept Vertex ids, ARNs and gateway names (up to 256 characters); authentication failures are reported as `claude_unauthenticated` |
| Codex | Model ids behind a custom provider are split like the picker splits them; `CODEX_HOME` is honoured for history |
| OpenCode | A model from a provider missing from the inventory is left for OpenCode to resolve; a clearer message for an empty picker |
| Model variant probing | Budget scales with catalog size |
| Hub log shipping | The redactor also removes the values of provider credentials found in the environment |

## Rename

The project is now **Harness Remote Plus** (`harness-remote-plus`): the package, the CLI (`harness-remote-plus`,
`harness-remote-plus-daemon`), the desktop app's name, the web app's title, and the repository links.

Kept for compatibility with existing installs, and deliberately not renamed: the `harness-remote` and
`harness-remote-daemon` commands (still installed as aliases), the `HARNESS_REMOTE_*` environment variables, the
`~/.harness-remote` state directory, the desktop app's data directory and application id, browser storage keys,
the Loki `job="harness-remote"` label and the hub's key-derivation labels (changing those would invalidate
existing data). Historical release notes and archived planning documents are left as written.

## Credits

Upstream: [giuliastro/harness-remote](https://github.com/giuliastro/harness-remote), Apache-2.0. The commit
history of this repository contains the upstream authors' work.
