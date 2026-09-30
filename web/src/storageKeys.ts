import {
  ACTIVE_BACKEND_STORAGE_KEY,
  ACTIVE_PROFILE_STORAGE_KEY,
  BACKEND_STORAGE_KEYS,
  LEGACY_STORAGE_KEY,
  SERVER_PROFILES_STORAGE_KEY
} from "./serverProfiles"
import { GROUP_BY_STORAGE_KEY, RECENT_WINDOW_STORAGE_KEY } from "./agent-activity"
import { WORKSPACE_MACHINES_STORAGE_KEY } from "./workspaceMachines"

/**
 * Everything the crash-recovery reset must be able to clear; language and theme are deliberately
 * excluded.
 *
 * The Session-first shell boots from `workspaceMachines`, not from the 2.x server profiles. Its only
 * persisted product-layout values are the native Session rail width and how the rail is grouped and windowed. Retired Conversation-first layout
 * keys are intentionally not part of the current recovery contract: that product surface no longer
 * exists and must not become a dependency again.
 */
export const SERVER_STORAGE_KEYS = [
  WORKSPACE_MACHINES_STORAGE_KEY,
  "harness-remote.sessionRailWidth.v1",
  GROUP_BY_STORAGE_KEY,
  RECENT_WINDOW_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  ACTIVE_BACKEND_STORAGE_KEY,
  BACKEND_STORAGE_KEYS.opencode,
  BACKEND_STORAGE_KEYS.omp,
  BACKEND_STORAGE_KEYS.pi,
  BACKEND_STORAGE_KEYS.claude,
  BACKEND_STORAGE_KEYS.codex,
  "opencode.remote.model",
  "opencode.remote.agent",
  "opencode.remote.newSessionDirectory",
  SERVER_PROFILES_STORAGE_KEY,
  ACTIVE_PROFILE_STORAGE_KEY
]
