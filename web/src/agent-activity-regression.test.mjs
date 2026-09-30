import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Source-text guards for the Session rail's grouping, time window, status chips and background agents. The
// behaviour itself is covered by agent-activity.test.mjs and background-agents.test.mjs; these pin the wiring
// that a refactor could quietly drop.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const rail = read("./components/native-session-home-base.tsx")
const workspace = read("./components/standalone-universal-workspace.tsx")
const bar = read("./components/background-agent-bar.tsx")
const observer = read("./components/native-session-observer.tsx")
const conversation = read("./components/work-thread-conversation.tsx")
const storageKeys = read("./storageKeys.ts")

test("the rail offers every grouping and the time window, remembers them, and keeps the original tree as the default", () => {
  assert.match(rail, /GROUP_BY_OPTIONS\.map\(\(option\)/, "every group-by option is a choice")
  assert.match(rail, /RECENT_WINDOWS\.map\(\(option\)/)
  assert.match(rail, /useState<GroupBy>\(loadGroupBy\)/, "the choice is read from storage lazily")
  assert.match(rail, /saveGroupBy\(value\)/)
  assert.match(rail, /saveRecentWindow\(value\)/)
  assert.match(read("./agent-activity.ts"), /return GROUP_BY_OPTIONS\.includes\(value as GroupBy\) \? \(value as GroupBy\) : "machine-project"/, "an unknown or missing choice is the original Machine › Project tree")
  assert.match(rail, /groupBy !== "machine-project" \?/, "the tree and the flat views are alternatives, not layered")
})

test("both layouts draw a Session with the same row, so it looks and behaves the same wherever it is listed", () => {
  assert.equal((rail.match(/function renderSessionRow\(/g) || []).length, 1)
  assert.match(rail, /visibleRows\.map\(\(\{ item, depth \}\) => renderSessionRow\(item,/)
  assert.match(rail, /group\.items\.map\(\(\{ item, projectLabel \}\) => renderSessionRow\(item,/)
  assert.match(rail, /showContext: false/, "under a project heading a row does not repeat where it is from")
  assert.match(rail, /showContext: groupBy !== "machine" \|\| sources\.length > 1/, "in a flat view a row says which machine and project it is from")
})

test("Completed and Failed are one tap away, and the time window filters what the tree shows too", () => {
  assert.match(rail, /filter === "completed"[\s\S]{0,200}labels\.activity\.completed/)
  assert.match(rail, /filter === "failed"[\s\S]{0,200}labels\.activity\.failed/)
  assert.match(rail, /if \(!ranWithin\(ranAtFor\(item\), recentWindow\)\) return false/)
  assert.match(rail, /recentWindow !== "any"\);?\s*\n?\s*if \(!projects\.length && filtering\)|filter !== "all" \|\| recentWindow !== "any"/, "an active window counts as filtering, so empty machines hide")
})

test("background agents are laid over the harness listing without touching the cached base records", () => {
  assert.match(rail, /const \[baseRecords, setRecords\] = useState<RecordWithMachine\[\]>\(\[\]\)/)
  assert.match(rail, /const records = useMemo\(\s*\(\) => withBackgroundAgents\(baseRecords, backgroundByMachine, sources, projectsByMachine\)/)
  assert.match(rail, /await listBackgroundAgents\(machine\.config\)/)
  assert.match(rail, /claudeAgentHost\(snapshot\.agents\)\)/, "only machines with the Claude harness are asked")
  assert.match(rail, /BACKGROUND_AGENT_REFRESH_MS/)
  // The CLI's live state must win over the harness listing's last-message status, on both status fields the rail reads.
  assert.match(rail, /record: \{ \.\.\.item\.record, status, session: \{ \.\.\.item\.record\.session, status,/)
})

test("a running background agent is followed read-only: the composer is disabled but live updates keep flowing", () => {
  assert.match(workspace, /readOnly=\{backgroundLive\}/)
  assert.match(workspace, /refreshSignal=\{backgroundRefresh\}/)
  assert.doesNotMatch(workspace, /interactionEnabled=\{selectedInteractionEnabled && !backgroundLive\}/, "interactionEnabled=false pauses observation; read-only must not")
  assert.match(observer, /readOnly=\{readOnly\}/)
  assert.match(conversation, /composerDisabled=\{!interactionEnabled \|\| modelBootstrapBlocked \|\| readOnly\}/)
  assert.match(conversation, /sendDisabled=\{[^}]*\|\| readOnly\}/)
  assert.match(conversation, /onStop=\{working && interactionEnabled && !readOnly \? stop : undefined\}/, "a read-only Session offers only the bar's Stop")
  assert.match(observer, /if \(refreshSignal\) handleTranscriptRefresh\(\)/)
  assert.match(workspace, /<BackgroundAgentBar\s+key=\{selected\.key\}/, "one bar per selected Session, reset on selection")
})

test("the bar offers only what the machine says is allowed, asks before anything destructive, and never invents an id", () => {
  assert.match(bar, /agent\.capabilities\.stop && agent\.id/)
  assert.match(bar, /agent\.capabilities\.resume && agent\.id/)
  assert.match(bar, /agent\.capabilities\.remove && agent\.id/)
  assert.match(bar, /agent\.capabilities\.logs && agent\.id/)
  // Destructive actions ask inline: window.confirm is a bare system alert in the Android WebView.
  assert.doesNotMatch(bar, /window\.confirm|\bconfirm\(/)
  assert.match(bar, /setConfirming\("stop"\)/)
  assert.match(bar, /setConfirming\("remove"\)/)
  assert.match(bar, /confirming === "stop" \? bar\.stopConfirm : bar\.removeConfirm/)
  assert.match(bar, /if \(!isClaude \|\| !agent\) return null/, "an ordinary Session gets no bar")
  assert.match(bar, /claude attach \{agent\.id\}/, "a blocked agent says how it can actually be answered")
  assert.doesNotMatch(bar, /--dangerously|bypassPermissions|discard-unpushed|force-remove/)
})

test("the remembered choices are part of the crash-recovery reset", () => {
  assert.match(storageKeys, /GROUP_BY_STORAGE_KEY,\s*\n\s*RECENT_WINDOW_STORAGE_KEY/)
})

test("the rail's markup stays phone-friendly: nothing new is fixed-width, and selects are labelled", () => {
  assert.match(rail, /aria-label=\{labels\.groupBy\}/)
  assert.match(rail, /aria-label=\{labels\.window\}/)
  const css = read("./agent-activity.css")
  assert.match(css, /\.hr-native-home \.hr-native-session-filters \{\s*display: flex;\s*flex-wrap: wrap;/, "five chips wrap instead of truncating")
  assert.match(css, /grid-template-columns: 1fr 1fr/, "the two dropdowns share a line")
  assert.match(css, /\.hr-bg-agent-continue textarea \{ font-size: 16px; \}/, "iOS does not zoom the page when the continue box is focused")
  assert.doesNotMatch(css, /(?<![-\w])width:\s*\d+px/, "no fixed widths (a max-width media query is fine)")
})
