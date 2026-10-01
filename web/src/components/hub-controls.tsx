import { useRef, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import type { DesktopHubState } from "../../electron/ipc-contract"
import { useDialogDismiss } from "../useDialogDismiss"
import "./hub-controls.css"

export type HubControlsProps = {
  /** Present when this page is served by a hub: the link is to that hub's console, on the same origin. */
  servedByHub?: { name: string }
  /** Present in the desktop app: the hub it is configured for, and the means to change that. */
  desktop?: {
    state: DesktopHubState | null
    onConfigure: (url: string, token: string) => Promise<void>
    onDisconnect: () => Promise<void>
    onOpen: () => void
  }
}

const STATUS_TEXT: Record<DesktopHubState["status"], string> = {
  off: "Not connected",
  enrolling: "Registering this machine with the hub…",
  connected: "Connected",
  error: "Cannot reach the hub"
}

function HubConfigDialog({ state, onConfigure, onDisconnect, onClose }: {
  state: DesktopHubState | null
  onConfigure: (url: string, token: string) => Promise<void>
  onDisconnect: () => Promise<void>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogDismiss(dialogRef, onClose)
  const fromEnvironment = state?.source === "environment"
  const [url, setUrl] = useState(state?.url ?? "")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (failure) {
      // Electron wraps main's message as "Error invoking remote method '…': Error: <message>".
      const message = failure instanceof Error ? failure.message : "Could not save the hub settings"
      setError(message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ""))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!fromEnvironment) void run(() => onConfigure(url, token))
  }

  return (
    <div className="uw-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="uw-machine-manager hr-hub-config" role="dialog" aria-modal="true" aria-label="Configure hub" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <header className="uw-machine-manager-header">
          <div>
            <h2>Configure hub</h2>
            <p>Register this computer with a Harness Remote Hub and list the hub's machines here.</p>
          </div>
          <button type="button" className="uw-manager-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form className="hr-hub-config-form" onSubmit={submit}>
          {fromEnvironment ? (
            <p className="hr-hub-config-note" role="status">
              The hub is set by <code>HARNESS_REMOTE_HUB_URL</code> in this app's environment, so it can only be changed there.
            </p>
          ) : null}
          <label>
            <span>Hub address</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="hub.example.com:8080" disabled={fromEnvironment || busy} autoComplete="off" spellCheck={false} required />
          </label>
          <label>
            <span>Enrollment token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={fromEnvironment ? "Set in the environment" : state?.tokenSet ? "Saved; enter a new one to replace it" : "The hub's HUB_ENROLLMENT_TOKEN"}
              disabled={fromEnvironment || busy}
              autoComplete="off"
              spellCheck={false}
              required={!fromEnvironment && state?.source !== "daemon"}
            />
          </label>
          {state?.source === "daemon" ? (
            <p className="hr-hub-config-note" role="status">This computer is already registered with this hub, so the app follows it automatically.</p>
          ) : null}
          {state?.configured ? (
            <p className={`hr-hub-config-status ${state.status}`} role="status">
              {STATUS_TEXT[state.status]}{state.status === "connected" ? ` · ${state.machines.length} other ${state.machines.length === 1 ? "machine" : "machines"}` : ""}
              {state.error ? <><br />{state.error}</> : null}
            </p>
          ) : null}
          {error ? <p className="hr-hub-config-error" role="alert">{error}</p> : null}
          <footer className="hr-hub-config-actions">
            {state?.configured && !fromEnvironment && state.source !== "daemon" ? <button type="button" className="tdw-button secondary" disabled={busy} onClick={() => void run(onDisconnect)}>Disconnect</button> : null}
            <button type="button" className="tdw-button secondary" onClick={onClose}>Cancel</button>
            {fromEnvironment ? null : <button type="submit" className="tdw-button" disabled={busy}>{busy ? "Connecting…" : "Save and connect"}</button>}
          </footer>
        </form>
      </section>
    </div>
  )
}

/** The hub entry points in the top bar: a link to the hub when there is one, and, on desktop, the way to set it up. */
export function HubControls({ servedByHub, desktop }: HubControlsProps) {
  const [open, setOpen] = useState(false)
  const base = import.meta.env.BASE_URL
  const hubLinked = Boolean(desktop?.state?.configured && desktop.state.url)
  return (
    <>
      {servedByHub ? (
        <a className="tdw-button secondary hr-hub-link" href={`${base}hub/`} title={`Open ${servedByHub.name}`}>Hub</a>
      ) : null}
      {desktop && hubLinked ? (
        <button type="button" className="tdw-button secondary hr-hub-link" onClick={desktop.onOpen} title={`Open the hub console (${desktop.state?.url})`}>Hub</button>
      ) : null}
      {desktop ? (
        <button type="button" className="tdw-button secondary hr-hub-configure" onClick={() => setOpen(true)}>{hubLinked ? "Hub settings" : "Configure hub"}</button>
      ) : null}
      {open && desktop ? createPortal(
        <HubConfigDialog state={desktop.state} onConfigure={desktop.onConfigure} onDisconnect={desktop.onDisconnect} onClose={() => setOpen(false)} />,
        document.body
      ) : null}
    </>
  )
}
