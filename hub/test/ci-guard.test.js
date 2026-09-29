import test from "node:test"
import assert from "node:assert/strict"

// The database suites skip themselves when Postgres is not configured, which is convenient on a
// laptop and dangerous in CI: a misconfigured service container would turn the whole integration
// layer into a silent pass. This turns that case into a failure.
test("CI provides a test database", { skip: !process.env.CI }, () => {
  assert.ok(process.env.HUB_TEST_DATABASE_URL, "HUB_TEST_DATABASE_URL must be set in CI so the database suites actually run")
})
