# Contributing to Harness Remote Plus

Thanks for wanting to work on this. Harness Remote Plus is a local-first control plane for native
coding-agent Sessions. It discovers the machines, Projects and harness capabilities that already
exist, then lets users observe and continue work from web, desktop or Android. OpenCode, Oh My Pi
(OMP), PI, Claude Code and Codex CLI are supported today. Adding a harness should mean adding a
profile/adapter entry and its documented capability contract, never a special case threaded through
the product.

This document is long on purpose. Read the section that matches what you are touching, or all of it
if you are having an agent do the work.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | React + TypeScript + Vite app, packaged for Android with Capacitor or for desktop with Electron |
| `web/src/` | Application source. `main.tsx` boots the client; native Session workspace components and `api.ts` implement the product UI and transport |
| `web/electron/` | Main/preload shell, IPC contract, profile registry, HTTP and SSE transports |
| `web/native-android/` | Java sources copied into generated Android project — see [Android packaging](#android-packaging) |
| `bridge/` | Local HTTP/SSE server translating app API to ACP over stdio, for OMP, PI, Claude Code and Codex CLI |
| `hub/` | Optional self-hosted server: machine registry (Postgres), log collection (Loki), same-origin proxy for the web app, admin console. One dependency (`pg`). See [docs/HUB.md](docs/HUB.md) |
| `deploy/`, `docker-compose.yml` | The hub's Docker stack: Loki, Grafana and Caddy configuration and the `.env` bootstrap script |
| `.github/workflows/` | Cloud APK/AAB and Windows/macOS/Linux Electron builds |

## Prerequisites

- **Node.js 20 or newer.** `web/` needs `npm ci`; `bridge/` has no dependencies at all and
  runs on the standard library, so do not look for a lockfile there.
- **A harness to talk to.** An OpenCode server or a working bridge-backed harness: OMP, PI,
  Claude Code or Codex CLI. You can develop UI-only changes without one, but see
  [Test against a real agent](#test-against-a-real-agent)
- **Desktop packaging:** electron-builder does not cross-compile, so each artifact is built and
  smoke-tested on its own OS. CI covers all three; locally you can only check the one you are on.
- **No Android SDK required.** CI builds the APK. You only need one for local native debugging.

## Getting it running

```bash
cd web
npm install
npm run dev
```

Open the printed URL. Add a **Machine**, then select a Project and native Session. The client
discovers the harnesses available on that machine instead of asking users to configure one backend
at a time.

### Against the desktop app

Build and launch packaged desktop app:

```bash
cd web
npm run electron:dev
```

For request/SSE transport tests without live server, use `npm run test:desktop`. Electron owns
network targets from saved profile IDs; renderer code must never add arbitrary URL or header inputs.

### Against OpenCode

Start the machine launcher with authentication and, for browser development, the exact CORS origin.
The [quick start](docs/QUICK_START.md) has the current end-to-end command.

### Against OMP

OMP speaks ACP over stdio rather than HTTP, so the app talks to it through the bridge:

```bash
cd bridge
node src/cli.js --port 4097 --root "$HOME/your-project" --cors http://localhost:5173
```

`--cors` matters for browser/PWA development and is easy to forget: without it browser blocks every
request. Installed Electron and Android builds do not need it. Bridge binds to `127.0.0.1` by
default and refuses non-loopback bind without `--username` and `--password`.

## The checks you must run

The complete web regression suite now has one canonical entry point, so local verification and CI
cannot silently drift into different copied lists:

```bash
cd web
npm run build
npm run build:electron
npm run test:ci:full

cd ../bridge
npm test
```

Touching `hub/`, `deploy/`, `docker-compose.yml`, the bridge's hub reporter or the web client's hub/iPhone code
adds these (CI runs all of them; the database suites need a Postgres and skip without one locally, but fail in CI):

```bash
cd hub && npm ci
HUB_TEST_DATABASE_URL=postgres://hub:hub@127.0.0.1:5432/hub npm test   # add HUB_TEST_LOKI_URL=… for real Loki
npm run smoke:ui && npm run smoke:app     # console + built web app in Chromium with an iPhone profile (needs web/dist)
                                          # smoke:app also drives the Session rail's grouping and a background agent

cd ../web && npm run test:agents           # rail grouping, activity vocabulary, background-agent client (part of test:ci:full)

cd .. && sh deploy/init-env.sh && docker compose up -d --build --wait
node hub/scripts/e2e-stack.mjs            # a real machine daemon against the real stack
```

`npm run build` is `tsc -b && vite build`, so it type-checks as well as bundles. Packaging workflows
use narrower named tiers where appropriate (`test:ci:baseline` and
`test:ci:desktop`) while PR validation uses `test:ci:full`.

## Product and compatibility rules

Harness Remote Plus presents native Sessions from the machines users connect. Do not add a new
user-facing abstraction that duplicates a harness Session or claim that one harness's hidden
context has been transferred to another.

When a feature changes the Session experience:

- preserve the owning harness's transcript, permissions, model controls and writer rules;
- make capability differences explicit instead of showing controls that do nothing;
- test the feature with at least the affected harness and client form factor;
- keep machine, Project and native Session identity stable across refresh, reconnection and
  navigation.

## Responsive UI rule

The web, desktop and Android clients share the same product model but not the same available space.
Check every UI change in a narrow touch viewport and a desktop viewport. Touch controls need enough
space to remain independently reachable; headers and action groups must wrap or stack rather than
overlap titles, transcript content or each other.

Use the v3 product UI checks when a change touches native Session navigation, headers, dialogs,
composer behavior or mobile layout:

```bash
cd web
npm run test:v3-product-ui
```

## How the tests work here, and how to change one

Many suites under `web/src/*-regression.test.mjs` are unusual: they assert against the **source
text** of active product components rather than rendering a DOM. These are cheap guards that pin
specific regressions we have already paid for once.

This will surprise you the first time a code change fails a test whose message talks about a string.
That is working as intended. What matters is how you fix it.

**Assert the invariant, not the shape of the code.** A test that forbids an identifier will block a
legitimate refactor; a test that checks the behavioural guarantee survives it. A real example from
this repo: an assertion once required that `messageScrollSignature` did not exist, as a proxy for
"background refreshes must not force a transcript to scroll". Streamed rendering needed that
value back, and the right fix was not to delete the test but to assert the actual guarantee — that
content-driven scrolling is gated on the user already being pinned to the bottom:

```js
assert.ok(
  /if \(!stickToBottomRef\.current\) return[\s\S]*?scrollMessagesToBottom\("auto"\)/.test(app),
  'content-driven auto-scroll must be gated on the user already being pinned to the bottom'
)
```

If you cannot express the invariant, that is a signal the guard belongs somewhere else — a unit test
against an extracted function, as `web/src/serverConfig.ts` and `test:config` do.

**Never weaken these two.** `test:config` protects against a saved configuration that cannot be
loaded: a half-typed host such as `http://` used to throw while rendering, which unmounted the app
and, because the value had already been persisted, reproduced a blank screen on every launch. The
guard in the autosave effect, and every `isValidServerConfig` check that gates a connection, are what
prevent that.
The `ErrorBoundary` in `main.tsx` is the backstop that keeps any future crash recoverable from
inside the app.

## Test against a real agent

Every bug that reached a user came from a real agent behaving unlike the spec, not from a logic error
the fakes could have caught. Observed with OMP 17.1.3:

- it never echoes the prompt you submitted, so a deduplication scheme that assumes an echo silently
  ate the user's message;
- its session listings carry no title, so every session rendered with the same placeholder;
- it does not emit ACP `agent_plan`, so the plan panel stays empty;
- it approves its own tool calls and sends no permission requests.

Every quirk found this way is recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md), together with
what breaks if it changes. Read it before touching a harness integration, and update it in the same
commit when you learn something new.

The fakes in `bridge/test/` exist to keep fixed behaviour fixed. They are not evidence about how an
agent behaves. When you add support for something, drive it with the real thing at least once, then
encode what you observed in a fake.

## Internationalisation

The UI ships in English, Italian, Traditional Chinese and Simplified Chinese, in one small module with no framework.
`test:i18n` enforces key parity, so a string added to one language and not the others fails the
suite. Add all four.

## Android packaging

You do not need an Android SDK: pushing to `main` builds debug and release APK artifacts, and a `v*`
tag publishes a release. Tagged builds fail rather than publishing unsigned when a signing secret is
missing.

One trap worth knowing. If you touch anything in `web/native-android/`, sync with:

```bash
npm run cap:sync:android
```

A plain `npx cap sync android` does **not** copy those Java sources into the generated project, so
your change is silently dropped and the app runs the previous version of the native plugin.

## Cutting a release

The release version is still sourced from `web/package.json`, but tags are now created by CI rather
than by hand.

1. Bump `version` in `web/package.json`.
2. Merge the fully validated release candidate to `main`.
3. Make the final merge commit title exactly `Release Harness Remote Plus X.Y.Z` (or begin with that
   phrase) and give it a non-empty body containing the curated release summary.
4. `.github/workflows/cut-release-tag.yml` reads the package version, creates the annotated
   `vX.Y.Z` tag if it does not already exist, and explicitly dispatches the Android and Desktop
   builders on that tag.
5. The Android tagged build publishes the GitHub Release and signed APK. The Desktop tagged build
   waits for that release and attaches Windows, macOS and Linux artifacts.

Why the explicit dispatch? GitHub intentionally does not trigger other workflows from a tag pushed
with the repository `GITHUB_TOKEN`. Do not remove the dispatch step and assume the tag push will
fan out by itself.

**The release commit body becomes the annotated tag body and therefore the curated release notes.**
Keep it useful to people installing the release: describe user-visible changes first, mention
important compatibility/reliability work, and credit external contributors by name/handle when
their work is included.

Before calling a release complete, verify all of these independently:

- `main` points at the intended release tree;
- the `vX.Y.Z` annotated tag points at the release commit;
- the tag annotation is non-empty;
- the Android tagged workflow publishes the GitHub Release and signed APK;
- the Desktop tagged workflow attaches Windows/macOS/Linux artifacts.

Do not manually move or recreate an already-published release tag to fix packaging. Fix the workflow
or release metadata, then rerun the builders against the existing immutable tag whenever possible.

## The bridge is a network service

Treat these three areas as security-sensitive and explain your reasoning in the PR when you change
them:

- **Authentication.** Basic Auth compared in constant time. The bridge refuses to bind beyond
  loopback without credentials.
- **The `--root` boundary.** It restricts what the bridge exposes: which directories the app may
  browse and where a session may run. It is **not** a sandbox for the agent, which runs with full
  user privileges — do not describe it as one.
- **CORS.** Off by default; each origin must be listed explicitly, because credentialed CORS cannot
  use a wildcard.

## Commits and pull requests

Commit subjects use a conventional prefix. The ones actually in use here are `fix:`, `feat:`,
`docs:`, `chore:`, `perf:` and `ci:`, with an optional scope such as `fix(bridge):`.

Write the body to explain **why**, not what — the diff already says what. If a change fixes
something subtle, say what the failure looked like and how you confirmed it is gone. A commit that
records the reasoning is worth more than one that records the edit.

Group commits by intent rather than by the order you happened to write them, and keep each one
building and passing on its own so a bisect lands somewhere useful.

In the PR, say how you verified the change, and whether you tested against a real harness or only
against the fakes. Both are acceptable; which one it was is not obvious from the diff.

**Your commits stay yours.** We merge contributions rather than re-implementing them, and anything
that needs changing afterwards goes in separate commits on top. Squashing is up to you.

## Where to start

- [Open issues](https://github.com/enslaver/harness-remote-plus/issues), especially any labelled
  [`help wanted`](https://github.com/enslaver/harness-remote-plus/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
  A new harness is the obvious next step: the profile mechanism in `bridge/src/harness-profiles.js`
  is what PI, Claude Code and Codex CLI were added through, so it is a well-worn path rather than
  new ground.
- Bug reports from real use are genuinely valuable here, for the reason in
  [Test against a real agent](#test-against-a-real-agent).
- Translations, if the UI does not speak your language.

Questions are welcome in an issue before you write anything, especially for a large change — it is
cheaper for both of us than a rebase.
