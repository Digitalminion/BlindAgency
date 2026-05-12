import { beforeEach, describe, expect, it, vi } from 'vitest'

// sessionStorage is not available in vitest's jsdom by default — we inject a minimal stub
const store: Record<string, string> = {}
const sessionStorageStub = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
}

vi.stubGlobal('sessionStorage', sessionStorageStub)

// Import after stubbing so the available() probe succeeds
const { saveKeyBlob, loadKeyBlob, clearKeyBlob } = await import('./storage.js')

const blob = { keyId: 'key-1', ciphertext: 'abc123' }

describe('storage', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k])
    clearKeyBlob()
  })

  it('round-trips a key blob through sessionStorage', () => {
    saveKeyBlob(blob)
    expect(loadKeyBlob()).toEqual(blob)
  })

  it('returns null when nothing is stored', () => {
    expect(loadKeyBlob()).toBeNull()
  })

  it('clearKeyBlob removes the stored blob', () => {
    saveKeyBlob(blob)
    clearKeyBlob()
    expect(loadKeyBlob()).toBeNull()
  })

  it('overwrites an existing blob', () => {
    saveKeyBlob(blob)
    saveKeyBlob({ keyId: 'key-2', ciphertext: 'xyz' })
    expect(loadKeyBlob()?.keyId).toBe('key-2')
  })

  it('returns null and does not throw when storage contains malformed JSON', () => {
    store['blindagency:keyblob'] = 'not-valid-json{{{'
    expect(() => loadKeyBlob()).not.toThrow()
    expect(loadKeyBlob()).toBeNull()
  })

  it('returns null when stored object is missing keyId', () => {
    store['blindagency:keyblob'] = JSON.stringify({ ciphertext: 'abc' })
    expect(loadKeyBlob()).toBeNull()
  })

  it('returns null when stored object is missing ciphertext', () => {
    store['blindagency:keyblob'] = JSON.stringify({ keyId: 'k' })
    expect(loadKeyBlob()).toBeNull()
  })

  it('returns null when stored value is not an object', () => {
    store['blindagency:keyblob'] = JSON.stringify(42)
    expect(loadKeyBlob()).toBeNull()
  })

  it('returns null when keyId is not a string', () => {
    store['blindagency:keyblob'] = JSON.stringify({ keyId: 123, ciphertext: 'abc' })
    expect(loadKeyBlob()).toBeNull()
  })
})
