<div align="center">

# Harness Remote Plus

### Your coding sessions. Any supported agent. Any device.

**A local-first control plane for native AI coding-agent sessions.**

Run, observe, resume and continue work across **Codex CLI, Claude Code, OpenCode, Oh My Pi and PI** from desktop, web or Android — while code, credentials and native Sessions stay on your own machines.

[![GitHub stars](https://img.shields.io/github/stars/enslaver/harness-remote-plus?style=flat&logo=github)](https://github.com/enslaver/harness-remote-plus/stargazers)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-555)](LICENSE)
[![Fork of harness-remote](https://img.shields.io/badge/fork%20of-giuliastro%2Fharness--remote-555?logo=github)](https://github.com/giuliastro/harness-remote)

</div>

![Harness Remote Plus workspace](docs/images/rhv3.png)

> **Harness Remote Plus is a fork of [Harness Remote](https://github.com/giuliastro/harness-remote) with enhancements.** The original project, its architecture and the great majority of this code were created by [Giulio Ardoino (@giuliastro)](https://github.com/giuliastro) and its contributors, and are used here under the Apache-2.0 license. Full credit for the foundation goes to them. See [What this fork adds](#what-this-fork-adds) and [Credits](#credits).

> **Harness Remote Plus is not another coding agent.** It is the remote-control and continuity layer around the coding agents you already use.

## Quick start

### Desktop

Download Harness Remote Plus from the [latest release](https://github.com/enslaver/harness-remote-plus/releases/latest) and open it.

On Windows and macOS, the local computer works immediately: **you do not need to start a gateway in a terminal**. The desktop app starts and supervises its local Machine runtime automatically.

### Add another computer

On the computer you want to control, install Node.js 20+ and make sure at least one supported coding-agent CLI is installed and authenticated.

Then run:

```bash
npx --yes github:enslaver/harness-remote-plus
```

Direct-from-GitHub fallback:

```bash
npx --yes github:enslaver/harness-remote-plus
```

Keep that terminal open. Harness Remote Plus automatically detects the installed coding agents, chooses available ports, generates credentials and starts one Machine gateway.

Common options are optional:

```bash
npx --yes github:enslaver/harness-remote-plus --root ~/dev
npx --yes github:enslaver/harness-remote-plus --port 4900
npx --yes github:enslaver/harness-remote-plus --cors https://giuliastro.github.io
```

### Android

Start the gateway on the computer you want to control, then:

1. Open **Machines**.
2. Tap **Scan machine QR code**.
3. Scan the QR printed by the gateway.
4. Tap **View sessions**.

The QR uses a short-lived one-time pairing token. Manual address/credential entry remains available as a fallback.

### Web / PWA

The easiest way to get the web app is the [hub](docs/HUB.md), which serves it (including an iPhone-friendly layout) from your own server. This fork does not publish a hosted copy. The upstream project hosts one at `https://giuliastro.github.io/harness-remote/`, which you can point at a gateway started with `--cors https://giuliastro.github.io`, but it is built from upstream and will not have this fork's additions.

For local web development:

```bash
cd web
npm ci
npm run dev
```

Then start the gateway with:

```bash
npx --yes github:enslaver/harness-remote-plus --cors http://localhost:5173
```

See the [Quick start guide](docs/QUICK_START.md) for advanced options and troubleshooting.

### Hub: one address for every machine (optional)

Run the **hub** on a home server or VPS and every computer you install can register with it. It hosts the web UI (including a layout that works on iPhone), keeps a Postgres registry of your machines and their Sessions, and sends each machine's logs to [Loki](https://grafana.com/oss/loki/).

```bash
./deploy/init-env.sh          # writes .env with fresh secrets
docker compose up -d --build  # hub + Postgres + Loki, on http://127.0.0.1:8080
```

Then, on each computer you want to add, use the command the hub console shows you:

```bash
npx --yes github:enslaver/harness-remote-plus --hub https://hub.example.com --hub-token hre_…
```

The hub URL is remembered, so the next `npx --yes github:enslaver/harness-remote-plus` reports again on its own. Machines stay in control of their own credentials; the hub proxies browser traffic to them and never hands the machine password to the browser. See [docs/HUB.md](docs/HUB.md) for HTTPS (needed for iPhone home-screen installs), Grafana, security and operations.

## What this fork adds

Everything in upstream Harness Remote works as before. On top of it, Harness Remote Plus adds:

- **A self-hosted [hub](docs/HUB.md)** — one address for every machine: web UI, a Postgres registry of machines and Sessions, log collection into Loki (with a Grafana fleet dashboard), a same-origin machine proxy and reachability prober. Ships as a Docker Compose stack behind Caddy.
- **`--hub` on the bridge** — a machine enrolls once with a token, then reports its heartbeat, an inventory of its Sessions and its redacted logs on its own.
- **iPhone Safari support** — a mobile-first hub console, an installable home-screen app and a service worker that never caches live data.
- **Session start and last-run times, search and time filters** — in the workspace and in the hub console.
- **Agent status and grouping** — every Session shows working / needs you / idle / completed / failed / stopped; group by status, project, machine or agent.
- **Claude Code background agents** — list, follow, start, stop, continue and remove `claude --bg` agents from any device. See [Background agents, status and grouping](docs/BACKGROUND_AGENTS.md).
- **Provider-agnostic harnesses** — validated against each harness's default provider and against custom endpoints (Amazon Bedrock, Google Vertex, and OpenAI-/Anthropic-compatible gateways), with hardening where they differed. See [Providers and custom endpoints](docs/PROVIDERS.md).

The full list, with the commits behind each item, is in [docs/FORK_CHANGES.md](docs/FORK_CHANGES.md).

## What it gives you

- **Native Sessions** — existing Sessions remain owned by Codex, Claude, OpenCode, OMP or PI.
- **Remote control** — follow activity, send prompts, Stop turns and handle supported questions/permissions.
- **Status at a glance and grouping** — every Session shows whether it is working, needs you, completed or failed; group the list by status, project, machine or agent, or see one recent feed across everything, with a time window. See [Background agents, status and grouping](docs/BACKGROUND_AGENTS.md).
- **Claude Code background agents** — see, follow, stop, continue and remove `claude --bg` agents from any device.
- **One workspace** — Machines → Projects → native Sessions.
- **Cross-agent continuation** — continue a task with another coding agent without pretending their hidden contexts are the same.
- **Cross-machine continuation** — continue work on another configured machine while preserving Project identity and lineage.
- **Model discovery** — models, defaults and variants come from the running harness instead of hardcoded assumptions.
- **Attention visibility** — questions, permissions and other blocking states stay visible even when the Session is not open.
- **Recovery** — reconnect, idle/wake and desktop-runtime recovery are built around the native Session as the source of truth.
- **Local-first operation** — repositories, credentials, subscriptions and native Session persistence stay on your machines.

## Native Sessions stay authoritative

Harness Remote Plus does not create a synthetic universal conversation model.

The coding agent still owns:

- transcript and message semantics;
- reasoning and activity;
- tool execution;
- questions and permissions;
- context, memory and compaction;
- model behavior;
- Stop/cancel and resume semantics.

Harness Remote Plus owns the layer around it:

- Machines and Projects;
- Session discovery and presentation;
- remote observation and control;
- capability/model discovery;
- continuation and lineage;
- reconciliation and diagnostics;
- desktop, web and Android access.

That means you can start in a normal CLI, open Harness Remote Plus later, find the same native Session and continue from there.

## Supported coding agents

| Coding agent | Integration |
| --- | --- |
| **OpenCode** | HTTP + live event stream |
| **Claude Code** | ACP adapter |
| **Codex CLI** | ACP adapter |
| **Oh My Pi (OMP)** | ACP adapter |
| **PI** | ACP adapter |

Harness Remote Plus surfaces capabilities advertised by the harness instead of inventing controls the harness does not support.

See the [capability matrix](docs/V3_HARNESS_CAPABILITY_MATRIX.md) for the detailed runtime contract.

## Continue work without copy/paste

A typical flow can be:

```text
Machine
  Project
    OpenCode Session
      └─ Continue with Codex
          └─ Continue with Claude
```

A continuation creates a real native Session on the target harness and records the relationship to the source Session.

The handoff can carry bounded, inspectable context such as objective, decisions, unresolved work and checks already run. The target harness owns its own context from that point forward.

The same model also works across configured machines, with Project identity checks and fail-closed behavior when the destination does not match.

## Local-first and security

Your machine keeps:

- source code and repositories;
- coding-agent CLIs;
- provider credentials and subscriptions;
- native Session persistence;
- the real development environment.

Use remote gateways over a trusted LAN or VPN. **Do not expose a Harness Remote Plus gateway directly to the public internet.**

`--root` limits which directories Harness Remote Plus offers for Project selection. It is not an operating-system sandbox; coding agents still run with the permissions of the account that launched them.

See [REFERENCE.md](REFERENCE.md) for security and backend details.

## Credits

**Harness Remote** was created by [Giulio Ardoino (@giuliastro)](https://github.com/giuliastro), with contributions from Michael Deinhardt, Baylar Sadigov, Andre Brait, Lucca Pinto, Gervaso, Joshua Trimm and others. This project is a fork of [giuliastro/harness-remote](https://github.com/giuliastro/harness-remote) and is distributed under the same [Apache-2.0 license](LICENSE); the original copyright and license terms are retained. If this project is useful to you, please star and support the original.

Harness Remote Plus is maintained by [@enslaver](https://github.com/enslaver). It is not affiliated with or endorsed by the upstream authors.

### Renaming note

The project is now called **Harness Remote Plus** (`harness-remote-plus`). For compatibility with existing installs, the old `harness-remote` and `harness-remote-daemon` commands still work, and the `HARNESS_REMOTE_*` environment variables, the `~/.harness-remote` state directory and the desktop app's data directory keep their original names.

## Development

```bash
# Gateway / daemon
npm start

# Bridge tests
npm test

# Web client
cd web
npm ci
npm run dev

# Electron desktop app
npm run electron:dev
```

## Documentation

- [Quick start](docs/QUICK_START.md)
- [What this fork adds](docs/FORK_CHANGES.md)
- [Providers and custom endpoints (Bedrock, Vertex, gateways)](docs/PROVIDERS.md)
- [Hub: Docker stack, registry and logs](docs/HUB.md)
- [Background agents, agent status and grouping](docs/BACKGROUND_AGENTS.md)
- [Architecture and roadmap](docs/HARNESS_3_ROADMAP.md)
- [Capability matrix](docs/V3_HARNESS_CAPABILITY_MATRIX.md)
- [OpenCode reliability contract](docs/OPENCODE_RELIABILITY_CONTRACT.md)
- [Backend reference](REFERENCE.md)
- [Contributing](CONTRIBUTING.md)

---

> **Keep ownership of your tools. Keep ownership of your Sessions. Change agents without losing the work.**

Apache-2.0
