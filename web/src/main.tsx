import React, { useEffect, useMemo, useRef, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import type { DesktopHubState, DesktopLocalRuntimeState } from "../electron/ipc-contract"
import { installAppPreferences } from "./appPreferences"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import {
  clearDesktopHub,
  configureDesktopHub,
  desktopHubState,
  desktopLocalRuntimeState,
  openDesktopHub,
  isDesktopPlatform,
  retryDesktopLocalRuntime,
  syncDesktopProfiles
} from "./desktopBridge"
import { clientEnvironment, installClientErrorReporting, postClientLogs } from "./clientLog"
import { ErrorBoundary } from "./ErrorBoundary"
import { desktopHubWorkspaceMachines, fetchHubBootstrap, sameHubMachines } from "./hubBootstrap"
import { HubControls } from "./components/hub-controls"
import { installIosSafari } from "./iosSafari"
import {
  claimMachinePairing,
  scanAndroidMachinePairing,
  subscribeAndroidMachinePairing,
  upsertPairedMachine,
  type MachinePairingActivation
} from "./machine-pairing"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import { useTranslator } from "./useTranslator"
import {
  DESKTOP_LOCAL_MACHINE_ID,
  isRuntimeOwnedMachine,
  loadWorkspaceMachines,
  persistWorkspaceMachines,
  type WorkspaceMachine
} from "./workspaceMachines"
import "./styles.css"
import "./taskdesk-theme.css"
import "./universal-workspace-readable-fixes.css"
import "./taskdesk-v3-unified.css"
import "./conversation-control-plane-overrides.css"
import "./conversation-control-plane-mobile-polish.css"
import "./v3-mobile-regression-fixes.css"
import "./v3-mobile-landscape-grid-fix.css"
import "./v3-mobile-workspace-switcher-polish.css"
import "./v3-mobile-a11y-fix.css"
import "./v3-mobile-product-parity.css"
import "./session-first-navigation.css"
import "./session-first-workbench.css"
import "./conversation-base.css"
import "./session-first-centering-fix.css"
import "./session-handoff-routing.css"
import "./machine-pairing.css"
// Loaded last: the ported controls refine rules the sheets above already set, and settling those
// ties by load order is what keeps the port free of `!important`.
import "./beautiful-ui-controls.css"
// iOS Safari only (scoped to html[data-hr-ios]); after everything else so it settles ties by load order.
import "./ios-safari.css"

installAppPreferences()
installCompletionAudioGuard()
installIosSafari()

type PairingNotice = {
  kind: "working" | "success" | "error"
  text: string
}

function localRuntimeMachine(state: DesktopLocalRuntimeState | null): WorkspaceMachine | null {
  if (state?.status !== "ready") return null
  return {
    id: DESKTOP_LOCAL_MACHINE_ID,
    name: "This computer",
    config: {
      backend: "opencode",
      host: state.machine.host,
      port: state.machine.port,
      // Credentials intentionally stay in Electron main. desktopBridge maps this loopback endpoint
      // to the main-owned volatile profile before any request or event subscription is dispatched.
      username: "",
      password: ""
    }
  }
}

const HUB_SIGNIN_REDIRECT_KEY = "harness-remote.hub.signin-redirect"
const HUB_POLL_MS = 30_000
const HUB_RETRY_MS = 15_000
const HUB_MAX_UNDETECTED_RETRIES = 4

/**
 * Served by a hub, this app asks it which machines exist (see hubBootstrap.ts). Anywhere else the ask
 * gets a definitive "no" and nothing changes. Hub machines are runtime-owned projections, exactly like
 * the desktop app's own runtime: shown, never persisted, never edited here.
 */
function useHubMachines(enabled: boolean) {
  const [phase, setPhase] = useState<"loading" | "settled">(enabled ? "loading" : "settled")
  const [machines, setMachines] = useState<WorkspaceMachine[]>([])
  const [slow, setSlow] = useState(false)
  const [name, setName] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let detected = false
    let undetectedRetries = 0
    let stopReporting: (() => void) | undefined
    const slowTimer = setTimeout(() => setSlow(true), 800)
    const settle = () => { if (!cancelled) setPhase("settled") }

    const poll = async (): Promise<void> => {
      const result = await fetchHubBootstrap()
      if (cancelled) return
      clearTimeout(timer)
      if (result.kind === "signin") {
        // Sign in on the hub console, which returns here. Once per short window: if the cookie cannot
        // be kept (blocked storage), redirecting again would bounce the user forever.
        let recent = false
        try {
          recent = Date.now() - Number(sessionStorage.getItem(HUB_SIGNIN_REDIRECT_KEY)) < 20_000
          if (!recent) sessionStorage.setItem(HUB_SIGNIN_REDIRECT_KEY, String(Date.now()))
        } catch {
          recent = true
        }
        if (!recent) {
          location.replace(`${import.meta.env.BASE_URL}hub/?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`)
          return
        }
        settle()
        return
      }
      if (result.kind === "ready") {
        detected = true
        setName(result.name)
        stopReporting ??= installClientErrorReporting({ post: postClientLogs(import.meta.env.BASE_URL), environment: clientEnvironment })
        setMachines((current) => (sameHubMachines(current, result.machines) ? current : result.machines))
        settle()
        timer = setTimeout(() => void poll(), HUB_POLL_MS)
        return
      }
      settle()
      if (result.kind === "unavailable" && (detected || undetectedRetries < HUB_MAX_UNDETECTED_RETRIES)) {
        // Could not tell. Never hold the app hostage to a hub that is not answering: it renders now and
        // this asks again. A host that never proves to be a hub (offline PWA on GitHub Pages) gives up.
        if (!detected) undetectedRetries += 1
        timer = setTimeout(() => void poll(), HUB_RETRY_MS)
      }
      // `none` is definitive: this is not a hub.
    }
    void poll()

    // iOS suspends a backgrounded page; refresh the machine list the moment it is visible again.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !detected) return
      clearTimeout(timer)
      void poll()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(slowTimer)
      document.removeEventListener("visibilitychange", onVisible)
      stopReporting?.()
    }
  }, [enabled])

  return { phase, machines, slow, name }
}

/**
 * The desktop app's hub: Electron main enrolls the embedded daemon with the configured hub and keeps
 * the hub's other machines as main-owned profiles. This only mirrors that state so the machines and
 * the hub link appear, and carries the Configure hub form's requests across.
 */
function useDesktopHub() {
  const [state, setState] = useState<DesktopHubState | null>(null)
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const next = await desktopHubState()
        if (cancelled) return
        setState((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
        timer = setTimeout(refresh, next?.status === "connected" ? 10_000 : 2_000)
      } catch {
        if (!cancelled) timer = setTimeout(refresh, 10_000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  const machines = useMemo(() => desktopHubWorkspaceMachines(state), [state])
  return {
    state,
    machines,
    configure: async (url: string, token: string) => { setState(await configureDesktopHub(url, token)) },
    disconnect: async () => { setState(await clearDesktopHub()) },
    open: () => { void openDesktopHub() }
  }
}

function HarnessRemoteBoundary() {
  const t = useTranslator()
  const [revision, setRevision] = useState(0)
  const persistedMachines = useMemo(loadWorkspaceMachines, [revision])
  const [localRuntime, setLocalRuntime] = useState<DesktopLocalRuntimeState | null>(null)
  const hub = useHubMachines(!isDesktopPlatform() && !Capacitor.isNativePlatform())
  const desktopHub = useDesktopHub()
  const machines = useMemo(() => {
    const local = localRuntimeMachine(localRuntime)
    const owned = [...(local ? [local] : []), ...hub.machines, ...desktopHub.machines]
    return owned.length ? [...owned, ...persistedMachines.filter((machine) => !isRuntimeOwnedMachine(machine))] : persistedMachines
  }, [localRuntime, hub.machines, desktopHub.machines, persistedMachines])
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const pairingInFlightRef = useRef(new Set<string>())
  const pairedGrantRef = useRef(new Set<string>())
  const [desktopReady, setDesktopReady] = useState(() => !isDesktopPlatform())
  const [desktopSyncError, setDesktopSyncError] = useState<Error | null>(null)
  const [pairingNotice, setPairingNotice] = useState<PairingNotice | null>(null)
  const [pairingScanBusy, setPairingScanBusy] = useState(false)
  const [pairingSuccessRevision, setPairingSuccessRevision] = useState(0)
  const [pairingSuccessMachineName, setPairingSuccessMachineName] = useState<string | null>(null)

  // Persistent remote-machine profiles are still acknowledged before the workspace starts issuing
  // requests. The desktop-owned local runtime is intentionally absent from this snapshot: its
  // credentials live only in Electron main's volatile registry.
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    void syncDesktopProfiles(persistedMachines).then(
      () => { if (!cancelled) setDesktopReady(true) },
      (error: unknown) => {
        if (!cancelled) setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
      }
    )
    return () => { cancelled = true }
    // Initial bootstrap only. Later edits synchronize before revision exposes the new machine list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Main starts the embedded daemon independently so a missing local harness cannot block the app.
  // Poll its tiny public state: fast while starting, then slowly enough to notice an unexpected exit
  // and remove the stale loopback endpoint without turning this into another machine refresh loop.
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const state = await desktopLocalRuntimeState()
        if (cancelled) return
        setLocalRuntime(state)
        timer = setTimeout(refresh, state?.status === "starting" ? 400 : 4_000)
      } catch (error) {
        if (cancelled) return
        setLocalRuntime({
          status: "unavailable",
          error: error instanceof Error ? error.message : "Local desktop runtime is unavailable."
        })
        timer = setTimeout(refresh, 4_000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const persistMachines = (nextMachines: WorkspaceMachine[]) => {
    // Runtime-owned machines are projections, not settings. Even an edit/remove attempt from a stale
    // manager surface cannot serialize them or replace the main-process profile.
    const persistent = nextMachines.filter((machine) => !isRuntimeOwnedMachine(machine))
    persistWorkspaceMachines(persistent)
    if (!isDesktopPlatform()) {
      setRevision((value) => value + 1)
      return
    }
    void syncDesktopProfiles(persistent).then(
      () => setRevision((value) => value + 1),
      (error: unknown) => setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
    )
  }

  async function retryLocalRuntime(): Promise<void> {
    setLocalRuntime({ status: "starting" })
    try {
      setLocalRuntime(await retryDesktopLocalRuntime())
    } catch (error) {
      setLocalRuntime({
        status: "unavailable",
        error: error instanceof Error ? error.message : "Local desktop runtime is unavailable."
      })
    }
  }

  async function claimPairingActivation(activation: MachinePairingActivation): Promise<void> {
    const grantKey = `${activation.endpoint}\u0000${activation.token}`
    if (pairedGrantRef.current.has(grantKey) || pairingInFlightRef.current.has(grantKey)) return
    pairingInFlightRef.current.add(grantKey)
    setPairingNotice({ kind: "working", text: t("sf.pairingConnecting") })
    try {
      const paired = await claimMachinePairing(activation)
      pairedGrantRef.current.add(grantKey)
      const nextMachines = upsertPairedMachine(machinesRef.current, paired)
      machinesRef.current = nextMachines
      persistMachines(nextMachines)
      setPairingSuccessMachineName(paired.name)
      setPairingSuccessRevision((value) => value + 1)
      setPairingNotice({ kind: "success", text: t("sf.pairingConnected", { name: paired.name }) })
    } catch (error) {
      // A transport failure does not imply the daemon consumed the grant. A re-scan therefore gets
      // another chance until the server itself reports used/expired.
      setPairingNotice({
        kind: "error",
        text: error instanceof Error ? error.message : t("sf.pairingFailed")
      })
    } finally {
      pairingInFlightRef.current.delete(grantKey)
    }
  }

  useEffect(() => subscribeAndroidMachinePairing((activation) => {
    void claimPairingActivation(activation)
  }), [])

  async function scanPairingQR(): Promise<void> {
    if (pairingScanBusy) return
    setPairingScanBusy(true)
    try {
      const activation = await scanAndroidMachinePairing()
      if (activation) await claimPairingActivation(activation)
    } catch (error) {
      setPairingNotice({
        kind: "error",
        text: error instanceof Error ? error.message : t("sf.qrPairingFailed")
      })
    } finally {
      setPairingScanBusy(false)
    }
  }

  if (desktopSyncError) throw desktopSyncError
  if (hub.phase === "loading") {
    // Blank at first: on a host that is not a hub the answer arrives in a blink, and flashing a
    // "connecting" screen at every visitor would be noise. Words only appear if it is actually slow.
    return (
      <div className="uw-standalone-host" aria-busy="true">
        {hub.slow ? <div className="hr-native-workspace-empty hr-native-startup connecting" role="status">Connecting…</div> : null}
      </div>
    )
  }
  if (!desktopReady) {
    return (
      <div className="uw-standalone-host" aria-busy="true">
        <div className="hr-native-workspace-empty hr-native-startup connecting" role="status">
          Preparing desktop connection…
        </div>
      </div>
    )
  }

  return (
    <>
      <StandaloneUniversalWorkspace
        hubControls={
          <HubControls
            servedByHub={hub.name ? { name: hub.name } : undefined}
            desktop={isDesktopPlatform() ? { state: desktopHub.state, onConfigure: desktopHub.configure, onDisconnect: desktopHub.disconnect, onOpen: desktopHub.open } : undefined}
          />
        }
        machines={machines}
        onPersistMachines={persistMachines}
        onScanMachinePairing={Capacitor.getPlatform() === "android" ? scanPairingQR : undefined}
        machinePairingBusy={pairingScanBusy}
        machinePairingSuccessRevision={pairingSuccessRevision}
        machinePairingSuccessMachineName={pairingSuccessMachineName}
      />
      {isDesktopPlatform() && localRuntime?.status === "unavailable" ? (
        <div className="hr-machine-pairing-notice error" role="status" aria-live="polite">
          <span><strong>Local desktop runtime</strong>{localRuntime.error}</span>
          <button type="button" onClick={() => void retryLocalRuntime()}>Retry</button>
        </div>
      ) : null}
      {pairingNotice ? (
        <div
          className={`hr-machine-pairing-notice ${pairingNotice.kind}`}
          role={pairingNotice.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span><strong>{t("sf.machinePairing")}</strong>{pairingNotice.text}</span>
          <button type="button" onClick={() => setPairingNotice(null)} aria-label={t("sf.dismissPairingStatus")}>×</button>
        </div>
      ) : null}
    </>
  )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary resetKeys={SERVER_STORAGE_KEYS}>
      <HarnessRemoteBoundary />
    </ErrorBoundary>
  </React.StrictMode>
)

if (import.meta.env.DEV && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop) {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    )
  }
  if ("caches" in window) {
    void caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("harness-remote-")).map((key) => caches.delete(key)))
    )
  }
}

if (import.meta.env.PROD && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {})
  })
}