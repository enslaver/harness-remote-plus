import assert from "node:assert/strict"
import test from "node:test"
import { KEYBOARD_OPEN_THRESHOLD_PX, installIosSafari, isIosDevice, keyboardInset } from "./iosSafari.ts"

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"

test("isIosDevice recognises iPhone, iPad, iPod and iPadOS-as-Mac, and nothing else", () => {
  assert.equal(isIosDevice({ userAgent: IPHONE }), true)
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)" }), true)
  assert.equal(isIosDevice({ userAgent: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)" }), true)
  assert.equal(isIosDevice({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 }), true, "iPadOS 13+ claims to be a Mac but has a touch screen")
  assert.equal(isIosDevice({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 }), false, "a real Mac")
  assert.equal(isIosDevice({ userAgent: MAC, platform: "MacIntel" }), false)
  assert.equal(isIosDevice({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 }), false)
})

test("keyboardInset is how much of the layout viewport the keyboard covers", () => {
  assert.equal(keyboardInset(844, { height: 844, offsetTop: 0 }), 0)
  assert.equal(keyboardInset(844, { height: 510, offsetTop: 0 }), 334)
  assert.equal(keyboardInset(844, { height: 510, offsetTop: 40 }), 294, "a panned viewport is already showing part of the gap")
  assert.equal(keyboardInset(844, { height: 900, offsetTop: 0 }), 0, "never negative (overscroll bounce)")
})

function fakeEnvironment({ ua = IPHONE, platform = "iPhone", touch = 5, height = 844, viewport = true } = {}) {
  const viewportTarget = Object.assign(new EventTarget(), { height, offsetTop: 0 })
  const windowTarget = new EventTarget()
  const scrolls = []
  const win = {
    innerHeight: height,
    scrollY: 0,
    visualViewport: viewport ? viewportTarget : null,
    scrollTo: (x, y) => scrolls.push([x, y]),
    addEventListener: (...args) => windowTarget.addEventListener(...args),
    removeEventListener: (...args) => windowTarget.removeEventListener(...args)
  }
  const styles = new Map()
  const doc = { documentElement: { dataset: {}, style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name) } } }
  return { win, doc, nav: { userAgent: ua, platform, maxTouchPoints: touch }, viewport: viewportTarget, windowTarget, scrolls, styles, dataset: doc.documentElement.dataset }
}

test("off iOS nothing is touched: no attribute, no listeners, no CSS variables", () => {
  const env = fakeEnvironment({ ua: ANDROID, platform: "Linux armv8l" })
  const uninstall = installIosSafari(env)
  assert.deepEqual(env.dataset, {})
  assert.equal(env.styles.size, 0)
  env.viewport.height = 300
  env.viewport.dispatchEvent(new Event("resize"))
  assert.deepEqual(env.dataset, {}, "a resize means nothing on Android/desktop")
  assert.doesNotThrow(uninstall)
})

test("on iOS the attribute is set and the visible height is published", () => {
  const env = fakeEnvironment()
  installIosSafari(env)
  assert.equal(env.dataset.hrIos, "1")
  assert.equal(env.styles.get("--hr-vv-height"), "844px")
  assert.equal(env.dataset.hrKeyboard, undefined)
})

test("a keyboard opening and closing toggles the flag and tracks the visible height", () => {
  const env = fakeEnvironment()
  installIosSafari(env)

  env.viewport.height = 510
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.dataset.hrKeyboard, "open")
  assert.equal(env.styles.get("--hr-vv-height"), "510px")

  env.viewport.height = 844
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.dataset.hrKeyboard, undefined)
  assert.equal(env.styles.get("--hr-vv-height"), "844px")
})

test("browser chrome collapsing (a small resize) is not mistaken for the keyboard", () => {
  const env = fakeEnvironment()
  installIosSafari(env)
  env.viewport.height = 844 - (KEYBOARD_OPEN_THRESHOLD_PX - 10)
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.dataset.hrKeyboard, undefined)
  env.viewport.height = 844 - (KEYBOARD_OPEN_THRESHOLD_PX + 10)
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.dataset.hrKeyboard, "open")
})

test("while the keyboard is open a panned page is put back at the top; otherwise it is left alone", () => {
  const env = fakeEnvironment()
  installIosSafari(env)
  env.viewport.height = 500
  env.viewport.dispatchEvent(new Event("resize"))
  assert.deepEqual(env.scrolls, [], "not panned, nothing to correct")

  env.win.scrollY = 120
  env.viewport.dispatchEvent(new Event("scroll"))
  assert.deepEqual(env.scrolls, [[0, 0]])

  env.viewport.height = 844
  env.win.scrollY = 50
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.scrolls.length, 1, "with the keyboard closed the user's own scrolling is respected")
})

test("focusout re-checks, because closing the keyboard does not always fire a last resize", () => {
  const env = fakeEnvironment()
  installIosSafari(env)
  env.viewport.height = 500
  env.viewport.dispatchEvent(new Event("resize"))
  assert.equal(env.dataset.hrKeyboard, "open")
  env.viewport.height = 844
  env.windowTarget.dispatchEvent(new Event("focusout"))
  assert.equal(env.dataset.hrKeyboard, undefined)
})

test("uninstall removes the attribute, the variable and the listeners", () => {
  const env = fakeEnvironment()
  const uninstall = installIosSafari(env)
  env.viewport.height = 500
  env.viewport.dispatchEvent(new Event("resize"))
  uninstall()
  assert.deepEqual(env.dataset, {})
  assert.equal(env.styles.size, 0)
  env.viewport.height = 400
  env.viewport.dispatchEvent(new Event("resize"))
  assert.deepEqual(env.dataset, {}, "no longer listening")
})

test("an old iOS without visualViewport still gets the zoom fix, and does not crash", () => {
  const env = fakeEnvironment({ viewport: false })
  const uninstall = installIosSafari(env)
  assert.equal(env.dataset.hrIos, "1")
  uninstall()
  assert.deepEqual(env.dataset, {})
})
