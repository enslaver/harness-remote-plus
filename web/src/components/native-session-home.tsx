import { useEffect, useMemo, useSyncExternalStore, type ComponentProps } from "react"
import {
  NativeSessionHome as NativeSessionHomeWithAttention,
  appendCursorPage,
  attentionInboxCounts,
  refreshCursorPage,
  sessionTreeRows
} from "./native-session-home-attention"
import { nativeSessionConfig } from "../native-session-discovery"
import {
  sessionIndexInvalidationRevision,
  subscribeSessionIndexInvalidation
} from "../session-index-live-state"
import { subscribeTaskDeskLiveEvents } from "../taskdesk-live-events"
import type { MachineAgentHost } from "../types"

export { appendCursorPage, attentionInboxCounts, refreshCursorPage, sessionTreeRows }

export type {
  AttentionInboxCounts,
  CursorPageState
} from "./native-session-home-attention"

type Props = ComponentProps<typeof NativeSessionHomeWithAttention>

export function needsOpenCodeRailStream(agent: MachineAgentHost): boolean {
  return agent.backend === "opencode"
    && agent.state === "available"
    && agent.capabilities?.sessions !== false
    && agent.capabilities?.questions !== true
    && agent.capabilities?.permissions !== true
}

/**
 * Session lifecycle is not part of `/v1/machine`, so a live edge must invalidate the Session read
 * directly rather than smuggling client-only state into the daemon snapshot. Cloning only the
 * source wrappers preserves the real machine payload while making the existing discovery effect
 * observe the lifecycle revision. Manual refreshToken semantics remain untouched.
 *
 * OpenCode needs one persistent agent-routed stream to own rail lifecycle because an unscoped daemon
 * stream may belong to a different primary ACP. The Attention layer already owns such a routed stream
 * when OpenCode advertises questions/permissions, so this wrapper opens only the fallback needed by
 * an available OpenCode agent without those capabilities. That preserves one lifecycle owner per
 * routed OpenCode agent without adding ACP streams, per-Session observers, polling, or waking a lazy
 * configured OpenCode host just because the rail is visible. The selected detail stream remains
 * presentation/transcript-only.
 */
export function NativeSessionHome(props: Props) {
  const liveRevision = useSyncExternalStore(
    subscribeSessionIndexInvalidation,
    sessionIndexInvalidationRevision,
    sessionIndexInvalidationRevision
  )
  const liveSources = useMemo(
    () => props.sources.map((source) => ({ ...source })),
    [props.sources, liveRevision]
  )

  const routedStreamSignature = props.sources.map(({ machine, snapshot, state }) => [
    machine.id,
    machine.config.host,
    machine.config.port,
    machine.config.basePath || "",
    machine.config.username,
    machine.config.password,
    state,
    snapshot?.machine.id || "",
    state === "online"
      ? snapshot?.agents
        .filter(needsOpenCodeRailStream)
        .map((agent) => `${agent.id}:${agent.backend}:${agent.transport}:${agent.state}`)
        .join(",") || ""
      : ""
  ].join("\u0000")).join("\u0001")

  useEffect(() => {
    const subscriptions = props.sources.flatMap(({ machine, snapshot, state }) => {
      if (!snapshot || state !== "online") return []
      return snapshot.agents
        .filter(needsOpenCodeRailStream)
        .map((agent) => subscribeTaskDeskLiveEvents({
          config: nativeSessionConfig(machine.config, agent),
          trackSessionIndex: true,
          // Lifecycle normalization/cache happens inside the shared transport. The rail discovery
          // reacts through useSyncExternalStore above; it does not need another per-event callback.
          onEvent: () => undefined
        }))
    })
    return () => {
      for (const subscription of subscriptions) subscription.close()
    }
    // Endpoint + OpenCode routing semantics, not source array identity: machine refreshes rebuild
    // wrappers even when routing is unchanged. Reopening the SSE stream on each render loses edges.
  }, [routedStreamSignature])

  return <NativeSessionHomeWithAttention {...props} sources={liveSources} />
}
