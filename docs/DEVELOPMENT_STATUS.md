# Development status

> Handoff point for ongoing work that is not yet on `main`. Keep this concise and safe to read at the start of a new coding-agent session.

## Branch policy

- Persistent integration branch: `codex/development-2026-09-11`.
- Never develop directly on `main`.
- Internal feature/fix PRs target integration first.
- Merge only after applicable CI is green and required real validation is accepted by the repository owner.
- Frozen RC branches are immutable. Any product-code change after a freeze requires a new RC.
- ACP, Native Session, routing, models and harness-runtime changes require regression review against the reliability contracts.

## Harness Remote Plus 3.1.0 release state

The 3.1.0 integration line is release-ready and the repository owner has accepted the final desktop and physical Android validation.

The last product change before release is PR #524, merged as `fba6914a6a0eb38c7c5b5b7362bcee9b1e66c348`:

- first-run Android Machines exposes QR pairing directly;
- successful pairing no longer leaves a stale manual-machine form open;
- pairing completion presents an explicit **View sessions** next step;
- pairing/status UI is localized;
- English, Italian, Traditional Chinese and Simplified Chinese now have i18n key parity enforced by regression tests.

The exact PR head `86422a372cc86c69942561856124a6d48343a6f9` passed:

- type-check and full web regressions;
- bridge tests on macOS and Windows;
- desktop tests on Ubuntu, macOS and Windows;
- real OpenCode + Zen browser gate;
- Chromium product smoke after a same-SHA rerun of one nondeterministic cross-machine assertion;
- Debug APK build.

The final APK was then validated successfully on a physical Android device by the repository owner.

Earlier release stabilization also validated:

- PR #517 — OpenCode retry/error/remount lifecycle;
- PR #519 — concise startup output;
- PR #520 — browser machine recovery after idle/wake;
- PR #521 — stable Native Session rail ordering/reconciliation.

`web/package.json` is already `3.1.0`.

Until the release merge completes, `main` remains the 3.0.2 stable line.

## Final release path

1. Merge the final 3.1 documentation update into integration.
2. Freeze `codex/release-candidate-3.1.0-rc6` from that exact integration head.
3. Open the release PR from the frozen 3.1 line to `main`.
4. Require the full PR gate on the exact release head.
5. Merge with a commit title beginning `Release Harness Remote Plus 3.1.0` and a curated commit body.
6. The `Cut release tag` workflow creates annotated tag `v3.1.0` from that release commit and dispatches Android/Desktop release builds.
7. Android publishes the GitHub Release first; desktop packaging attaches Windows, macOS and Linux artifacts.

Do not manually create a competing release/tag while the automated release workflow is running.

## 3.1 headline changes

- Native Session continuation across machines and harnesses with explicit Project identity, bounded transferred context, durable lineage and recovery.
- Desktop-managed local Machine runtime: no separate local gateway command for the desktop computer.
- One-command remote gateway startup with automatic discovery, generated credentials and managed OpenCode.
- Android one-time QR pairing and simplified first-machine onboarding.
- Global native Attention visibility for questions/permissions and stronger notification/deep-link behavior.
- Stable Session rail ordering and conservative reconciliation during activity.
- Stronger OpenCode completion/retry/error/remount and reconnect recovery.
- Native Session outcome with bounded Git/worktree evidence.
- Broader release gates: cross-machine Chromium smoke, real OpenCode + Zen, desktop multi-platform checks and real-harness soak tooling.

## OpenCode reliability guardrails

Read `docs/OPENCODE_RELIABILITY_CONTRACT.md` before changing OpenCode Session projection, lifecycle routing or reconciliation.

In particular:

- ordinary internal idle/pre-Send OpenCode must not depend on continuous `/session/status` polling;
- persisted replies must remain recoverable when event delivery or status lookup is unavailable;
- unresolved requests remain Attention rather than being silently treated as completed;
- routed OpenCode lifecycle must not leak into ACP backends or sibling agent identities;
- `finish: "stop"` on a reasoning-only assistant envelope is not successful turn completion;
- a turn stays pending until durable terminal assistant text/error or bounded no-final recovery settles it;
- a stable native idle edge after Send is enrichment, not durable-final proof;
- ACP keeps its established permission/transcript semantics.

## Release/admin follow-up

Repository-admin branch protection for `main` is still a separate follow-up. The connected GitHub App does not have administration write permission, so the release process relies on the documented PR discipline and CI gates rather than enforced branch rules.

Issue #368 can retain that repository-admin follow-up after 3.1.0 ships; it should not be rewritten as if branch protection had already been enabled.

## Roadmap boundaries

- P0 #368 owns remaining release-safety/admin enforcement work.
- P1 #369 covers onboarding/reliability work already largely integrated.
- P2 #371 owns longer-term federation/cross-machine continuity.

Continue from `docs/HARNESS_3_ROADMAP.md`. Prefer native Session correctness, recovery and explicit authority boundaries over a synthetic universal-agent model.
