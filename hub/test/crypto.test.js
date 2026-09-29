import test from "node:test"
import assert from "node:assert/strict"
import { SecretBox, deriveKeys, generateToken, hashToken, safeEqual, signValue, verifySignedValue } from "../src/crypto.js"

test("derives independent keys per purpose", () => {
  const keys = deriveKeys("x".repeat(40))
  assert.equal(keys.secretbox.length, 32)
  assert.equal(keys.cookie.length, 32)
  assert.notDeepEqual(keys.secretbox, keys.cookie)
  assert.deepEqual(deriveKeys("x".repeat(40)).cookie, keys.cookie)
  assert.notDeepEqual(deriveKeys("y".repeat(40)).cookie, keys.cookie)
})

test("SecretBox round-trips and never repeats a ciphertext", () => {
  const box = new SecretBox(deriveKeys("k".repeat(40)).secretbox)
  const first = box.seal("hunter2")
  const second = box.seal("hunter2")
  assert.equal(box.open(first), "hunter2")
  assert.notDeepEqual(first, second, "a fresh IV per seal")
  assert.ok(!first.includes(Buffer.from("hunter2")), "plaintext must not appear in the sealed value")
})

test("SecretBox rejects tampering, truncation, other keys and unknown versions", () => {
  const box = new SecretBox(deriveKeys("k".repeat(40)).secretbox)
  const other = new SecretBox(deriveKeys("z".repeat(40)).secretbox)
  const sealed = box.seal("payload")

  const flipped = Buffer.from(sealed)
  flipped[flipped.length - 1] ^= 1
  assert.throws(() => box.open(flipped))
  assert.throws(() => other.open(sealed))
  assert.throws(() => box.open(sealed.subarray(0, 10)), /malformed/)
  const future = Buffer.from(sealed)
  future[0] = 9
  assert.throws(() => box.open(future), /unsupported version/)
  assert.throws(() => new SecretBox(Buffer.alloc(16)), /32-byte/)
})

test("tokens are prefixed, unique and hash deterministically", () => {
  const a = generateToken("hrm")
  const b = generateToken("hrm")
  assert.match(a, /^hrm_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.equal(hashToken(a), hashToken(a))
  assert.notEqual(hashToken(a), hashToken(b))
  assert.match(hashToken(a), /^[0-9a-f]{64}$/)
})

test("safeEqual is exact, and tolerant of differing lengths and non-strings", () => {
  assert.equal(safeEqual("abc", "abc"), true)
  assert.equal(safeEqual("abc", "abd"), false)
  assert.equal(safeEqual("abc", "abcd"), false)
  assert.equal(safeEqual("abc", undefined), false)
  assert.equal(safeEqual(1, 1), false)
})

test("signed values verify only untampered and only under the same key", () => {
  const key = deriveKeys("k".repeat(40)).cookie
  const signed = signValue(key, { exp: 123, v: 1 })
  assert.deepEqual(verifySignedValue(key, signed), { exp: 123, v: 1 })
  assert.equal(verifySignedValue(deriveKeys("q".repeat(40)).cookie, signed), null)

  const [payload, signature] = signed.split(".")
  const forged = `${Buffer.from(JSON.stringify({ exp: 9_999_999_999, v: 1 })).toString("base64url")}.${signature}`
  assert.equal(verifySignedValue(key, forged), null)
  for (const bad of ["", ".", "nodot", `${payload}.`, `.${signature}`, undefined, 42]) {
    assert.equal(verifySignedValue(key, bad), null, String(bad))
  }
})
