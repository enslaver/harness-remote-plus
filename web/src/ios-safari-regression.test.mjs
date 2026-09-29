import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Guards for the iPhone/iPad work. They pin the decisions that are easy to undo by accident.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const html = read("../index.html")
const css = read("./ios-safari.css")
const main = read("./main.tsx")

// --- The viewport: deliberately NOT viewport-fit=cover -------------------------------------------------
const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? ""
assert.match(viewport, /width=device-width/)
assert.doesNotMatch(
  viewport,
  /viewport-fit\s*=\s*cover/,
  "viewport-fit=cover switches on every env(safe-area-inset-*) rule at once. The bottom nav is a fixed 56px with " +
    "padding-bottom: env(safe-area-inset-bottom), so a real home-indicator inset squeezes its buttons, and the list-view " +
    "top bar has no top inset. Rework those surfaces first, then change this test together with index.html."
)
assert.match(html, /Deliberately NOT viewport-fit=cover/, "the reason must stay next to the tag it explains")
assert.match(viewport, /interactive-widget=resizes-content/, "Android's keyboard behaviour must be kept")

// --- Home-screen metadata ------------------------------------------------------------------------------
assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon\.png"/)
assert.match(html, /<meta name="apple-mobile-web-app-title" content="Harness Remote"/)
assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/)

const icon = readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url))
assert.equal(icon.subarray(1, 4).toString(), "PNG")
assert.equal(icon.readUInt32BE(16), 180, "apple-touch-icon width")
assert.equal(icon.readUInt32BE(20), 180, "apple-touch-icon height")

// --- The stylesheet cannot leak to other platforms -------------------------------------------------------
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
const selectors = withoutComments.split("}").flatMap((block) => {
  const head = block.split("{")[0]?.trim()
  return head ? head.split(/,\s*(?![^()]*\))/).map((selector) => selector.trim()).filter(Boolean) : []
})
assert.ok(selectors.length >= 5, "the stylesheet should have rules to check")
for (const selector of selectors) {
  assert.ok(selector.startsWith('html[data-hr-ios="1"]'), `ios-safari.css rule is not scoped to iOS: ${selector}`)
}
assert.match(css, /font-size: 16px !important/, "entry fields must be forced to 16px (iOS zooms below that)")
assert.match(css, /:not\(\[type="checkbox"\]\)/, "checkboxes and other non-text inputs keep their compact size")
assert.match(css, /\[data-hr-keyboard="open"\] \.hr-mobile-nav \{ display: none !important; \}/)
assert.match(css, /height: var\(--hr-vv-height, 100dvh\) !important/)

// --- Wiring: installed before the first render, stylesheet loaded last ---------------------------------
assert.match(main, /import "\.\/ios-safari\.css"/)
const cssImports = [...main.matchAll(/^import "(\.\/[^"]+\.css)"/gm)].map((match) => match[1])
assert.equal(cssImports.at(-1), "./ios-safari.css", "it settles ties with the mobile sheets by loading last")
assert.ok(main.indexOf("installIosSafari()") > 0 && main.indexOf("installIosSafari()") < main.indexOf("ReactDOM.createRoot"), "installed before the app renders")

console.log("ios safari regression tests passed")
