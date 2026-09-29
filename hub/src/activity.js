/**
 * One vocabulary for "what is this Session doing", shared by every harness:
 *
 *   working      the agent is running a turn (or a background agent is doing its work)
 *   needs_input  blocked on a question or a permission that only a person can answer
 *   idle         alive, waiting for the next message
 *   completed    a background agent that finished its work
 *   failed       ended in an error
 *   stopped      stopped by a person
 *   gone         the machine no longer lists it
 *   unknown      the harness gave no usable status
 *
 * The machine computes it (it knows its own harnesses). The hub derives it from the raw `status` for
 * machines that predate the field, so mixed versions in one fleet still group and filter consistently.
 */

export const ACTIVITIES = Object.freeze(["working", "needs_input", "idle", "completed", "failed", "stopped", "gone", "unknown"])
/** Activities in which something is happening right now. */
export const LIVE_ACTIVITIES = Object.freeze(["working", "needs_input"])

const FROM_STATUS = new Map([
  ["busy", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["working", "working"],
  ["active", "working"],
  ["waiting", "needs_input"],
  ["blocked", "needs_input"],
  ["needs_input", "needs_input"],
  ["idle", "idle"],
  ["done", "completed"],
  ["completed", "completed"],
  ["success", "completed"],
  ["failed", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["stopped", "stopped"],
  ["cancelled", "stopped"],
  ["canceled", "stopped"],
  ["gone", "gone"]
])

export function activityFromStatus(status) {
  return FROM_STATUS.get(String(status ?? "").trim().toLowerCase()) ?? "unknown"
}

/** A machine-supplied activity if it is one we know, otherwise derived from the raw status. */
export function resolveActivity(activity, status) {
  return ACTIVITIES.includes(activity) ? activity : activityFromStatus(status)
}
