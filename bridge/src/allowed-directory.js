import { realpath } from "node:fs/promises"
import path from "node:path"

/**
 * Resolves `candidate` (following symlinks) and refuses it unless it is inside one of the configured
 * `--root` directories. Used wherever a request names a directory the machine will act in.
 */
export async function allowedDirectory(candidate, config) {
  const resolved = await realpath(candidate)
  const roots = await Promise.all((config.roots.length ? config.roots : [process.cwd()]).map((root) => realpath(root)))
  if (!roots.some((root) => resolved === root || !path.relative(root, resolved).startsWith(`..${path.sep}`) && path.relative(root, resolved) !== "..")) {
    throw new Error("Directory is outside the configured --root boundary")
  }
  return resolved
}
