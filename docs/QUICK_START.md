# Harness Remote Plus quick start

Harness Remote Plus connects your clients to the computers where your repositories, coding-agent CLIs, credentials and native Sessions already live.

The normal setup is intentionally small:

- **Windows/macOS desktop:** open the app; the local computer is managed automatically.
- **Android:** start the gateway on the computer you want to control and scan its QR code.
- **Another remote computer:** run one Harness Remote Plus gateway on that computer.
- **Web/PWA:** connect to a reachable gateway and allow the browser origin with `--cors`.

## Windows and macOS: local machine needs no setup

Install and open the Harness Remote Plus desktop app.

For the computer where the desktop app is running, you do **not** need to start `harness-remote`, a bridge or a daemon in a terminal. The desktop app starts and supervises its own local Machine runtime and discovers the supported coding-agent CLIs installed on that computer.

If you want to control an additional computer, run the gateway on that other computer.

## Start a gateway on another machine

Requirements on the computer you want to control:

- Node.js 20+
- at least one supported coding-agent CLI installed and authenticated

Then run:

```bash
npx --yes github:enslaver/harness-remote-plus
```

Keep the terminal open while using that machine remotely.

The launcher automatically handles the normal setup:

- detects supported CLIs on `PATH`;
- chooses the compatible runtime;
- exposes the detected harnesses through the Machine connection when using the HR3 gateway path;
- starts managed OpenCode when appropriate;
- chooses available ports;
- generates authentication credentials;
- prints one compact connection summary;
- prints the short-lived Android pairing QR when using the HR3 Machine gateway path.

Supported CLIs are:

```text
codex
claude
opencode
omp
pi
```

You normally do not need to choose one manually.

## Android: scan and start

With the gateway running on the computer you want to control:

1. Open Harness Remote Plus on Android.
2. Open **Machines**.
3. Tap **Scan machine QR code**.
4. Scan the QR shown in the gateway terminal.
5. Tap **View sessions**.

That is the preferred mobile onboarding flow.

The QR contains a one-time 256-bit pairing token valid for five minutes. It does **not** contain the long-lived gateway password and can be claimed only once.

If QR pairing is unavailable, **Machines → Add machine** remains available as a fallback using the address and credentials printed by the gateway.

## Add another computer from desktop

The desktop app already manages its own local computer.

To add a different computer:

1. start the gateway on that remote computer;
2. open **Machines → Add machine** in the desktop app;
3. enter the address, username and password printed by the remote gateway.

You do not need to expose a separate endpoint for Codex, Claude, OpenCode, OMP and PI. One HR3 Machine gateway exposes the supported harnesses on that computer.

## Optional gateway parameters

The plain command is the recommended starting point:

```bash
npx --yes github:enslaver/harness-remote-plus
```

Only add options when you need to override the automatic behavior.

### Limit the Project roots

```bash
npx --yes github:enslaver/harness-remote-plus --root ~/dev
```

`--root` limits which directories Harness Remote Plus offers for Project selection. It is not an operating-system sandbox for the coding agents themselves.

### Use a fixed port

```bash
npx --yes github:enslaver/harness-remote-plus --port 4900
```

Without `--port`, Harness Remote Plus chooses an available port automatically.

### Use your own credentials

```bash
npx --yes github:enslaver/harness-remote-plus \
  --username harness \
  --password 'choose-a-strong-password'
```

Without these options, the launcher generates credentials automatically.

### Allow a browser origin

For local Vite development:

```bash
npx --yes github:enslaver/harness-remote-plus --cors http://localhost:5173
```

For the hosted client:

```bash
npx --yes github:enslaver/harness-remote-plus --cors https://giuliastro.github.io
```

`--cors` is needed only for browser/PWA access from that origin. Desktop and Android do not need it.

### Choose a compatibility backend manually

Usually unnecessary:

```bash
npx --yes github:enslaver/harness-remote-plus --backend codex
```

On a multi-agent Machine gateway this selects the internal ACP compatibility default; it does not hide the other detected harnesses from the client.

## Web / PWA

From a repository checkout:

```bash
cd web
npm ci
npm run dev
```

Start the gateway with the exact browser origin allowed:

```bash
npx --yes github:enslaver/harness-remote-plus --cors http://localhost:5173
```

Then open the URL printed by Vite, normally `http://localhost:5173`.

The upstream project's hosted web client (built from upstream, so without this fork's additions; this fork publishes no hosted copy) is:

```text
https://giuliastro.github.io/harness-remote/
```

For it, use:

```bash
npx --yes github:enslaver/harness-remote-plus --cors https://giuliastro.github.io
```

The gateway deliberately does not pretend to host the web UI itself; it prints connection information for the client.

Want one address for all your machines, including from an iPhone? Run the [hub](HUB.md): `docker compose up` serves the web app, keeps a registry of every install and collects their logs. Point a machine at it with `--hub https://hub.example.com --hub-token …`. On a tailnet, add `--hub-advertise-name <name> --hub-advertise-host <host>` (the port is detected); if the hub runs in Docker and the host is a MagicDNS name, enable the DNS override described in [HUB.md](HUB.md#machines-advertised-by-tailscale-name).

## Running from a local checkout

From the repository root, the equivalent launcher is:

```bash
npm install
npm start
```

Optional launcher arguments go after `--`:

```bash
npm start -- --root ~/dev
```

## What the automatic launcher does

The launcher inspects `PATH` without executing the detected coding-agent binaries.

With multiple supported CLIs and an ACP-backed harness available, it starts the HR3 Machine daemon automatically and exposes the detected harnesses through one Machine endpoint. Managed OpenCode stays on a loopback listener behind that gateway.

With a single detected harness, the launcher can preserve the compatible single-backend path. That compatibility behavior is why advanced/manual setups may not show exactly the same startup surface as the normal multi-agent HR3 gateway.

If you explicitly need the legacy single-backend path:

```bash
npx --yes github:enslaver/harness-remote-plus --single --backend codex
```

That is an advanced compatibility option, not the recommended onboarding path.

## Security

Use Harness Remote Plus over a trusted LAN or VPN.

Do **not** expose the gateway directly to the public internet.

Generated credentials protect the gateway boundary, but the coding agents still run with the operating-system permissions of the account that started them.

For backend-specific adapters, direct daemon invocation, legacy bridge commands and deeper troubleshooting, see [REFERENCE.md](../REFERENCE.md).
