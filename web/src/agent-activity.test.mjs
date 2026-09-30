import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTIVITY_ORDER,
  GROUP_BY_OPTIONS,
  GROUP_BY_STORAGE_KEY,
  RECENT_WINDOW_STORAGE_KEY,
  activityFromBucket,
  groupItems,
  loadGroupBy,
  loadRecentWindow,
  ranWithin,
  saveGroupBy,
  saveRecentWindow,
  statusTypeForActivity
} from "./agent-activity.ts"
import { ACTIVITY_LABELS, activityLabels } from "./agent-activity-labels.ts"
import { federatedSessionBucket } from "./native-session-federation.ts"

const item = (over) => ({
  machineID: "m1", machineLabel: "Studio", agentID: "claude", agentLabel: "Claude Code", projectKey: "m1:/repo", projectLabel: "repo", activity: "idle", ranAt: 1_000, ...over
})

test("buckets map onto the shared vocabulary, and a stopped agent is not a failed one", () => {
  assert.equal(activityFromBucket("active"), "working")
  assert.equal(activityFromBucket("attention"), "needs_input")
  assert.equal(activityFromBucket("completed"), "completed")
  assert.equal(activityFromBucket("recent"), "idle")
  assert.equal(activityFromBucket("failed", { type: "error" }), "failed")
  assert.equal(activityFromBucket("failed", { type: "stopped" }), "stopped")
  assert.equal(activityFromBucket("failed", { type: "Cancelled" }), "stopped")
  assert.equal(activityFromBucket("failed", { type: "interrupted" }), "stopped")
  assert.equal(activityFromBucket("failed"), "failed")
})

test("the status an overlay writes lands in the bucket it claims (the rail's own classifier agrees)", () => {
  // A background agent's activity is written onto the Session's status. The rail then classifies it with
  // federatedSessionBucket; if the two ever disagreed, an agent would show under the wrong filter.
  const expected = { working: "active", needs_input: "attention", completed: "completed", failed: "failed", stopped: "failed", idle: "recent" }
  for (const activity of ACTIVITY_ORDER) {
    const bucket = federatedSessionBucket({ type: statusTypeForActivity(activity) })
    assert.equal(bucket, expected[activity], activity)
    assert.equal(activityFromBucket(bucket, { type: statusTypeForActivity(activity) }), activity, `${activity} survives the round trip`)
  }
})

test("no grouping is one recent feed across every machine and project, newest run first", () => {
  const groups = groupItems([
    item({ machineID: "m1", ranAt: 10, projectKey: "a" }),
    item({ machineID: "m2", ranAt: 30, projectKey: "b" }),
    item({ machineID: "m1", ranAt: 20, projectKey: "c" })
  ], "none")
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].items.map((entry) => entry.ranAt), [30, 20, 10])
  assert.deepEqual(groupItems([], "none"), [])
})

test("grouping by status puts what needs a look first and keeps each group newest-first", () => {
  const groups = groupItems([
    item({ activity: "completed", ranAt: 5 }),
    item({ activity: "working", ranAt: 9 }),
    item({ activity: "failed", ranAt: 7 }),
    item({ activity: "needs_input", ranAt: 1 }),
    item({ activity: "completed", ranAt: 8 }),
    item({ activity: "stopped", ranAt: 3 }),
    item({ activity: "idle", ranAt: 2 })
  ], "status")
  assert.deepEqual(groups.map((group) => group.activity), ["needs_input", "working", "failed", "completed", "stopped", "idle"])
  assert.deepEqual(groups[3].items.map((entry) => entry.ranAt), [8, 5])
})

test("grouping by project, machine or agent orders groups by their most recent run, and is stable on ties", () => {
  const items = [
    item({ projectKey: "x", projectLabel: "alpha", ranAt: 5 }),
    item({ projectKey: "y", projectLabel: "beta", ranAt: 50 }),
    item({ projectKey: "z", projectLabel: "aardvark", ranAt: 5 }),
    item({ projectKey: "x", projectLabel: "alpha", ranAt: 4 })
  ]
  const byProject = groupItems(items, "project")
  assert.deepEqual(byProject.map((group) => group.label), ["beta", "aardvark", "alpha"], "beta is newest; the 5/5 tie falls back to the label")
  assert.deepEqual(byProject.map((group) => group.items.length), [1, 1, 2])

  const machines = groupItems([item({ machineID: "a", machineLabel: "A", ranAt: 1 }), item({ machineID: "b", machineLabel: "B", ranAt: 2 }), item({ machineID: "a", machineLabel: "A", ranAt: 3 })], "machine")
  assert.deepEqual(machines.map((group) => [group.label, group.items.length]), [["A", 2], ["B", 1]])

  const agents = groupItems([item({ agentID: "codex", agentLabel: "Codex", ranAt: 9 }), item({ agentID: "claude", agentLabel: "Claude Code", ranAt: 1 })], "agent")
  assert.deepEqual(agents.map((group) => group.label), ["Codex", "Claude Code"])
})

test("two machines' projects with the same name are different groups", () => {
  const groups = groupItems([item({ projectKey: "m1:/repo", ranAt: 2 }), item({ projectKey: "m2:/repo", machineID: "m2", ranAt: 1 })], "project")
  assert.equal(groups.length, 2)
})

test("grouping never mutates its input", () => {
  const items = [item({ ranAt: 1 }), item({ ranAt: 2 })]
  const snapshot = JSON.stringify(items)
  groupItems(items, "status")
  assert.equal(JSON.stringify(items), snapshot)
})

test("the time window is about when it last RAN, and something undated is never 'recent'", () => {
  const now = 10_000_000_000
  assert.equal(ranWithin(now - 1_000, "1h", now), true)
  assert.equal(ranWithin(now - 3_600_001, "1h", now), false)
  assert.equal(ranWithin(now - 23 * 3_600_000, "24h", now), true)
  assert.equal(ranWithin(now - 8 * 86_400_000, "7d", now), false)
  assert.equal(ranWithin(0, "1h", now), false)
  assert.equal(ranWithin(0, "any", now), true, "'any time' includes undated Sessions")
})

test("group-by and time-window choices are remembered, validated, and never throw when storage is unavailable", () => {
  const store = new Map()
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value) } }
  try {
    assert.equal(loadGroupBy(), "machine-project", "the original tree is the default")
    saveGroupBy("status")
    assert.equal(store.get(GROUP_BY_STORAGE_KEY), "status")
    assert.equal(loadGroupBy(), "status")
    store.set(GROUP_BY_STORAGE_KEY, "<script>")
    assert.equal(loadGroupBy(), "machine-project", "a corrupt value falls back")
    saveRecentWindow("24h")
    assert.equal(loadRecentWindow(), "24h")
    store.set(RECENT_WINDOW_STORAGE_KEY, "yesterday")
    assert.equal(loadRecentWindow(), "any")

    globalThis.localStorage = { getItem() { throw new Error("blocked") }, setItem() { throw new Error("blocked") } }
    assert.equal(loadGroupBy(), "machine-project")
    assert.doesNotThrow(() => saveGroupBy("none"))
    assert.doesNotThrow(() => saveRecentWindow("7d"))
  } finally {
    delete globalThis.localStorage
  }
})

test("every language names every activity, grouping and time window, and none is left blank", () => {
  const english = ACTIVITY_LABELS.en
  for (const [language, labels] of Object.entries(ACTIVITY_LABELS)) {
    for (const activity of ACTIVITY_ORDER) assert.ok(labels.activity[activity]?.trim(), `${language} activity ${activity}`)
    for (const option of GROUP_BY_OPTIONS) assert.ok(labels.group[option]?.trim(), `${language} group ${option}`)
    for (const window of ["any", "1h", "24h", "7d"]) assert.ok(labels.windows[window]?.trim(), `${language} window ${window}`)
    for (const key of Object.keys(english)) assert.ok(labels[key], `${language} is missing ${key}`)
    for (const key of Object.keys(english.bar)) assert.ok(labels.bar[key]?.trim(), `${language} is missing bar.${key}`)
    assert.equal(Object.keys(labels.bar).length, Object.keys(english.bar).length, `${language} has bar keys English lacks`)
  }
  assert.equal(activityLabels("en").activity.needs_input, "Needs you")
  assert.equal(activityLabels("fr").groupBy, "Group by", "an unknown language falls back to English")
})
