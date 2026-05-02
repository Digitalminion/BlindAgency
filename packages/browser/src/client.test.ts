import { beforeEach, describe, expect, it, vi } from 'vitest'

// sessionStorage stub — must be in place before the module is imported
const store: Record<string, string> = {}
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
})

const { createRelay } = await import('./client.js')

const ENDPOINT = 'https://relay.example.com'
const STORAGE_KEY = 'blindagency:keyblob'

function makeFetch(response: object = { ok: true }): typeof fetch {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch
}

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k])
})

// ── hasKey ─────────────────────────────────────────────────────────────────

describe('hasKey', () => {
  it('returns false when no key is stored', () => {
    expect(createRelay({ endpoint: ENDPOINT }).hasKey()).toBe(false)
  })

  it('returns true when a key blob is in storage', () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    expect(createRelay({ endpoint: ENDPOINT }).hasKey()).toBe(true)
  })
})

// ── clearKey ───────────────────────────────────────────────────────────────

describe('clearKey', () => {
  it('removes the stored key blob', () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const relay = createRelay({ endpoint: ENDPOINT })
    relay.clearKey()
    expect(relay.hasKey()).toBe(false)
  })

  it('is safe to call when no key is stored', () => {
    expect(() => createRelay({ endpoint: ENDPOINT }).clearKey()).not.toThrow()
  })
})

// ── createFetch ────────────────────────────────────────────────────────────

describe('createFetch', () => {
  it('throws when no key has been configured', async () => {
    await expect(
      createRelay({ endpoint: ENDPOINT }).createFetch()('/', { body: JSON.stringify({}) })
    ).rejects.toThrow('No API key')
  })

  it('sends the request to {endpoint}/relay', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({}) }
    )
    expect(vi.mocked(fetchFn).mock.calls[0][0]).toBe(`${ENDPOINT}/relay`)
  })

  it('always uses POST', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { method: 'GET' }
    )
    expect((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).method).toBe('POST')
  })

  it('sets Content-Type: application/json', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({}) }
    )
    const headers = (vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('wraps body fields and _relay envelope together', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'key-1', ciphertext: 'ct-1' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({ model: 'claude-3', messages: [] }) }
    )
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('claude-3')
    expect(body.messages).toEqual([])
    expect(body._relay).toEqual({ keyId: 'key-1', ciphertext: 'ct-1', provider: 'anthropic' })
  })

  it('defaults provider to anthropic', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({}) }
    )
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body._relay.provider).toBe('anthropic')
  })

  it('passes the configured provider in the _relay envelope', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, provider: 'openai', fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({}) }
    )
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body._relay.provider).toBe('openai')
  })

  it('passes through existing request headers alongside Content-Type', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: JSON.stringify({}), headers: { 'X-Request-Id': 'abc' } }
    )
    const headers = (vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Request-Id']).toBe('abc')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('handles a non-JSON body gracefully — _relay still present', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = makeFetch()
    await createRelay({ endpoint: ENDPOINT, fetch: fetchFn }).createFetch()(
      '/', { body: 'plain text' }
    )
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body._relay).toBeDefined()
  })
})

// ── setKey ─────────────────────────────────────────────────────────────────

describe('setKey', () => {
  function makeSetKeyRelay(keyId = 'rotation-key-1', ciphertext = new Uint8Array([1, 2, 3]).buffer) {
    return createRelay({
      endpoint: ENDPOINT,
      fetchPublicKey: async () => ({ keyId, publicKey: {} as CryptoKey }),
      encryptApiKey: async () => ciphertext,
    })
  }

  it('stores a key blob after encrypting', async () => {
    const relay = makeSetKeyRelay()
    expect(relay.hasKey()).toBe(false)
    await relay.setKey('sk-test-api-key')
    expect(relay.hasKey()).toBe(true)
  })

  it('stores the keyId returned by fetchPublicKey', async () => {
    await makeSetKeyRelay('specific-key-id').setKey('sk-test')
    expect(JSON.parse(store[STORAGE_KEY]).keyId).toBe('specific-key-id')
  })

  it('stores the ciphertext as a base64 string', async () => {
    await makeSetKeyRelay().setKey('sk-test')
    const stored = JSON.parse(store[STORAGE_KEY])
    expect(typeof stored.ciphertext).toBe('string')
    expect(() => atob(stored.ciphertext)).not.toThrow()
  })

  it('base64-encodes the exact bytes from encryptApiKey', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    await makeSetKeyRelay('k', bytes.buffer).setKey('sk-test')
    const stored = JSON.parse(store[STORAGE_KEY])
    expect(stored.ciphertext).toBe(btoa(String.fromCharCode(...bytes)))
  })

  it('calls fetchPublicKey with the configured endpoint', async () => {
    const calls: string[] = []
    const relay = createRelay({
      endpoint: 'https://my-relay.example.com',
      fetchPublicKey: async (ep) => { calls.push(ep); return { keyId: 'k', publicKey: {} as CryptoKey } },
      encryptApiKey: async () => new Uint8Array([1]).buffer,
    })
    await relay.setKey('sk-test')
    expect(calls).toEqual(['https://my-relay.example.com'])
  })
})
