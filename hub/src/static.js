import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { gzip } from "node:zlib"
import { promisify } from "node:util"
import { BASE_HEADERS } from "./http.js"

const gzipAsync = promisify(gzip)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
}
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/
const MIN_COMPRESS_BYTES = 1_024
const MAX_COMPRESS_BYTES = 4 * 1024 * 1024

/** Files that must be revalidated every time: a stale one strands users on an old app version. */
const ALWAYS_REVALIDATE = new Set(["index.html", "sw.js", "manifest.webmanifest"])

function cacheControl(relative) {
  if (ALWAYS_REVALIDATE.has(relative) || relative.endsWith("/index.html")) return "no-cache"
  // Vite fingerprints everything under assets/, so it can be cached forever.
  if (relative.startsWith("assets/")) return "public, max-age=31536000, immutable"
  return "public, max-age=3600"
}

function etag(info) {
  return `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
}

/**
 * Safari refuses to play audio/video unless the server answers `Range` requests with 206, so the
 * app's completion sound would silently never play on an iPhone without this. Single ranges only,
 * which is all any browser sends for media.
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "")
  if (!match || (match[1] === "" && match[2] === "")) return null
  let start
  let end
  if (match[1] === "") {
    // Suffix range: the last N bytes.
    const length = Number(match[2])
    if (length === 0) return { unsatisfiable: true }
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || start > end) return { unsatisfiable: true }
  return { start, end }
}

/** Resolves `pathname` under `root` without ever leaving it: no traversal, no dotfiles, no symlink escapes. */
async function resolveInside(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null
  const segments = decoded.split("/").filter(Boolean)
  if (segments.some((segment) => segment === ".." || segment.startsWith("."))) return null
  const candidate = path.join(root, ...segments)
  try {
    const [resolvedRoot, resolved] = await Promise.all([realpath(root), realpath(candidate)])
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null
    return { file: resolved, relative: segments.join("/") }
  } catch {
    return null
  }
}

/**
 * Serves a directory of static files. `spa` makes any extensionless path that matches no file fall
 * back to index.html, which is how a client-routed app survives a reload on a deep link. A missing
 * *file* (`/assets/x.js`) is still a real 404: answering it with HTML turns a stale cache into a
 * baffling "Unexpected token <" instead of an honest error.
 */
export function createStaticServer({ root, spa = false, headers = {}, fallbackHtml }) {
  const compressed = new Map()

  async function compressedBody(file, info) {
    const key = `${file}:${info.size}:${info.mtimeMs}`
    if (compressed.has(key)) return compressed.get(key)
    const chunks = []
    for await (const chunk of createReadStream(file)) chunks.push(chunk)
    const body = await gzipAsync(Buffer.concat(chunks))
    if (compressed.size >= 200) compressed.delete(compressed.keys().next().value)
    compressed.set(key, body)
    return body
  }

  return async function serve(req, res, pathname) {
    const method = req.method ?? "GET"
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { ...BASE_HEADERS, Allow: "GET, HEAD" })
      res.end()
      return true
    }

    let target = pathname.endsWith("/") ? `${pathname}index.html` : pathname
    let resolved = await resolveInside(root, target)
    let info = resolved && (await stat(resolved.file).catch(() => null))
    if (info?.isDirectory()) {
      // `/hub` -> `/hub/` so relative asset URLs on that page resolve.
      res.writeHead(301, { ...BASE_HEADERS, Location: `${pathname}/` })
      res.end()
      return true
    }
    if (!info && spa && !path.extname(pathname)) {
      target = "/index.html"
      resolved = await resolveInside(root, target)
      info = resolved && (await stat(resolved.file).catch(() => null))
    }
    if (!info || !info.isFile()) {
      if (fallbackHtml && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" })
        res.end(method === "HEAD" ? undefined : fallbackHtml)
        return true
      }
      res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      res.end(method === "HEAD" ? undefined : "Not found\n")
      return true
    }

    const type = TYPES[path.extname(resolved.file).toLowerCase()] ?? "application/octet-stream"
    const tag = etag(info)
    const out = { ...BASE_HEADERS, ...headers, "Content-Type": type, "Cache-Control": cacheControl(resolved.relative), ETag: tag, "Last-Modified": info.mtime.toUTCString(), "Accept-Ranges": "bytes", Vary: "Accept-Encoding" }

    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, out)
      res.end()
      return true
    }

    const range = req.headers.range ? parseRange(req.headers.range, info.size) : null
    if (range?.unsatisfiable) {
      res.writeHead(416, { ...out, "Content-Range": `bytes */${info.size}` })
      res.end()
      return true
    }
    if (range) {
      res.writeHead(206, { ...out, "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": range.end - range.start + 1 })
      if (method === "HEAD") return res.end(), true
      createReadStream(resolved.file, { start: range.start, end: range.end }).on("error", () => res.destroy()).pipe(res)
      return true
    }

    const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && COMPRESSIBLE.test(type) && info.size >= MIN_COMPRESS_BYTES && info.size <= MAX_COMPRESS_BYTES
    if (wantsGzip) {
      const body = await compressedBody(resolved.file, info)
      res.writeHead(200, { ...out, "Content-Encoding": "gzip", "Content-Length": body.length })
      res.end(method === "HEAD" ? undefined : body)
      return true
    }
    res.writeHead(200, { ...out, "Content-Length": info.size })
    if (method === "HEAD") return res.end(), true
    createReadStream(resolved.file).on("error", () => res.destroy()).pipe(res)
    return true
  }
}
