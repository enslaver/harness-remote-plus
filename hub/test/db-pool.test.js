import test from "node:test"
import assert from "node:assert/strict"
import { createPool } from "../src/db.js"

test("an error on an idle pooled connection is logged, not thrown (Postgres restarting must not kill the hub)", async () => {
  const lines = []
  const pool = createPool({ databaseUrl: "postgres://u:p@127.0.0.1:1/none", log: (message) => lines.push(message) })
  try {
    // pg re-emits a broken idle client's error on the pool. With no listener that is an uncaught exception.
    assert.doesNotThrow(() => pool.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /57P01/)
  } finally {
    await pool.end()
  }
})
