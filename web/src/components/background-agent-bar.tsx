import { useCallback, useEffect, useRef, useState } from "react"
import { activityLabels } from "../agent-activity-labels"
import { TERMINAL_ACTIVITIES, type AgentActivity } from "../agent-activity"
import { backgroundAgentBySession, backgroundAgentClient, type BackgroundAgent } from "../background-agents"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { useLanguage } from "../useTranslator"
import { LoadingIcon, RefreshIcon } from "../Icons"
import "../agent-activity.css"

const LIVE_POLL_MS = 5_000
const FINISHED_POLL_MS = 30_000

type Props = {
  target: NativeSessionSurfaceTarget
  /** Called after an action changed something the Session list shows (stop, continue, remove). */
  onChanged?: () => void
  /** True while the agent is running: the transcript is read-only and should keep refreshing. */
  onLiveChange?: (live: boolean) => void
  /** Ticks while a live agent's transcript should be re-read, and once more when it finishes. */
  onRefreshTick?: () => void
}

/**
 * What a Session known to be a Claude Code background agent needs above it: what it is doing, when it started
 * and last ran, and the few things the machine lets you do (read its output, stop it, or - once it has
 * finished - continue it in the background or remove it). Renders nothing for an ordinary Session.
 */
export function BackgroundAgentBar({ target, onChanged, onLiveChange, onRefreshTick }: Props) {
  const language = useLanguage()
  const labels = activityLabels(language)
  const [agent, setAgent] = useState<BackgroundAgent | undefined>()
  const [logs, setLogs] = useState<{ text: string; truncated: boolean } | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [busy, setBusy] = useState<"stop" | "remove" | "resume" | "logs" | null>(null)
  const [continueOpen, setContinueOpen] = useState(false)
  // An inline confirmation, not a native dialog: the Android WebView renders those as a bare system alert.
  const [confirming, setConfirming] = useState<"stop" | "remove" | null>(null)
  const [prompt, setPrompt] = useState("")
  const [error, setError] = useState<string | null>(null)
  const previousActivity = useRef<AgentActivity | undefined>(undefined)
  const onLiveChangeRef = useRef(onLiveChange)
  const onRefreshTickRef = useRef(onRefreshTick)
  onLiveChangeRef.current = onLiveChange
  onRefreshTickRef.current = onRefreshTick
  const isClaude = target.backend === "claude"

  const load = useCallback(async (signal?: { cancelled: boolean }): Promise<BackgroundAgent | undefined> => {
    const listed = await backgroundAgentClient.list(target.config)
    if (signal?.cancelled) return undefined
    const found = backgroundAgentBySession(listed.agents).get(target.sessionID)
    setAgent(found)
    return found
  }, [target.config, target.sessionID])

  // Read the agent once. If the Session is one, keep reading: quickly while it runs, slowly once it has ended.
  useEffect(() => {
    setAgent(undefined)
    setLogs(null)
    setLogsOpen(false)
    setContinueOpen(false)
    setConfirming(null)
    setPrompt("")
    setError(null)
    previousActivity.current = undefined
    onLiveChangeRef.current?.(false)
    if (!isClaude) return
    const signal = { cancelled: false }
    let timer: number | undefined
    const tick = async () => {
      if (signal.cancelled) return
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(() => void tick(), LIVE_POLL_MS)
        return
      }
      const found = await load(signal).catch(() => undefined)
      if (signal.cancelled || !found) return
      const live = !TERMINAL_ACTIVITIES.includes(found.activity)
      if (live) onRefreshTickRef.current?.()
      timer = window.setTimeout(() => void tick(), live ? LIVE_POLL_MS : FINISHED_POLL_MS)
    }
    void tick()
    return () => {
      signal.cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      onLiveChangeRef.current?.(false)
    }
  }, [isClaude, load, target.key])

  // Tell the workspace whether the transcript is read-only, and re-read it once when the agent finishes.
  useEffect(() => {
    const live = Boolean(agent) && !TERMINAL_ACTIVITIES.includes(agent!.activity)
    onLiveChangeRef.current?.(live)
    const before = previousActivity.current
    if (before && agent && before !== agent.activity && TERMINAL_ACTIVITIES.includes(agent.activity)) onRefreshTickRef.current?.()
    previousActivity.current = agent?.activity
  }, [agent])

  const loadLogs = useCallback(async () => {
    if (!agent?.id) return
    setBusy("logs")
    try {
      setLogs(await backgroundAgentClient.logs(target.config, agent.id))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy((current) => (current === "logs" ? null : current))
    }
  }, [agent?.id, target.config])

  // Output follows a running agent while it is open.
  useEffect(() => {
    if (!logsOpen || !agent?.id) return
    void loadLogs()
    if (TERMINAL_ACTIVITIES.includes(agent.activity)) return
    const timer = window.setInterval(() => void loadLogs(), LIVE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [logsOpen, agent?.id, agent?.activity, loadLogs])

  if (!isClaude || !agent) return null
  const live = !TERMINAL_ACTIVITIES.includes(agent.activity)
  const bar = labels.bar

  async function act(kind: "stop" | "remove" | "resume", work: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await work()
      await load()
      onChanged?.()
    } catch (reason) {
      setError(`${bar.failed} ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const started = agent.startedAt ? new Date(agent.startedAt).toLocaleString() : ""
  const ran = agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : ""

  return (
    <section className="hr-bg-agent-bar" data-activity={agent.activity} aria-label={labels.backgroundTitle}>
      <div className="hr-bg-agent-summary">
        <span className="hr-bg-agent-pill" data-activity={agent.activity}>{labels.activity[agent.activity]}</span>
        <span className="hr-native-session-bg" title={labels.backgroundTitle}>{labels.background}</span>
        {agent.subagents?.total ? <span className="hr-bg-agent-sub" title={bar.subagents}>{bar.subagents} {agent.subagents.running}/{agent.subagents.total}{agent.subagents.failed ? ` · ${agent.subagents.failed} ✕` : ""}</span> : null}
        <span className="hr-bg-agent-times">
          {started ? <>{labels.started} {started}</> : null}{started && ran ? " · " : ""}{ran ? <>{labels.lastRan} {ran}</> : null}
        </span>
      </div>

      {live ? <p className="hr-bg-agent-note" role="status">{bar.followingLive}</p> : null}
      {agent.activity === "needs_input" ? (
        <p className="hr-bg-agent-note needs" role="status">
          {agent.needs ? <strong>{agent.needs} </strong> : null}
          {bar.answerInTerminal} <code>claude attach {agent.id}</code>
        </p>
      ) : agent.detail ? <p className="hr-bg-agent-note">{agent.detail}</p> : null}

      {confirming ? (
        <div className="hr-bg-agent-confirm" role="group" aria-label={confirming === "stop" ? bar.stopConfirm : bar.removeConfirm}>
          <span>{confirming === "stop" ? bar.stopConfirm : bar.removeConfirm}</span>
          <div className="hr-bg-agent-actions">
            <button
              type="button"
              className="tdw-button secondary danger"
              onClick={() => {
                const kind = confirming
                setConfirming(null)
                void act(kind, () => (kind === "stop" ? backgroundAgentClient.stop(target.config, agent.id!) : backgroundAgentClient.remove(target.config, agent.id!)))
              }}
            >
              {confirming === "stop" ? bar.stop : bar.remove}
            </button>
            <button type="button" className="tdw-button secondary" onClick={() => setConfirming(null)}>{bar.cancel}</button>
          </div>
        </div>
      ) : (
      <div className="hr-bg-agent-actions">
        {agent.capabilities.logs && agent.id ? (
          <button type="button" className="tdw-button secondary" onClick={() => setLogsOpen((open) => !open)} aria-expanded={logsOpen}>
            {logsOpen ? bar.hideLogs : bar.logs}
          </button>
        ) : null}
        {agent.capabilities.stop && agent.id ? (
          <button
            type="button"
            className="tdw-button secondary"
            disabled={busy !== null}
            onClick={() => setConfirming("stop")}
          >
            {busy === "stop" ? <LoadingIcon size={14} /> : null} {bar.stop}
          </button>
        ) : null}
        {agent.capabilities.resume && agent.id ? (
          <button type="button" className="tdw-button secondary" disabled={busy !== null} onClick={() => setContinueOpen((open) => !open)} aria-expanded={continueOpen}>
            {bar.continueInBackground}
          </button>
        ) : null}
        {agent.capabilities.remove && agent.id ? (
          <button
            type="button"
            className="tdw-button secondary danger"
            disabled={busy !== null}
            onClick={() => setConfirming("remove")}
          >
            {busy === "remove" ? <LoadingIcon size={14} /> : null} {bar.remove}
          </button>
        ) : null}
      </div>
      )}

      {continueOpen && agent.capabilities.resume && agent.id ? (
        <form
          className="hr-bg-agent-continue"
          onSubmit={(event) => {
            event.preventDefault()
            const text = prompt.trim()
            if (!text || busy) return
            void act("resume", async () => {
              await backgroundAgentClient.resume(target.config, agent.id!, text)
              setPrompt("")
              setContinueOpen(false)
            })
          }}
        >
          <small>{bar.continueHint}</small>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={bar.continuePlaceholder} rows={3} maxLength={30_000} disabled={busy === "resume"} aria-label={bar.continueInBackground} />
          <button type="submit" className="tdw-button primary" disabled={!prompt.trim() || busy !== null}>
            {busy === "resume" ? <LoadingIcon size={14} /> : null} {bar.send}
          </button>
        </form>
      ) : null}

      {logsOpen ? (
        <div className="hr-bg-agent-logs">
          <div className="hr-bg-agent-logs-head">
            {logs?.truncated ? <small>{bar.logsTruncated}</small> : <span />}
            <button type="button" className="tdw-icon-button" onClick={() => void loadLogs()} disabled={busy === "logs"} aria-label={bar.refresh} title={bar.refresh}>
              {busy === "logs" ? <LoadingIcon size={14} /> : <RefreshIcon size={14} />}
            </button>
          </div>
          <pre tabIndex={0}>{logs ? (logs.text.trim() ? logs.text : bar.logsEmpty) : "…"}</pre>
        </div>
      ) : null}

      {error ? <div className="hr-bg-agent-error" role="alert">{error}</div> : null}
    </section>
  )
}
