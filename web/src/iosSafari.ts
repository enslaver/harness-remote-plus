/**
 * iPhone/iPad Safari differences the rest of the app should not have to know about.
 *
 * Everything here is inert off iOS (`data-hr-ios` is never set), so Android, desktop and the native
 * shells keep exactly the behaviour they have today.
 *
 * Two things, both invisible to the eye until they go wrong:
 *
 *  1. Input zoom. iOS Safari zooms the whole page when a text field with a font size under 16px takes
 *     focus, and does not zoom back. The stylesheets use 10–14px in many tight mobile layouts, so the
 *     CSS pins entry fields to 16px on iOS (ios-safari.css) keyed off the attribute set here.
 *
 *  2. The on-screen keyboard. Chrome on Android resizes the layout (`interactive-widget` in index.html);
 *     Safari ignores that and instead shrinks only the *visual* viewport, leaving `100dvh` layouts full
 *     height so the composer ends up under the keyboard or the page pans. `visualViewport` reports the
 *     part that is really visible; this exposes it as `--hr-vv-height` and `data-hr-keyboard="open"`
 *     for the stylesheet to size the app to.
 */

export type NavigatorLike = { userAgent: string; platform?: string; maxTouchPoints?: number }

/** iPadOS 13+ reports itself as a Mac, so a "Mac" with a touch screen is an iPad. */
export function isIosDevice(nav: NavigatorLike): boolean {
  if (/iPhone|iPad|iPod/.test(nav.userAgent)) return true
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1
}

/** Below this the "keyboard" is just browser chrome (the collapsing URL bar is ~60–100px). */
export const KEYBOARD_OPEN_THRESHOLD_PX = 120

/** How much of the layout viewport the keyboard is covering. */
export function keyboardInset(layoutHeight: number, viewport: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
}

type ViewportLike = EventTarget & { height: number; offsetTop: number }
type WindowLike = {
  innerHeight: number
  scrollY: number
  visualViewport?: ViewportLike | null
  scrollTo: (x: number, y: number) => void
  addEventListener: (type: string, listener: () => void, options?: boolean) => void
  removeEventListener: (type: string, listener: () => void, options?: boolean) => void
}
type DocumentLike = { documentElement: { dataset: DOMStringMap; style: CSSStyleDeclaration } }

export type InstallOptions = { win?: WindowLike; doc?: DocumentLike; nav?: NavigatorLike }

export function installIosSafari(options: InstallOptions = {}): () => void {
  const win = options.win ?? (window as unknown as WindowLike)
  const doc = options.doc ?? (document as unknown as DocumentLike)
  const nav = options.nav ?? navigator
  if (!isIosDevice(nav)) return () => {}

  const root = doc.documentElement
  root.dataset.hrIos = "1"

  const viewport = win.visualViewport
  if (!viewport) return () => { delete root.dataset.hrIos }

  const update = () => {
    const inset = keyboardInset(win.innerHeight, viewport)
    const open = inset > KEYBOARD_OPEN_THRESHOLD_PX
    root.style.setProperty("--hr-vv-height", `${Math.round(viewport.height)}px`)
    if (open) {
      root.dataset.hrKeyboard = "open"
      // Safari pans the page up to reveal the focused field even when nothing should scroll; with the app
      // sized to the visible area there is nothing to reveal, so put it back where it belongs.
      if (win.scrollY !== 0 || viewport.offsetTop !== 0) win.scrollTo(0, 0)
    } else {
      delete root.dataset.hrKeyboard
    }
  }

  viewport.addEventListener("resize", update)
  viewport.addEventListener("scroll", update)
  // Dismissing the keyboard does not always fire a final resize before the next paint.
  win.addEventListener("focusout", update)
  update()

  return () => {
    viewport.removeEventListener("resize", update)
    viewport.removeEventListener("scroll", update)
    win.removeEventListener("focusout", update)
    delete root.dataset.hrIos
    delete root.dataset.hrKeyboard
    root.style.removeProperty("--hr-vv-height")
  }
}
