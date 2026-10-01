import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Source-level guards for the hub wiring in main.tsx: they pin the guarantees (never held hostage by a
// silent hub, no redirect loop, hub machines never stored, inert off-hub), not the exact code shape.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const main = read("./main.tsx")
const boundary = read("./ErrorBoundary.tsx")

// Inert unless it is a plain browser page: the desktop and Android shells have their own machine sources.
assert.match(main, /useHubMachines\(!isDesktopPlatform\(\) && !Capacitor\.isNativePlatform\(\)\)/, "hub discovery must be skipped in Electron and Capacitor")

// Never held hostage by a hub that does not answer.
assert.match(main, /result\.kind === "unavailable"[\s\S]*settle\(\)|settle\(\)\s*\n\s*if \(result\.kind === "unavailable"/, "an unavailable hub must still let the app render")
assert.match(main, /HUB_MAX_UNDETECTED_RETRIES/, "a host that never proves to be a hub must stop being asked")

// Loop-proof sign-in redirect.
assert.match(main, /HUB_SIGNIN_REDIRECT_KEY[\s\S]*Date\.now\(\) - Number\(sessionStorage\.getItem\(HUB_SIGNIN_REDIRECT_KEY\)\) < 20_000/, "the sign-in redirect must be rate limited")
assert.match(main, /location\.replace\(`\$\{import\.meta\.env\.BASE_URL\}hub\/\?next=/, "sign-in goes to the hub console and returns")

// Hub machines are projections: shown first, after the desktop runtime, never persisted.
assert.match(main, /const persistent = nextMachines\.filter\(\(machine\) => !isRuntimeOwnedMachine\(machine\)\)/)
assert.match(main, /persistedMachines\.filter\(\(machine\) => !isRuntimeOwnedMachine\(machine\)\)/, "a stored entry can never shadow a runtime-owned machine")
assert.match(main, /\[\.\.\.\(local \? \[local\] : \[\]\), \.\.\.hub\.machines, \.\.\.desktopHub\.machines\]/)

// Refresh when an iPhone brings the page back to the foreground; unchanged polls change nothing.
assert.match(main, /visibilitychange/)
assert.match(main, /sameHubMachines\(current, result\.machines\) \? current : result\.machines/)

// The blank gate only shows words when it is actually slow, so a plain host gets no flash of "connecting".
assert.match(main, /setTimeout\(\(\) => setSlow\(true\), 800\)/)
assert.match(main, /hub\.slow \? <div[^>]*>Connecting…<\/div> : null/)

// Errors reach the hub's log store from both global handlers and the boundary.
assert.match(main, /installClientErrorReporting\(\{ post: postClientLogs\(import\.meta\.env\.BASE_URL\)/)
assert.match(boundary, /reportClientError\(error,/)

// The desktop app's hub is main-owned too: the form's token never reaches the renderer, the hub link and
// Configure hub sit in the top bar, and hub machines are never persisted.
const controls = readFileSync(new URL("./components/hub-controls.tsx", import.meta.url), "utf8")
assert.match(main, /useDesktopHub\(\)/)
assert.match(main, /<HubControls/)
assert.match(controls, /Configure hub/)
assert.match(controls, /href=\{`\$\{base\}hub\/`\}/)
assert.doesNotMatch(controls, /localStorage|sessionStorage/, "the enrollment token is never kept by the renderer")

console.log("hub integration regression tests passed")
