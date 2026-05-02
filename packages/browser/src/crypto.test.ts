import { beforeAll, describe, expect, it } from 'vitest'
import { importPublicKey, encryptApiKey } from './crypto.js'

// One RSA-OAEP key pair shared across all tests — keygen is ~200-400ms.
let keyPair: CryptoKeyPair
let publicKeyPem: string

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)))
  const lines = b64.match(/.{1,64}/g) ?? []
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`
})

// ── importPublicKey ────────────────────────────────────────────────────────

describe('importPublicKey', () => {
  it('returns a CryptoKey from a valid PEM', async () => {
    expect(await importPublicKey(publicKeyPem)).toBeInstanceOf(CryptoKey)
  })

  it('imported key has encrypt usage only', async () => {
    expect((await importPublicKey(publicKeyPem)).usages).toEqual(['encrypt'])
  })

  it('imported key is non-extractable', async () => {
    expect((await importPublicKey(publicKeyPem)).extractable).toBe(false)
  })

  it('throws on an invalid PEM string', async () => {
    await expect(importPublicKey('not a real pem')).rejects.toThrow()
  })
})

// ── encryptApiKey ──────────────────────────────────────────────────────────

describe('encryptApiKey', () => {
  it('returns an ArrayBuffer', async () => {
    expect(await encryptApiKey('sk-test', keyPair.publicKey)).toBeInstanceOf(ArrayBuffer)
  })

  it('produces a non-empty ciphertext', async () => {
    expect((await encryptApiKey('sk-test', keyPair.publicKey)).byteLength).toBeGreaterThan(0)
  })

  it('round-trips: decrypts back to the original plaintext', async () => {
    const original = 'sk-ant-api-test-key-123'
    const ciphertext = await encryptApiKey(original, keyPair.publicKey)
    const decrypted = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keyPair.privateKey, ciphertext)
    expect(new TextDecoder().decode(decrypted)).toBe(original)
  })

  it('OAEP padding is probabilistic — same plaintext produces different ciphertext each call', async () => {
    const ct1 = new Uint8Array(await encryptApiKey('same-key', keyPair.publicKey))
    const ct2 = new Uint8Array(await encryptApiKey('same-key', keyPair.publicKey))
    expect(ct1).not.toEqual(ct2)
  })

  it('encrypts an empty string without throwing', async () => {
    expect((await encryptApiKey('', keyPair.publicKey)).byteLength).toBeGreaterThan(0)
  })
})
