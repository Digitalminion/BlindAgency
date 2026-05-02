import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchPublicKey, encryptApiKey } from './crypto.js'

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

function makeFetch(keyId = 'key-1', pem = publicKeyPem): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keyId, publicKeyPem: pem }),
  }) as unknown as typeof fetch
}

// ── fetchPublicKey ─────────────────────────────────────────────────────────

describe('fetchPublicKey', () => {
  it('calls the /public-key path on the given endpoint', async () => {
    const fetchFn = makeFetch()
    await fetchPublicKey('https://relay.example.com', fetchFn)
    expect(vi.mocked(fetchFn)).toHaveBeenCalledWith('https://relay.example.com/public-key')
  })

  it('returns the keyId from the response', async () => {
    const result = await fetchPublicKey('https://example.com', makeFetch('key-abc'))
    expect(result.keyId).toBe('key-abc')
  })

  it('returns a CryptoKey', async () => {
    const result = await fetchPublicKey('https://example.com', makeFetch())
    expect(result.publicKey).toBeInstanceOf(CryptoKey)
  })

  it('imported key has encrypt usage only', async () => {
    const { publicKey } = await fetchPublicKey('https://example.com', makeFetch())
    expect(publicKey.usages).toEqual(['encrypt'])
  })

  it('imported key is non-extractable', async () => {
    const { publicKey } = await fetchPublicKey('https://example.com', makeFetch())
    expect(publicKey.extractable).toBe(false)
  })

  it('throws when the response is not ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch
    await expect(fetchPublicKey('https://example.com', fetchFn)).rejects.toThrow('503')
  })

  it('propagates a network-level fetch rejection', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    await expect(fetchPublicKey('https://example.com', fetchFn)).rejects.toThrow('network down')
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
