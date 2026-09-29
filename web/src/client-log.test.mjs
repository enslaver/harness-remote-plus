import assert from "node:assert/strict"
import test from "node:test"
import { installClientErrorReporting, isIgnorableClientError, reportClientError } from "./clientLog.ts"

function fakeTarget() {
  const handlers = new Map()
  return {
    addEventListener(type, handler) { handlers.set(type, handler) },
    removeEventListener(type) { handlers.delete(type) },
    fire(type, event) { handlers.get(type)?.(event) },
    get size() { return handlers.size }
  }
}

function setup(options = {}) {
  const target = fakeTarget()
  const posted = []
  let time = 1_000_000
  const uninstall = installClientErrorReporting({ post: (entries) => posted.push(...entries), target, now: () => time, environment: () => ({ app: "web" }), ...options })
  return { target, posted, uninstall, advance: (ms) => { time += ms } }
}

test("reportClientError is a silent no-op when no hub is present", () => {
  assert.doesNotThrow(() => reportClientError(new Error("nothing installed")))
})

test("uncaught errors and rejections are reported with the environment attached", () => {
  const { target, posted, uninstall } = setup()
  target.fire("error", { message: "boom", error: new Error("boom") })
  target.fire("unhandledrejection", { reason: new Error("later") })
  target.fire("unhandledrejection", { reason: "a plain string" })
  assert.deepEqual(posted.map((entry) => entry.message), ["boom", "Unhandled rejection: later", "Unhandled rejection: a plain string"])
  assert.match(posted[0].stack, /Error: boom/)
  assert.deepEqual(posted[0].context, { app: "web" })
  uninstall()
})

test("errors the ErrorBoundary catches are reported through the same path", () => {
  const { posted, uninstall } = setup()
  reportClientError(new Error("render failed"), { boundary: true })
  assert.equal(posted[0].message, "render failed")
  assert.deepEqual(posted[0].context, { app: "web", boundary: true })
  uninstall()
  reportClientError(new Error("after uninstall"))
  assert.equal(posted.length, 1, "uninstall removes the sink")
})

test("browser noise is not reported", () => {
  const { target, posted, uninstall } = setup()
  for (const message of ["ResizeObserver loop limit exceeded", "Script error.", "The operation was aborted.", "Load failed"]) {
    assert.equal(isIgnorableClientError(message), true, message)
    target.fire("error", { message, error: undefined })
  }
  target.fire("unhandledrejection", { reason: new DOMException("aborted", "AbortError") })
  assert.equal(posted.length, 0)
  uninstall()
})

test("an error repeating in a loop is one report; a real new one still gets through", () => {
  const { target, posted, advance, uninstall } = setup()
  const error = new Error("loop")
  for (let index = 0; index < 50; index += 1) target.fire("error", { message: "loop", error })
  assert.equal(posted.length, 1)
  target.fire("error", { message: "different", error: new Error("different") })
  assert.equal(posted.length, 2)
  advance(31_000)
  target.fire("error", { message: "loop", error })
  assert.equal(posted.length, 3, "after the window the same error is reported again")
  uninstall()
})

test("at most maxPerMinute reports leave, then it recovers", () => {
  const { target, posted, advance, uninstall } = setup({ maxPerMinute: 3 })
  for (let index = 0; index < 10; index += 1) target.fire("error", { message: `distinct ${index}`, error: new Error(`distinct ${index}`) })
  assert.equal(posted.length, 3, "a burst of different errors cannot become a request storm")
  advance(61_000)
  target.fire("error", { message: "after a minute", error: new Error("after a minute") })
  assert.equal(posted.length, 4)
  uninstall()
})

test("a failing transport never throws into the app", () => {
  const { target, uninstall } = setup({ post: () => { throw new Error("network down") } })
  assert.doesNotThrow(() => target.fire("error", { message: "x", error: new Error("x") }))
  assert.doesNotThrow(() => reportClientError(new Error("y")))
  uninstall()
})

test("uninstall detaches both listeners", () => {
  const { target, uninstall } = setup()
  assert.equal(target.size, 2)
  uninstall()
  assert.equal(target.size, 0)
})
