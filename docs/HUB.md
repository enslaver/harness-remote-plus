# Harness Remote Plus Hub

A self-hosted server that gives all your Harness Remote Plus installs one home:

- **the web app**, served from one address, usable from an iPhone;
- **a registry of every machine** (Postgres): identity, addresses, agents, configuration and its history, and the
  native Sessions each machine reports;
- **all their logs** (Loki), searchable per machine, plus events the hub records itself (machines enrolling,
  Sessions changing status, writes made through the proxy);
- **one thing to point installs at**: `--hub https://hub.example.com` on any machine, once.

It is optional. A machine that is not pointed at a hub behaves exactly as before, and a hub outage never affects a
machine's own gateway.

```
   iPhone / browser ──HTTPS──▶  hub  ──┬──▶ Postgres   machines, sessions, configuration, tokens
   (session cookie only)     :8080     ├──▶ Loki       logs + events
                                       └──▶ machines   proxied web UI, over your LAN / VPN
                                                ▲
              npx --yes github:enslaver/harness-remote-plus --hub … ───────┘  enrolls once, then heartbeats and ships logs
```

## Quick start

Requires Docker with Compose v2.

```bash
git clone https://github.com/enslaver/harness-remote-plus && cd harness-remote-plus
sh deploy/init-env.sh              # writes .env with generated secrets and prints them once
docker compose up -d --build       # hub + Postgres + Loki
open http://localhost:8080         # sign in with the console password
```

`init-env.sh` never overwrites an existing `.env`. The stack is bound to `127.0.0.1` until you decide otherwise
(see [HTTPS for iPhone](#https-for-iphone)).

### Add a machine

On the computer you want to add (Node.js 20+ and at least one supported agent CLI installed), run the command the
console's **Add machine** page gives you. It looks like this:

```bash
HARNESS_REMOTE_HUB_TOKEN=hre_… npx --yes github:enslaver/harness-remote-plus --hub https://hub.example.com
```

The machine appears in the console within seconds. The hub address is remembered in the machine's state directory
(`~/.harness-remote/hub.json`, owner-only), so after the first run a bare `npx … harness-remote` reconnects on its
own. You can stop passing the token; the machine now holds its own per-machine token and the shared one can be
revoked.

| Option | Environment | Meaning |
| --- | --- | --- |
| `--hub <url>` | `HARNESS_REMOTE_HUB_URL` | Which hub to report to. |
| `--hub-token <token>` | `HARNESS_REMOTE_HUB_TOKEN` | Enrollment token. Prefer the environment: it stays out of `ps`. |
| `--hub-advertise-name <name>` | `HARNESS_REMOTE_HUB_ADVERTISE_NAME` | Display name (default: the hostname). `--hub-name` / `HARNESS_REMOTE_HUB_NAME` still work. |
| `--hub-advertise-host <host>` | `HARNESS_REMOTE_HUB_ADVERTISE_HOST` | Host the *hub* should use to reach this gateway, e.g. `jedi.tailnet.ts.net`; repeatable. The port is the gateway's own, detected automatically (`host:port` overrides it). Use it for a Tailscale/VPN name. Default: the machine's LAN addresses. |
| `--hub-advertise <url>` | `HARNESS_REMOTE_HUB_ADVERTISE` | Full address (scheme and port) for unusual setups. Invalid values are logged and ignored. |

The name and advertise host are saved with the enrollment, so a bare re-run keeps them:

```bash
HARNESS_REMOTE_HUB_TOKEN=hre_… npx --yes github:enslaver/harness-remote-plus \
  --hub https://hub.example.com --hub-advertise-name jedi --hub-advertise-host jedi.tailnet.ts.net
```
| `--hub-no-proxy` | `HARNESS_REMOTE_HUB_NO_PROXY=1` | Report to the hub but keep the gateway password on the machine. The hub then cannot open its web UI. |
| `--no-hub` | | Do not contact the hub this run. |

Not supported yet: the launcher's OpenCode-only single mode (`--single --backend opencode`) runs `opencode serve`
directly, with no Harness process to report from. It says so and continues without the hub.

## The desktop app

The desktop app has a **Configure hub** button in the top bar. Enter the hub's address (`host:port` or a URL) and the
enrollment token (`HUB_ENROLLMENT_TOKEN`); the app registers its local runtime with the hub, lists the hub's other
machines next to *This computer*, and shows a **Hub** link to the console. If this computer's runtime is already enrolled with a hub (it ran `--hub` once, or it is the hub's own host), the app follows that hub automatically and the form is not needed. If `HARNESS_REMOTE_HUB_URL` (and
`HARNESS_REMOTE_HUB_TOKEN`) are already set in the app's environment, the form is read-only and shows that. The token
stays in the app's main process and is saved owner-only in the app's settings directory.

### Machines advertised by Tailscale name

The hub runs in Docker, and a container does not inherit the host's Tailscale resolver, so a machine advertised as
`--hub-advertise-host jedi.<tailnet>.ts.net` shows **Web UI: Not reachable (ENOTFOUND)**. Either advertise the
machine's tailnet IP (`--hub-advertise-host 100.x.y.z`), or enable the override that points the hub at MagicDNS:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
# or put COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml in .env
```

## What the hub can and cannot see

Each heartbeat (every 30 s) carries: the machine's identity and software versions, its advertised addresses, a
**non-secret** configuration (backend, host, port, roots, allowed origins, whether auth is required), each agent's
state, and the Session inventory.

- **Sessions are only listed for agents that are already running.** Harnesses start lazily on purpose; listing a
  sleeping one would wake it, and a monitor that starts every agent on every machine every 30 seconds would be
  worse than none. An agent nobody has used yet simply has no sessions to report.
- **What each Session is doing and when.** Every Session carries an `activity` (working, needs you, idle, completed,
  failed, stopped), when it **started** and when it **last ran**, and Claude Code **background agents** are reported
  as Sessions of kind `background`. All of it is searchable; see [BACKGROUND_AGENTS.md](BACKGROUND_AGENTS.md).
- **Transcripts are never read.** The inventory comes from the same lightweight index the web app uses for its
  Session list.
- **Logs** are what the daemon prints, tapped from stdout/stderr. Lines are scrubbed of the gateway password, hub
  tokens, `Authorization` headers, `--password`/`--hub-token` arguments and common API-key shapes *before* they are
  queued, so they never leave the machine unredacted. The values of provider credentials in the bridge's environment
  (`ANTHROPIC_AUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, ...) are scrubbed wherever they appear. This
  is best-effort; see [PROVIDERS.md](PROVIDERS.md#secrets-and-logs).

## HTTPS for iPhone

An iPhone is the reason to run a hub, and it needs HTTPS:

- Safari refuses to load `http://` machines into an `https://` page (mixed content). The hub's proxy avoids this by
  putting every machine behind one origin, but that origin should be HTTPS.
- A service worker, and a proper "Add to Home Screen" app, need a secure context.
- The console password and session cookie would otherwise cross your network in the clear.

Pick one:

**Tailscale (simplest for a private setup).** Set `HUB_BIND=0.0.0.0` (or leave it on loopback and use Tailscale
Serve on the same host), publish the port over HTTPS on your tailnet with `tailscale serve`, and set
`HUB_TRUST_PROXY=1` and `HUB_PUBLIC_URL=https://<your-machine>.<tailnet>.ts.net`. Your iPhone joins the tailnet.
Nothing is exposed to the internet.

**Caddy with a real domain.** Point a DNS name at the host, keep ports 80/443 reachable, and generate the `.env`
with the domain (it sets the four settings that only make sense together):

```bash
sh deploy/init-env.sh --domain hub.example.com   # HUB_DOMAIN, HUB_PUBLIC_URL, HUB_TRUST_PROXY=1, COMPOSE_PROFILES=tls
docker compose up -d --build
```

Already have a `.env`? Add those four lines yourself (`HUB_DOMAIN=hub.example.com`,
`HUB_PUBLIC_URL=https://hub.example.com`, `HUB_TRUST_PROXY=1`, `COMPOSE_PROFILES=tls`) or pass `--profile tls`. Leave
`HUB_BIND` on `127.0.0.1` so Caddy is the only way in. The hub prints a warning at startup if `HUB_PUBLIC_URL` is
`https://` but `HUB_TRUST_PROXY` is off, which is the mistake that would otherwise leave the cookie without `Secure`.

Caddy obtains a certificate automatically and does not buffer the live event stream. With `HUB_DOMAIN=localhost` it
uses a local CA, which is enough to try the setup on the same computer but is **not trusted by an iPhone**.

**Your own reverse proxy** (nginx, Traefik, …): forward to `hub:8080`, disable response buffering for `/m/`
(server-sent events), and set `HUB_TRUST_PROXY=1`.

`HUB_TRUST_PROXY=1` makes the hub believe `X-Forwarded-Proto`/`-For`/`-Host`, taking the **last** entry of each: the one
the proxy in front of the hub appended itself, since an appending proxy (nginx's `$proxy_add_x_forwarded_for`) leaves
whatever the client sent in front. It trusts exactly one proxy hop. Anyone who can reach the hub *directly* can forge
the headers, so set it only when the proxy is the only way in.

### Add to Home Screen

In Safari, open the hub's address → Share → **Add to Home Screen**. It opens full-screen with the Harness Remote Plus
icon. Sign in once inside it (the home-screen app keeps its own cookies). The console lives at `/hub/`, the workspace
at `/`.

## Configuration

Everything is environment variables (compose reads them from `.env`; see [.env.example](../.env.example)). Any
secret can instead be given as `NAME_FILE=/path` (Docker/Kubernetes secrets).

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_DATABASE_URL` | – (required) | `postgres://user:password@host:5432/db`. Compose sets it. |
| `HUB_ADMIN_PASSWORD` | – (required, 12+ chars) | The console password. |
| `HUB_SECRET_KEY` | – (required, 32+ chars) | Derives the key that encrypts stored gateway credentials and the one that signs the session cookie. |
| `HUB_ENROLLMENT_TOKEN` | unset | Optional shared token any install may use to enroll (16+ chars). Per-machine tokens from the console are the better habit. |
| `HUB_LOKI_URL` | unset | Loki base URL. Unset disables log collection (machines are told, and stop buffering). |
| `HUB_PUBLIC_URL` | derived | The address people and machines use; shown in install commands. |
| `HUB_TRUST_PROXY` | `0` | See above. |
| `HUB_INSTALL_COMMAND` | `npx --yes github:enslaver/harness-remote-plus` | What the console tells people to run. |
| `HUB_PORT` / `HUB_HOST` | `8080` / `0.0.0.0` | Where the hub process listens. In Compose the container always listens on 8080; `HUB_PORT` there is only the *published host* port. |
| `HUB_BIND` | `127.0.0.1` | (compose) which host address the port is published on. |
| `HUB_PROBE_INTERVAL_MS` | `30000` | How often the hub re-checks each machine is reachable. |
| `HUB_OFFLINE_AFTER_MS` | `90000` | Heartbeat silence before a machine shows offline. |
| `HUB_SESSION_TTL_HOURS` | `720` | Console sign-in lifetime (sliding). |
| `HUB_SESSION_RETENTION_DAYS` | `90` | Session rows not seen for this long are pruned. |
| `HUB_PROXY_MAX_BODY_BYTES` | `30000000` | Largest request body the proxy forwards. |

Log retention is Loki's: `deploy/loki/loki-config.yml` keeps 31 days (`retention_period: 744h`).

## Security model

Read this before exposing the hub beyond your own computer.

**The hub is a high-value target.** It can open the web UI of every machine that shared its credentials, and an agent
session can run code as the account that started it. Whoever signs in to the hub effectively controls the fleet.
Treat it like a password manager: private network or VPN, HTTPS, a long password.

- **One administrator**, one password, compared in constant time; failed attempts are rate limited. The session is a
  signed, stateless cookie: `HttpOnly`, `SameSite=Strict`, `Secure` when the request was TLS. Rotating
  `HUB_SECRET_KEY` signs everyone out.
- **Cross-site requests are refused.** State-changing requests that carry the cookie must be same-origin
  (`Sec-Fetch-Site`, falling back to `Origin`). The console is served under `default-src 'none'; script-src 'self'`
  with no inline script or style.
- **Enrolled machines are trusted peers.** A machine's token can list the fleet (`/api/v1/fleet`) and open any other
  machine through the proxy, which is how the desktop app shows the hub's machines after you give it the enrollment
  token. One compromised enrolled machine therefore exposes the rest; revoke its token by deleting it in the console.
- **Machines authenticate with their own bearer token**, bound to one machine id, stored as a SHA-256 hash. Deleting
  a machine in the console revokes its token immediately; a machine with an enrollment token enrolls itself again,
  one without stops reporting and says why.
- **Gateway credentials** a machine shares are sealed with AES-256-GCM under a key derived from `HUB_SECRET_KEY`.
  No API ever returns them. The browser never holds them: it holds a session cookie, and the hub injects the
  machine's own `Authorization` header on the way through. The daemon still refuses anonymous requests itself.
- **The proxy only talks to a verified machine.** A machine merely *claims* addresses. Before the hub sends anything
  with that machine's credentials to one, an authenticated `GET /v1/machine` must answer with the same machine id.
  A mistyped address, a recycled DHCP lease or a hostile registration therefore cannot aim the proxy at Loki,
  Postgres or a router. An address is trusted only while its last probe succeeded; after a failure it is proven
  again before a request carrying credentials is sent to it. Link-local space (169.254.0.0/16), the well-known
  metadata names and the IPv6 forms that carry them (mapped, NAT64, 6to4, AWS's `fd00:ec2::/32`) are refused
  outright; the identity check is the real barrier. The probe uses `/v1/machine`, never `/v1/health` (which starts
  the agent process), and has a hard deadline and size limit, so a hostile address cannot stall it.
- **The proxy is a pipe, not an API.** Only a fixed set of headers cross in each direction; the browser's cookie never
  reaches a machine; a machine's `Set-Cookie` and `WWW-Authenticate` never reach the browser (a machine `401` becomes a
  `502`, so a stale credential cannot pop a native password dialog). Request paths are joined onto the verified origin
  and re-checked, so `//other-host/x` cannot redirect a request. Machine responses are served under
  `Content-Security-Policy: sandbox; default-src 'none'`, so an HTML document a machine returns cannot run script
  on the hub's origin next to the admin session.
- **Postgres and Loki are not published.** Only the hub is. The image runs as an unprivileged user with a read-only
  root filesystem, no capabilities and `no-new-privileges`.
- **Machines are trusted with their own logs, not with each other's.** Log labels come from the machine's token, never
  from the payload.

Enrollment tokens are shared secrets: anyone holding one can register a machine (and re-registering an existing id
replaces its record). Create expiring, named ones and revoke them when done.

## Data and operations

**Postgres** holds current state: `machines` (identity, addresses, sealed credentials, configuration, agent state),
`machine_config_history`, `sessions` (with `kind`, `activity`, `started_at`, `last_ran_at`, indexed for search),
`enrollment_tokens`. Migrations are forward-only files in `hub/migrations/`,
applied at start under an advisory lock.

**Loki** holds time series, labelled `job=harness-remote`, `kind` (`log`|`event`), `machine_id`, `machine`,
`source` (`daemon`, an agent id, `hub`, `session`, `proxy`, `web`), `stream`, `level`. In Grafana (`docker compose --profile grafana up -d`, or `COMPOSE_PROFILES=grafana` in `.env`; an explicit
`--profile` replaces `COMPOSE_PROFILES`, so combine them as `COMPOSE_PROFILES=tls,grafana`;
`http://localhost:3000`, user `admin`, password `HUB_ADMIN_PASSWORD` unless `GRAFANA_ADMIN_PASSWORD` is set) a
dashboard is provisioned. Some useful queries:

```logql
{job="harness-remote", level="error"}                                  # errors, fleet-wide
{job="harness-remote", machine="Studio Mac", source="codex"}          # one agent on one machine
{job="harness-remote", kind="event"} | json | type="session.status"   # Session state changes
```

**Backup.** Back up the Postgres volume (`docker compose exec postgres pg_dump -U hub hub > hub.sql`) **and keep
`HUB_SECRET_KEY`**: without it the stored gateway credentials cannot be decrypted (machines re-send them on their
next start, so the loss is recoverable, just noisy). Loki data is the `lokidata` volume.

**Upgrade.** `git pull && docker compose up -d --build`. Migrations run on start.

**Troubleshooting**

| Symptom | Likely cause |
| --- | --- |
| Machine shows **Not reachable** | The hub cannot open `http://<address>:<port>` from inside its container. Check the address on the machine's page, the machine's firewall, and that the gateway binds `0.0.0.0` (not loopback). For a machine on the Docker host itself, use `--hub-advertise http://host.docker.internal:<port>`. |
| **"a different machine answered"** | That address now belongs to another machine (moved or re-leased). Restart the gateway or fix `--hub-advertise`. |
| **"the machine rejected the stored credentials"** | The machine's password changed and the hub has an old one. Restart the gateway; it re-sends them. |
| No logs, `501` in the machine's output | `HUB_LOKI_URL` is unset. |
| Console sign-in does nothing on iPhone | Almost always the cookie: over plain `http://` it is not `Secure`, which is fine; behind a proxy without `HUB_TRUST_PROXY=1` it is dropped. |
| Login says too many attempts | 10 failures in 5 minutes per address; wait, or restart the hub. |

## Limits

- **The hub must be able to reach the machines** (same LAN, or a VPN such as Tailscale). There is no reverse tunnel, so
  a machine behind NAT that the hub cannot reach still reports in and shows its logs and Sessions, but its web UI
  cannot be opened through the hub.
- One administrator; the console is English only (the workspace keeps its four languages).
- Sessions are inventoried for running agents only (see above); the first page (up to 200) per agent.
- Not tested on a real iPhone. Layout, sizing, sign-in and the proxy path are verified in Chromium with Apple's
  viewport, touch and user agent; keyboard handling is verified by driving a simulated `visualViewport`. Please check
  real Safari, especially typing in a conversation.

## Machine ↔ hub protocol (v1)

All JSON over HTTP(S). Machine calls carry `Authorization: Bearer <token>`.

| Call | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/machines/enroll` | enrollment token | Register (or re-register) a machine; returns its own token and the heartbeat interval. |
| `POST /api/v1/machines/heartbeat` | machine token | Identity, addresses, configuration, agents, Sessions (`kind`, `activity`, `startedAt`, `lastRanAt`), `sessionAgents` (the agents whose list is complete, so a missing Session can be marked *gone*), stats. Answers `needCredentials` if the hub has none. |
| `POST /api/v1/ingest/logs` | machine token | Up to 1000 lines per batch. `503` = keep the batch; `501` = the hub stores no logs, stop buffering. |
| `GET /api/v1/bootstrap` | cookie | What the web app needs. Signed out: `200 {hub:true, authenticated:false}`. |
| `GET /api/v1/machines`, `/logs`, … | cookie | The console's API. |
| `GET /api/v1/sessions?q=&activity=&kind=&ranAfter=&startedAfter=&sort=&limit=&offset=` | cookie | Session search across machines; `total` for paging. See [BACKGROUND_AGENTS.md](BACKGROUND_AGENTS.md#the-hub-when-a-session-started-when-it-last-ran-and-search). |
| `GET /api/v1/fleet` | machine token | The machines the web app would list, for an enrolled client such as the desktop app. |
| `ANY /m/<machineId>/…` | cookie or machine token | Same-origin proxy to a verified machine. A machine token may be sent as `Bearer`, or as Basic auth `hub-machine:<token>`. |

## Developing the hub

```bash
cd hub && npm ci
pg_ctlcluster … start     # or: docker run -d -p 5432:5432 -e POSTGRES_USER=hub -e POSTGRES_PASSWORD=hub -e POSTGRES_DB=hub postgres:16-alpine
HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/hub npm test
```

- `HUB_TEST_LOKI_URL=http://127.0.0.1:3100` additionally round-trips the Loki client against a real Loki
  (`docker run -p 3100:3100 -v $PWD/deploy/loki/loki-config.yml:/etc/loki/config.yml grafana/loki:3.4.2 -config.file=/etc/loki/config.yml`).
- Database suites skip locally when `HUB_TEST_DATABASE_URL` is unset; in CI (`CI=true`) that is a failure.
- `npm run smoke:ui` and `npm run smoke:app` drive the console and the built web app in Chromium with an iPhone profile
  (`playwright` is installed on demand, as in CI; `smoke:app` needs `web/dist`).
- `npm run e2e` (after `docker compose up -d --build`) runs a real machine daemon against the running stack. It
  checks enrollment, the proxy, logs in Loki, the Session inventory, a hub restart, self-healing after a forget, and
  with `E2E_GRAFANA=1` / `HUB_TLS_URL=https://localhost` the Grafana and Caddy profiles.
