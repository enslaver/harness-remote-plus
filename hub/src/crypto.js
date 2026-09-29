import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

const SECRETBOX_VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * One operator secret, several purposes. HKDF gives each purpose its own key so a leak of one derived
 * value (say, a cookie signature oracle) says nothing about another (the key that encrypts stored
 * machine credentials).
 */
export function deriveKeys(secret) {
  const derive = (info) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), info, 32))
  return {
    secretbox: derive("harness-remote-hub/secretbox/v1"),
    cookie: derive("harness-remote-hub/cookie/v1")
  }
}

/** AES-256-GCM. Layout: version(1) | iv(12) | tag(16) | ciphertext. */
export class SecretBox {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("SecretBox requires a 32-byte key")
    this.key = key
  }

  seal(plaintext) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()])
    return Buffer.concat([Buffer.from([SECRETBOX_VERSION]), iv, cipher.getAuthTag(), ciphertext])
  }

  open(sealed) {
    if (!Buffer.isBuffer(sealed) || sealed.length < 1 + IV_BYTES + TAG_BYTES) throw new Error("Sealed value is malformed")
    if (sealed[0] !== SECRETBOX_VERSION) throw new Error("Sealed value has an unsupported version")
    const iv = sealed.subarray(1, 1 + IV_BYTES)
    const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8")
  }
}

/** Tokens are 256 random bits, so an unsalted SHA-256 is enough: there is nothing to brute-force. */
export function generateToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex")
}

/** Compare via fixed-length digests so neither length nor content leaks through timing. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const left = createHash("sha256").update(a, "utf8").digest()
  const right = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(left, right)
}

function signature(key, payload) {
  return createHmac("sha256", key).update(payload).digest("base64url")
}

/** `payload.signature`, both base64url. The payload is signed, not encrypted: never put secrets in it. */
export function signValue(key, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `${payload}.${signature(key, payload)}`
}

export function verifySignedValue(key, signed) {
  if (typeof signed !== "string") return null
  const dot = signed.indexOf(".")
  if (dot <= 0 || dot === signed.length - 1) return null
  const payload = signed.slice(0, dot)
  if (!safeEqual(signature(key, payload), signed.slice(dot + 1))) return null
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
}
