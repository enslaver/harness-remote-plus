# Providers and custom endpoints

Harness Remote Plus does not talk to a model provider. Each coding agent does, and Harness Remote Plus
drives the agent. So "does it work with Amazon Bedrock, or with my OpenAI-compatible gateway?" reduces to
three questions about the bridge:

1. Does the agent process **receive the provider's settings** (environment variables, config files)?
2. Does the **start-up handshake** cope with a machine that has no vendor login?
3. Do **model ids** from a non-default provider survive the picker, the session history and the hub?

This page records the answer for each harness, what was changed in this fork to make it true, and what is
still a limit. It was produced by reading the code path of every harness; the changes are covered by unit
tests, but **none of it has been run against a live Bedrock, Vertex or gateway account**. If a setup does
not work, please open an issue with the harness, the provider and the (redacted) error.

## How provider settings reach an agent

The bridge never reads or rewrites provider credentials or endpoints. It starts each agent with **its own
environment**, unchanged, and each agent reads its own config files.

| Where the bridge runs | What the agent sees |
| --- | --- |
| `npx --yes github:enslaver/harness-remote-plus` in a terminal | Everything exported in that terminal. Set the variables first. |
| As a service (systemd, launchd, Docker, a scheduled task) | Only what the service definition sets. A key in your `~/.bashrc` is **not** visible. |
| The desktop app on Windows | The user's Windows environment. |
| The desktop app on macOS or Linux, launched from the Dock or a menu | The app's own environment **plus** an allow-listed set of provider and network variables read from your login shell (below). |

**Login-shell import (desktop app, macOS and Linux).** A GUI launch does not read `~/.zshrc` or
`~/.bash_profile`, so `export CLAUDE_CODE_USE_BEDROCK=1` there used to be invisible to the desktop app's
built-in runtime. The app now runs your login shell once and imports variables named `ANTHROPIC_*`,
`CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*`, `CLAUDE_CONFIG_DIR`, `AWS_*`, `CLOUD_ML_REGION`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_*`, `OPENAI_*`,
`CODEX_*`, `AZURE_*`, `OPENROUTER_*`, `OPENCODE_*`, `NODE_EXTRA_CA_CERTS` and `HTTP(S)_PROXY`/`NO_PROXY`/
`ALL_PROXY`. Nothing else you have exported is kept. A variable the app was launched with always wins over
the shell's. Multi-line values are skipped.

Settings kept in the agent's own files (Claude Code's `settings.json` `env` block and `apiKeyHelper`,
Codex's `~/.codex/config.toml`, OpenCode's `opencode.json`, `~/.aws/config`) need none of this: the agent
reads them itself, wherever the bridge runs.

## Claude Code

Adapter: `@agentclientprotocol/claude-agent-acp`, which wraps the Claude Agent SDK.

| Provider setup | Configure it with | Status |
| --- | --- | --- |
| Anthropic, `claude login` | nothing | Works |
| Anthropic, API key | `ANTHROPIC_API_KEY` | Works |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `AWS_PROFILE` or AWS keys, or `AWS_BEARER_TOKEN_BEDROCK`; optional `ANTHROPIC_BEDROCK_BASE_URL` | Supported |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID` | Supported |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` and its `ANTHROPIC_FOUNDRY_*` settings | Supported |
| Anthropic-compatible gateway (LiteLLM, a corporate proxy, ...) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, optionally `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` | Supported |
| OpenAI-compatible endpoint | Not native to Claude Code. Put a translating gateway (for example LiteLLM) in front and use the row above. | Via gateway |

Checked:

- **Environment.** The ACP adapter and the `claude` CLI used for background agents both inherit the bridge's
  environment. The background-agent launcher removes only variables that identify a *parent* Claude session
  (`CLAUDE_CODE_SESSION*`, `CLAUDE_CODE_REMOTE*`, `CLAUDECODE`, ...). No provider variable matches, and a test
  now pins `CLAUDE_CODE_USE_*`, `ANTHROPIC_*`, `AWS_*` and `CLOUD_ML_REGION` as kept.
- **Handshake without a login.** The adapter offers login-shaped authentication methods. With no
  `claude login`, they are refused. The bridge used to treat that as a failed start; it now tries every method
  and, if none is accepted, **continues**, so `session/new` and the first prompt report any real credential
  problem in the adapter's own words.
- **Model ids.** Bedrock ids (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), Vertex ids
  (`claude-sonnet-4@20250514`), aliases (`sonnet[1m]`) and gateway names are passed through untouched. The
  background-agent `model` field previously rejected `@` and anything over 80 characters, which excluded Vertex
  ids and Bedrock inference-profile ARNs; it now accepts up to 256 characters of `A-Za-z0-9._:/@+=,-[]` (still
  never starting with `-`, and never reaching a shell).
- **Errors.** A background-agent failure that looks like an authentication problem (not logged in, invalid API
  key, expired AWS token, missing credentials) is reported as `claude_unauthenticated` (HTTP 401) instead of a
  generic `claude_failed`.

## Codex CLI

Adapter: `@agentclientprotocol/codex-acp`, which embeds `@openai/codex`.

| Provider setup | Configure it with | Status |
| --- | --- | --- |
| ChatGPT account | `codex login` | Works |
| OpenAI API key | `OPENAI_API_KEY` or `CODEX_API_KEY` | Works |
| OpenAI-compatible gateway, Azure OpenAI, Ollama, LM Studio, OpenRouter, LiteLLM | a `[model_providers.<id>]` table and `model_provider = "<id>"` in `~/.codex/config.toml` (`base_url`, `env_key`, `wire_api`); export the key named by `env_key` | Supported |
| Bedrock, Vertex | Only through an OpenAI-compatible gateway in front of them | Via gateway |

Checked and changed:

- **Handshake.** The profile prefers the adapter's `chat-gpt` method so an existing `codex login` is used.
  Before this fork, a machine using only a custom provider could fail to start if that method was rejected.
  The handshake now falls back through the other methods and then continues (see Claude Code above).
- **Model ids.** A custom provider records ids such as `openrouter/anthropic/claude-sonnet` in Codex's session
  rollout. The picker splits an id at its first `/`; the rollout reader did not, so a restored Session's model
  matched no picker row. Both now split identically.
- **`CODEX_HOME`.** Session history is read from `$CODEX_HOME/sessions` when that variable is set, otherwise
  `~/.codex/sessions`.
- **Variants.** Reasoning effort appears only for models that advertise it. Local and gateway models often do not,
  and then show no variants.

## OpenCode

OpenCode is driven over its own HTTP API, so provider support is whatever `opencode` supports: the built-in
providers, `@ai-sdk/openai-compatible` and other custom providers in `opencode.json`, Amazon Bedrock
(`AWS_PROFILE`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`), Azure, Ollama, LM Studio and OpenCode Zen.

Checked and changed:

- **Environment.** The managed `opencode serve` process receives the bridge's environment plus its own
  server credentials. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` pass through.
- **Model ids.** `openrouter/anthropic/claude-sonnet` (splits at the first `/`) and
  `us.anthropic.claude-...:0` (colons are left alone) both round-trip.
- **Unlisted providers.** The picker shows the providers OpenCode reports as *connected*. A model whose
  provider is **not in that inventory at all** (for example one defined only in a project's own
  `opencode.json`) is no longer rejected with `model_unavailable`; it is sent to OpenCode, which decides. A
  model whose provider *is* listed but does not offer it is still rejected.
- **Empty picker.** The message now says what to do: run `opencode auth login`, set the provider's
  environment variables, or define the provider in `opencode.json`.

Limits:

- The model list is read without a project directory, so providers defined only in a project-level
  `opencode.json` are not listed in the picker (they can still be used by an existing Session).
- The managed OpenCode host starts on demand. Until it has been used, its Sessions are not in the hub
  inventory. This does not depend on the provider.

## Oh My Pi and PI

Both are ACP adapters over the harness's own SDK. Custom providers (OpenAI-compatible or Anthropic-compatible
`baseUrl` entries in the harness's model configuration), Bedrock, local models and environment-variable
credentials are read by the harness itself.

Checked and changed:

- **Handshake.** Same fallback as above: an env-var-only or custom-provider setup no longer fails to start
  because a login-shaped method was refused.
- **Model ids.** `provider/model` ids split at the first `/`, so `ollama/llama3:8b` and
  `amazon-bedrock/us.anthropic.claude-...:0` parse correctly.
- **Thinking variants.** Offered only for models that advertise a thinking option.

## What is provider-independent

Everything this fork added is independent of the model provider, and was checked to be so:

- **The hub and its schema** store a Session's title, directory, times and activity. They never store or
  validate a provider or model id, so long or unusual ids (Bedrock ARNs, ids with `/`, `:` or spaces) cannot be
  rejected there.
- **Session start and last-run times, search, grouping and activity status** come from the harness's own Session
  index and status, not from any provider setting.
- **Claude background agents** use the `claude` CLI with its inherited environment.

### Model variant probing

Listing a harness's thinking or reasoning variants costs one round trip per model. The probe budget was a fixed
10 seconds, which a large Bedrock, OpenRouter or gateway catalog exhausts, leaving later models without
variants. The budget now grows with the catalog (250 ms per model, never below 10 s, never past the catalog
deadline).

## Secrets and logs

A machine that reports to a hub ships its logs there after redaction. Lines are scrubbed of the gateway
password, hub tokens, `Authorization` headers, `key=value` pairs whose name looks secret (which covers
`ANTHROPIC_AUTH_TOKEN=...` and `AWS_SECRET_ACCESS_KEY=...`), URL credentials and common key shapes.

Because a failing adapter can echo a bare secret, the redactor now also learns the **values** of the provider
credentials in the bridge's environment (any variable whose name contains `KEY`, `TOKEN`, `SECRET`,
`PASSWORD` or `CREDENTIAL`, with a value of at least 8 characters) and removes them wherever they appear.
Redaction is best-effort: do not print credentials on purpose, and treat Loki as sensitive storage.

## Troubleshooting

- *The harness starts but the first prompt says it is not authenticated.* The provider variables did not reach
  the agent. Check the table under [How provider settings reach an agent](#how-provider-settings-reach-an-agent),
  then start the bridge from a terminal where `claude`, `codex` or `opencode` itself works.
- *Bedrock says the security token is expired.* Refresh the SSO session (`aws sso login`) on the machine that
  runs the bridge.
- *The model list is empty.* Codex and the ACP harnesses list what the adapter advertises; if a gateway does not
  expose a model list, set the model in the harness's own config. For OpenCode, see above.
- *A background agent fails with `claude_unauthenticated`.* The `claude` CLI on that machine cannot sign in
  under the bridge's environment; run `claude` in the same shell and fix it there.
