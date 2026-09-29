import type { FederatedSessionBucket } from "./native-session-federation"
import type { SessionStatus } from "./types"

/**
 * What an agent is doing, in one vocabulary for every harness (the same one the machines and the hub
 * use): working, blocked on a person, idle, or one of the three ways it ends.
 *
 * The rail's federation buckets (`active`, `attention`, `failed`, `completed`, `recent`) stay the single
 * source of truth for "what state is this Session in", including live observation; this only refines them
 * (a stopped agent is not a failed one) and names them for grouping.
 */
export type AgentActivity = "working" | "needs_input" | "idle" | "completed" | "failed" | "stopped"

/** The order groups appear in when grouped by status: what needs a look first. */
export const ACTIVITY_ORDER: readonly AgentActivity[] = ["needs_input", "working", "failed", "completed", "stopped", "idle"]

/** Nothing is running any more. A live agent is driven by its own process; a finished one can be continued. */
export const TERMINAL_ACTIVITIES: readonly AgentActivity[] = ["completed", "failed", "stopped"]

const STOPPED_STATUS = new Set(["stopped", "cancelled", "canceled", "interrupted", "aborted"])

export function activityFromBucket(bucket: FederatedSessionBucket, status?: SessionStatus): AgentActivity {
  switch (bucket) {
    case "active": return "working"
    case "attention": return "needs_input"
    case "completed": return "completed"
    case "failed": return STOPPED_STATUS.has(status?.type?.trim().toLowerCase() || "") ? "stopped" : "failed"
    default: return "idle"
  }
}

/**
 * The status word the rest of the app already understands for each activity. A background agent reports
 * `done`/`blocked`/`running` on the wire; overlaying one of these onto the Session's status is what lets it
 * appear under the right filter and pill without a second status pipeline.
 */
export function statusTypeForActivity(activity: AgentActivity): string {
  switch (activity) {
    case "working": return "working"
    case "needs_input": return "blocked"
    case "completed": return "completed"
    case "failed": return "failed"
    case "stopped": return "stopped"
    default: return "idle"
  }
}

// ---- grouping ----------------------------------------------------------------------------------------------

/** `machine-project` is the original Machine → Project tree; the rest are flat or single-level groupings. */
export type GroupBy = "machine-project" | "none" | "status" | "project" | "machine" | "agent"
export const GROUP_BY_OPTIONS: readonly GroupBy[] = ["machine-project", "none", "status", "project", "machine", "agent"]

export type GroupableItem = {
  machineID: string
  machineLabel: string
  agentID: string
  agentLabel: string
  projectKey: string
  projectLabel: string
  activity: AgentActivity
  /** When it last ran (falls back to when it started); 0 when the harness gave neither. */
  ranAt: number
}

export type ItemGroup<T> = {
  key: string
  /** For `status` groups this is the activity; for the rest it is the group's own label. */
  label: string
  activity?: AgentActivity
  items: T[]
  /** Most recent `ranAt` in the group, which is what groups are ordered by (except status). */
  ranAt: number
}

function byRecent<T extends GroupableItem>(left: T, right: T): number {
  return right.ranAt - left.ranAt
}

/**
 * Splits already-filtered items into groups, most recently active first. Within a group the newest run
 * is first. `none` is one group: a plain "recent" feed across every machine and project.
 */
export function groupItems<T extends GroupableItem>(items: readonly T[], by: Exclude<GroupBy, "machine-project">): ItemGroup<T>[] {
  const sorted = [...items].sort(byRecent)
  if (by === "none") {
    return sorted.length ? [{ key: "recent", label: "recent", items: sorted, ranAt: sorted[0].ranAt }] : []
  }
  const groups = new Map<string, ItemGroup<T>>()
  for (const item of sorted) {
    const [key, label] = keyAndLabel(item, by)
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
    } else {
      groups.set(key, { key, label, activity: by === "status" ? item.activity : undefined, items: [item], ranAt: item.ranAt })
    }
  }
  const result = [...groups.values()]
  if (by === "status") {
    return result.sort((left, right) => ACTIVITY_ORDER.indexOf(left.activity!) - ACTIVITY_ORDER.indexOf(right.activity!))
  }
  // Ties (equal recency) fall back to the label so the order never shuffles between refreshes.
  return result.sort((left, right) => right.ranAt - left.ranAt || left.label.localeCompare(right.label))
}

function keyAndLabel(item: GroupableItem, by: Exclude<GroupBy, "machine-project" | "none">): [string, string] {
  switch (by) {
    case "status": return [item.activity, item.activity]
    case "project": return [item.projectKey, item.projectLabel]
    case "machine": return [item.machineID, item.machineLabel]
    case "agent": return [item.agentID, item.agentLabel]
  }
}

// ---- time window --------------------------------------------------------------------------------------------

export type RecentWindow = "any" | "1h" | "24h" | "7d"
export const RECENT_WINDOWS: readonly RecentWindow[] = ["any", "1h", "24h", "7d"]
const WINDOW_MS: Record<Exclude<RecentWindow, "any">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }

/** True when something last ran inside the window. Something with no timestamp at all is never "recent". */
export function ranWithin(ranAt: number, window: RecentWindow, now = Date.now()): boolean {
  if (window === "any") return true
  return ranAt > 0 && now - ranAt <= WINDOW_MS[window]
}

// ---- remembered choices --------------------------------------------------------------------------------------

export const GROUP_BY_STORAGE_KEY = "harness-remote.sessionGroupBy.v1"
export const RECENT_WINDOW_STORAGE_KEY = "harness-remote.sessionRecentWindow.v1"

function storage(): Storage | null {
  try { return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage } catch { return null }
}

export function loadGroupBy(): GroupBy {
  try {
    const value = storage()?.getItem(GROUP_BY_STORAGE_KEY)
    return GROUP_BY_OPTIONS.includes(value as GroupBy) ? (value as GroupBy) : "machine-project"
  } catch {
    return "machine-project"
  }
}

export function saveGroupBy(value: GroupBy): void {
  try { storage()?.setItem(GROUP_BY_STORAGE_KEY, value) } catch { /* private mode, blocked storage: the choice just is not remembered */ }
}

export function loadRecentWindow(): RecentWindow {
  try {
    const value = storage()?.getItem(RECENT_WINDOW_STORAGE_KEY)
    return RECENT_WINDOWS.includes(value as RecentWindow) ? (value as RecentWindow) : "any"
  } catch {
    return "any"
  }
}

export function saveRecentWindow(value: RecentWindow): void {
  try { storage()?.setItem(RECENT_WINDOW_STORAGE_KEY, value) } catch { /* see saveGroupBy */ }
}
