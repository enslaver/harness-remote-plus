import test from "node:test"
import assert from "node:assert/strict"
import { AdminAuth, AttemptThrottle, SESSION_COOKIE } from "../src/auth.js"
import { deriveKeys } from "../src/crypto.js"
import { clientAddress, isSameSiteRequest, isSecureRequest, parseCookies, publicUrl, Router } from "../src/http.js"
import { testConfig } from "./helpers.js"

function request(headers = {}, socket = {}) {
  return { headers, socket: { remoteAddress: "10.0.0.9", ...socket }, method: "GET" }
}

test("AttemptThrottle blocks after the limit and recovers when the window passes", () => {
  let time = 1_000_000
  const throttle = new AttemptThrottle({ max: 3, windowMs: 60_000, now: () => time })
  assert.equal(throttle.retryAfter("ip"), 0)
  throttle.fail("ip")
  throttle.fail("ip")
  assert.equal(throttle.retryAfter("ip"), 0)
  throttle.fail("ip")
  assert.equal(throttle.retryAfter("ip"), 60)
  assert.equal(throttle.retryAfter("other"), 0, "keys are independent")
  time += 30_000
  assert.equal(throttle.retryAfter("ip"), 30)
  time += 31_000
  assert.equal(throttle.retryAfter("ip"), 0)
})

test("AttemptThrottle forgets a key after a success", () => {
  const throttle = new AttemptThrottle({ max: 1, windowMs: 60_000 })
  throttle.fail("ip")
  assert.ok(throttle.retryAfter("ip") > 0)
  throttle.succeed("ip")
  assert.equal(throttle.retryAfter("ip"), 0)
})

function adminAuth(overrides = {}, clock = { now: 1_700_000_000_000 }) {
  const config = testConfig(overrides)
  return { auth: new AdminAuth({ config, keys: deriveKeys(config.secretKey), now: () => clock.now }), clock, config }
}

const cookieHeader = (setCookie) => setCookie.split(";")[0]

test("verifyPassword accepts only the configured password", () => {
  const { auth, config } = adminAuth()
  assert.equal(auth.verifyPassword(config.adminPassword), true)
  assert.equal(auth.verifyPassword(`${config.adminPassword} `), false)
  assert.equal(auth.verifyPassword(undefined), false)
  assert.equal(auth.verifyPassword(""), false)
})

test("session cookie is HttpOnly + SameSite=Strict and only Secure over TLS", () => {
  const { auth } = adminAuth({ HUB_TRUST_PROXY: "1" })
  const plain = auth.issue(request())
  assert.match(plain, /HttpOnly/)
  assert.match(plain, /SameSite=Strict/)
  assert.match(plain, /Path=\//)
  assert.doesNotMatch(plain, /Secure/, "a Secure cookie over plain http is dropped by Safari")
  assert.match(auth.issue(request({ "x-forwarded-proto": "https" })), /Secure/)
  assert.match(auth.issue(request({}, { encrypted: true })), /Secure/)
})

test("X-Forwarded-Proto is ignored unless the proxy is trusted", () => {
  const { auth } = adminAuth()
  assert.doesNotMatch(auth.issue(request({ "x-forwarded-proto": "https" })), /Secure/)
})

test("authenticate accepts a fresh cookie, rejects expired, tampered and foreign-key cookies", () => {
  const { auth, clock } = adminAuth({ HUB_SESSION_TTL_HOURS: "1" })
  const issued = cookieHeader(auth.issue(request()))
  assert.ok(auth.authenticate(request({ cookie: issued })))

  clock.now += 3_601_000
  assert.equal(auth.authenticate(request({ cookie: issued })), null, "expired")
  clock.now -= 3_601_000

  const [name, value] = issued.split("=")
  assert.equal(name, SESSION_COOKIE)
  assert.equal(auth.authenticate(request({ cookie: `${name}=${value.slice(0, -2)}xx` })), null, "tampered")

  const other = adminAuth({ HUB_SECRET_KEY: "z".repeat(48) }, clock).auth
  assert.equal(other.authenticate(request({ cookie: issued })), null, "signed with another key")
  assert.equal(auth.authenticate(request()), null, "no cookie")
})

test("a session older than a day is renewed, a recent one is not", () => {
  const { auth, clock } = adminAuth()
  const issued = cookieHeader(auth.issue(request()))
  assert.equal(auth.authenticate(request({ cookie: issued })).refresh, null)
  clock.now += 25 * 3_600_000
  const renewed = auth.authenticate(request({ cookie: issued })).refresh
  assert.match(renewed, new RegExp(`^${SESSION_COOKIE}=`))
})

test("clear() expires the cookie", () => {
  const { auth } = adminAuth()
  assert.match(auth.clear(request()), /Max-Age=0/)
})

test("parseCookies keeps the first occurrence and tolerates junk", () => {
  assert.deepEqual(parseCookies("a=1; b=2; a=3; junk; =x"), { a: "1", b: "2" })
  assert.deepEqual(parseCookies(undefined), {})
})

test("isSameSiteRequest trusts Sec-Fetch-Site, falls back to Origin, allows non-browsers", () => {
  const config = testConfig()
  assert.equal(isSameSiteRequest(request({ "sec-fetch-site": "same-origin" }), config), true)
  assert.equal(isSameSiteRequest(request({ "sec-fetch-site": "none" }), config), true)
  assert.equal(isSameSiteRequest(request({ "sec-fetch-site": "cross-site" }), config), false)
  assert.equal(isSameSiteRequest(request({ "sec-fetch-site": "same-site" }), config), false)
  assert.equal(isSameSiteRequest(request({ origin: "https://evil.example", host: "hub.local" }), config), false)
  assert.equal(isSameSiteRequest(request({ origin: "http://hub.local", host: "hub.local" }), config), true)
  assert.equal(isSameSiteRequest(request({ origin: "not a url", host: "hub.local" }), config), false)
  assert.equal(isSameSiteRequest(request({ host: "hub.local" }), config), true)
})

test("client address and public URL honour forwarded headers only when trusted", () => {
  const headers = { "x-forwarded-for": "203.0.113.5, 10.0.0.1", "x-forwarded-proto": "https", "x-forwarded-host": "hub.example.com", host: "internal:8080" }
  const untrusted = testConfig()
  const trusted = testConfig({ HUB_TRUST_PROXY: "1" })
  assert.equal(clientAddress(request(headers), untrusted.trustProxy), "10.0.0.9")
  assert.equal(clientAddress(request(headers), trusted.trustProxy), "203.0.113.5")
  assert.equal(isSecureRequest(request(headers), untrusted.trustProxy), false)
  assert.equal(publicUrl(request(headers), untrusted), "http://internal:8080")
  assert.equal(publicUrl(request(headers), trusted), "https://hub.example.com")
  assert.equal(publicUrl(request(headers), testConfig({ HUB_PUBLIC_URL: "https://fixed.example" })), "https://fixed.example")
})

test("Router matches params, decodes them, and distinguishes 404 from 405", () => {
  const router = new Router().add("GET", "/api/v1/machines/:id", () => "get").add("DELETE", "/api/v1/machines/:id", () => "delete")
  const match = router.match("GET", "/api/v1/machines/machine_a%20b")
  assert.equal(match.params.id, "machine_a b")
  assert.equal(router.match("GET", "/nope"), null)
  assert.throws(() => router.match("POST", "/api/v1/machines/x"), (error) => error.status === 405)
  assert.throws(() => router.match("GET", "/api/v1/machines/%E0%A4%A"), (error) => error.status === 400)
  assert.equal(router.match("GET", "/api/v1/machines/a/b"), null, "params never span slashes")
})
