# Background agents, agent status and grouping

Three related things, all built on what the machine already knows:

1. **Status you can read at a glance** for every Session: working, needs you, idle, completed, failed, stopped.
2. **Claude Code background agents** (`claude --bg`): see them, follow a running one, stop it, read its output,
   continue a finished one, remove it. Started from a terminal, from Claude's own agent view, or from here: it is
   the same agent.
3. **Group and filter the Session list** across every machine and project: a plain recent feed, or by status,
   project, machine or agent, with a time window.

## Status

One vocabulary for every harness:

| Status | Meaning |
| --- | --- |
| **Working** | The agent is running a turn (or a background agent is doing its work). |
| **Needs you** | Blocked on a question or a permission only a person can answer. |
| **Idle** | Alive, waiting for the next message. |
| **Completed** | A background agent that finished its work. |
| **Failed** | Ended in an error. |
| **Stopped** | Stopped by a person. |

An ordinary Session is Working, Needs you, Idle or Failed; "Completed" is what a background agent that ran to the end
reports (Claude's own agent view calls it *Done*). Each row shows its status, and the Session list has one-tap chips for
All, Live, Attention, **Completed** and **Failed**.

## The Session list: group by, and a time window

Above the list, two dropdowns:

- **Group by**: *Machine › Project* (the original tree, still the default), *No grouping* (one **recent feed** across
  every machine and project, newest run first), *Status* (what needs you first, then working, failed, completed,
  stopped, idle), *Project*, *Machine*, *Agent*.
- **Time window**: Any time, Past hour, Past day, Past week: by when a Session **last ran**.

Rows in the flat views say which machine and project they are from. Your choices are remembered in this browser (and
cleared with the rest of the app's data if you reset it). The hub console has the same idea for the whole fleet at once
(see below).

## Background agents (Claude Code)

### What you need

Claude Code with background agents (`claude agents --json` works; `claude --bg` starts one) on the machine, on `PATH`
or named by `HARNESS_REMOTE_CLAUDE_COMMAND`. A machine without it simply reports none; nothing else changes. On
Windows use the native `claude.exe`: an npm `.cmd` shim re-parses its arguments, so it is only used for commands with
no free text (listing works; starting or continuing does not, and says so).

### Seeing them

Background agents appear in the Session list with a **Background** badge and their real state. If the agent's
conversation is also in Claude's ordinary Session listing (it usually is), it is one row: the agent's own state wins
(the listing only knows the last message), and the listing's title stays. If the harness listing does not contain it,
it still gets a row and opens as a Claude Session. The list refreshes every 10 seconds while the app is visible.

### Following a running agent (attach)

Open it: a strip above the transcript shows **what it is doing, when it started and when it last ran**, and the
transcript follows it. While it runs, the composer is off: a running agent is driven by its own process, and a second
writer on the same transcript would fork it. You can read the agent's terminal **Output** and **Stop** it (asked
inline, not with a system dialog). A **blocked** agent says what it needs and how to answer: `claude attach <id>` in
its own terminal. This app follows and controls agents; it does not replace that terminal.

### After it finishes

Open it: the same Session, now writable through the normal path. The strip offers **Continue in background** (send
another instruction; it resumes under the same id and keeps running without you), **Output**, and **Remove**.
Remove asks first, and if the agent's worktree still holds unpushed work Claude refuses; this app never overrides that.

### Safety

- Only a **finished** agent accepts a prompt; only a **running** one can be stopped; only a **finished** one can be removed.
- Starting an agent (`POST /v1/background-agents`) is limited to directories inside `--root`, cannot request
  `bypassPermissions`, and passes the prompt after `--` so a prompt that looks like a flag is still a prompt.
- Ids are 8 hex characters, checked before anything runs. No shell is used.
- A daemon started from inside another Claude session never lets its `claude` children inherit that session's
  identity (they would attach to, and write into, it).
- Terminal Claude sessions on the machine are listed and can be *read*, never stopped or written to from here.

### Machine API

| Route | |
| --- | --- |
| `GET /v1/background-agents[?all=0]` | `{available, reason?, agents:[…]}`. `available:false` when Claude Code is missing or too old. |
| `POST /v1/background-agents` | `{prompt, directory, name?, model?, permissionMode?}` → `201 {id?}` |
| `GET /v1/background-agents/:id` | one agent |
| `GET /v1/background-agents/:id/logs` | recent terminal output, escapes removed, newest 64 KB |
| `POST /v1/background-agents/:id/stop`, `/resume` `{prompt}` | |
| `DELETE /v1/background-agents/:id` | |

Each agent carries `activity`, `detail`, what a blocked agent `needs`, `startedAt`, `updatedAt` (when it last ran),
sub-agent counts, its worktree, and `capabilities` (`open`, `prompt`, `logs`, `stop`, `resume`, `remove`) that follow
from its state.

## The hub: when a Session started, when it last ran, and search

The hub stores, per Session: `kind` (`session` or `background`), `activity`, `detail`, **`started_at`** and
**`last_ran_at`**, all indexed.

- **started_at** is the earliest start any machine reported; a Session no harness dated starts when the hub first saw it.
- **last_ran_at** is the later of the harness's last-activity time and the last moment the hub saw it *working*, so a
  harness that reports no timestamps is still searchable. Waiting for a person does not count as running.

`GET /api/v1/sessions` is a search: `q` (title, folder, Session id, agent, machine), `activity` (comma list, or
`active`), `kind`, `agent`, `machine`, `startedAfter`/`startedBefore`, `ranAfter`/`ranBefore` (an ISO date such as
`2026-09-01`, or an age such as `90m`, `24h`, `7d`, `2w`), `sort=last_ran|started`, `limit`/`offset`; the answer has
`total` for paging. A malformed date is a 400, never a silently ignored filter.

The console's **Sessions** page has the controls: status, kind, last ran, started, machine, agent, sort, and
**Group by** (no grouping, status, machine, project, agent) over every machine at once.

## Limits

- **Not run against a live `claude --bg` process.** The listing format and state handling were learned from the real
  `claude agents --json` reading hand-written job records in a private directory (that check is part of the test suite
  and is skipped where `claude` is not installed), and the verbs are tested against a fake CLI. Starting, stopping and
  continuing a real agent needs the machine's Claude credentials and has not been exercised here; try it on one
  machine first.
- A *blocked* agent is answered in its own terminal (`claude attach`), not from this app.
- Following a running agent re-reads its transcript every few seconds; it is not a live stream.
- "Not run yet" means the harness gave no time and the hub never saw it working.
