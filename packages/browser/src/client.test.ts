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

// ── send() ─────────────────────────────────────────────────────────────────

import { createMessageItem } from './thread.js'

function makeSendRelay(fetchFn: typeof fetch) {
  return createRelay({ endpoint: ENDPOINT, provider: 'anthropic', fetch: fetchFn })
}

function mockSendFetch(body: object, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch
}

describe('send()', () => {
  it('throws when no key is configured', async () => {
    const relay = makeSendRelay(mockSendFetch({ text: '{}' }))
    await expect(relay.send('m', 's', [])).rejects.toThrow('No API key')
  })

  it('posts model, system, items, and additions to {endpoint}/relay', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = mockSendFetch({ text: '{}' })
    const relay = makeSendRelay(fetchFn)
    const items = [createMessageItem('user', 'hello'), createMessageItem('agent', 'hi')]
    await relay.send('claude-3', 'Be helpful.', items)
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(url).toBe(`${ENDPOINT}/relay`)
    expect(body.model).toBe('claude-3')
    expect(body.system).toBe('Be helpful.')
    expect(body.items).toEqual([
      { from: 'user', body: 'hello' },
      { from: 'agent', body: 'hi' },
    ])
    expect(body.additions).toEqual([])
  })

  it('preserves from: agent on agent items — role mapping is the relay handler\'s concern', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = mockSendFetch({ text: '{}' })
    await makeSendRelay(fetchFn).send('m', 's', [createMessageItem('agent', 'reply')])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.items[0]).toEqual({ from: 'agent', body: 'reply' })
  })

  it('sends additions as a separate array alongside items', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = mockSendFetch({ text: '{}' })
    await makeSendRelay(fetchFn).send('m', 's', [createMessageItem('user', 'hi')], ['[Reasoning]\nthink', '[Context]\ndata'])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.items).toEqual([{ from: 'user', body: 'hi' }])
    expect(body.additions).toEqual(['[Reasoning]\nthink', '[Context]\ndata'])
  })

  it('sends empty items and additions when both are empty', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = mockSendFetch({ text: '{}' })
    await makeSendRelay(fetchFn).send('m', 's', [])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.items).toEqual([])
    expect(body.additions).toEqual([])
  })

  it('includes _relay metadata with keyId, ciphertext, and provider', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'my-key', ciphertext: 'my-ct' })
    const fetchFn = mockSendFetch({ text: '{}' })
    await makeSendRelay(fetchFn).send('m', 's', [])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body._relay).toEqual({ keyId: 'my-key', ciphertext: 'my-ct', provider: 'anthropic' })
  })

  it('returns text and usage from the response', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const result = await makeSendRelay(
      mockSendFetch({ text: '{"invocations":[]}', usage: { inputTokens: 100, outputTokens: 40 } })
    ).send('m', 's', [])
    expect(result.text).toBe('{"invocations":[]}')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40 })
  })

  it('returns undefined usage when relay omits it', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const result = await makeSendRelay(mockSendFetch({ text: '{}' })).send('m', 's', [])
    expect(result.usage).toBeUndefined()
  })

  it('throws on a non-ok relay response', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    await expect(
      makeSendRelay(mockSendFetch({ error: 'rate limited' }, false)).send('m', 's', [])
    ).rejects.toThrow('500')
  })

  it('throws when the relay response is missing the text field', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    await expect(
      makeSendRelay(mockSendFetch({ result: 'oops' })).send('m', 's', [])
    ).rejects.toThrow('"text"')
  })

  it('forwards AbortSignal to fetch', async () => {
    store[STORAGE_KEY] = JSON.stringify({ keyId: 'k', ciphertext: 'c' })
    const fetchFn = mockSendFetch({ text: '{}' })
    const signal = new AbortController().signal
    await makeSendRelay(fetchFn).send('m', 's', [], [], signal)
    expect((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).signal).toBe(signal)
  })
})
