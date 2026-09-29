// Bumped with the app icon artwork: the precached icon-192/icon-512 entries are served cache-first,
// so an already-installed PWA keeps painting the previous icon until the cache name changes and
// `activate` drops the old one.
//
// v4: when the app is served by a Harness Remote Hub, machine traffic and the hub's own API are
// same-origin (/m/<machine>/..., /api/...). The cache-first rule below would have stored session lists
// and transcripts in the cache and then served them stale, so those routes now bypass the worker.
const CACHE_NAME = "harness-remote-v4"

// Paths (relative to the worker's scope) that are live data or another app, never static files.
const LIVE_PREFIXES = ["api", "m", "hub"]

function relativeToScope(url) {
  const scopePath = new URL(self.registration.scope).pathname
  const path = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : url.pathname.replace(/^\//, "")
  return path
}

function isLiveRoute(url) {
  const first = relativeToScope(url).split("/")[0]
  return LIVE_PREFIXES.includes(first)
}

/** Responses that say they are private or uncacheable are not the worker's to keep. */
function cacheable(response) {
  return response.ok && !/\b(no-store|private)\b/i.test(response.headers.get("cache-control") || "")
}

self.addEventListener("install", (event) => {
  const scope = self.registration.scope
  const appShell = [scope, `${scope}manifest.webmanifest`, `${scope}icon-192.png`, `${scope}icon-512.png`]
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(appShell))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

/**
 * A worker may be killed as soon as it has answered, so a cache write started inside the
 * response chain is not guaranteed to finish: it has to be kept alive by the event itself.
 */
function storeInCache(event, key, response) {
  const copy = response.clone()
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)))
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Let the browser go straight to the network: no respondWith means no caching and no offline fallback.
  if (isLiveRoute(url)) return

  if (request.mode === "navigate") {
    const scope = self.registration.scope
    const scopeUrl = new URL(scope)
    const landingPath = `${scopeUrl.pathname}v3/`

    // The HR3 marketing landing lives alongside the app on GitHub Pages. Let the browser
    // fetch it directly so app-shell caching never replaces the PWA root with landing HTML.
    if (url.pathname.startsWith(landingPath)) return
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (cacheable(response)) storeInCache(event, scope, response)
          return response
        })
        .catch(() => caches.match(scope))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (cacheable(response)) storeInCache(event, request, response)
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
