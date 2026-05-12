import { describe, expect, it, vi } from 'vitest'
import { getPublicKey, postRelay } from './api.js'
import type { RelayRequest } from './api.js'

const ENDPOINT = 'https://relay.example.com'

function mockFetch(body: object, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch
}

// ── getPublicKey ──────────────────────────────────────────────────────────

describe('getPublicKey', () => {
  it('fetches the /public-key path on the given endpoint', async () => {
    const fetchFn = mockFetch({ keyId: 'k', publicKeyPem: 'pem' })
    await getPublicKey(ENDPOINT, fetchFn)
    expect(vi.mocked(fetchFn)).toHaveBeenCalledWith(`${ENDPOINT}/public-key`)
  })

  it('returns keyId and publicKeyPem', async () => {
    const result = await getPublicKey(ENDPOINT, mockFetch({ keyId: 'abc', publicKeyPem: 'my-pem' }))
    expect(result.keyId).toBe('abc')
    expect(result.publicKeyPem).toBe('my-pem')
  })

  it('throws when the response is not ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch
    await expect(getPublicKey(ENDPOINT, fetchFn)).rejects.toThrow('503')
  })

  it('propagates a network-level fetch rejection', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    await expect(getPublicKey(ENDPOINT, fetchFn)).rejects.toThrow('network down')
  })

  it('throws when the response is missing keyId', async () => {
    await expect(getPublicKey(ENDPOINT, mockFetch({ publicKeyPem: 'pem' }))).rejects.toThrow()
  })

  it('throws when the response is missing publicKeyPem', async () => {
    await expect(getPublicKey(ENDPOINT, mockFetch({ keyId: 'k' }))).rejects.toThrow()
  })

  it('throws when the response is not an object', async () => {
    await expect(getPublicKey(ENDPOINT, mockFetch(42 as unknown as object))).rejects.toThrow()
  })
})

// ── postRelay ─────────────────────────────────────────────────────────────

const REQUEST: RelayRequest = {
  model: 'test-model',
  system: 'Be helpful.',
  items: [{ from: 'user', body: 'hello' }],
  additions: [],
  _relay: { keyId: 'k', ciphertext: 'c', provider: 'anthropic' },
}

describe('postRelay', () => {
  it('posts to {endpoint}/relay', async () => {
    const fetchFn = mockFetch({ text: '{}' })
    await postRelay(ENDPOINT, REQUEST, fetchFn)
    expect(vi.mocked(fetchFn).mock.calls[0][0]).toBe(`${ENDPOINT}/relay`)
  })

  it('uses POST method', async () => {
    const fetchFn = mockFetch({ text: '{}' })
    await postRelay(ENDPOINT, REQUEST, fetchFn)
    expect((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).method).toBe('POST')
  })

  it('sets Content-Type: application/json', async () => {
    const fetchFn = mockFetch({ text: '{}' })
    await postRelay(ENDPOINT, REQUEST, fetchFn)
    const headers = (vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('serializes the full request body as JSON', async () => {
    const fetchFn = mockFetch({ text: '{}' })
    await postRelay(ENDPOINT, REQUEST, fetchFn)
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('test-model')
    expect(body.system).toBe('Be helpful.')
    expect(body.items).toEqual([{ from: 'user', body: 'hello' }])
    expect(body.additions).toEqual([])
    expect(body._relay).toEqual({ keyId: 'k', ciphertext: 'c', provider: 'anthropic' })
  })

  it('returns text and usage from the response', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } }))
    expect(result.text).toBe('ok')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('returns undefined usage when the relay omits it', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok' }))
    expect(result.usage).toBeUndefined()
  })

  it('returns undefined usage when usage values are non-numeric strings', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', usage: { inputTokens: '10', outputTokens: '5' } }))
    expect(result.usage).toBeUndefined()
  })

  it('throws on a non-ok response', async () => {
    await expect(postRelay(ENDPOINT, REQUEST, mockFetch({ error: 'rate limited' }, false))).rejects.toThrow('500')
  })

  it('throws when the response is missing the text field', async () => {
    await expect(postRelay(ENDPOINT, REQUEST, mockFetch({ result: 'oops' }))).rejects.toThrow('"text"')
  })

  it('passes rekey through when the relay includes it', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: { keyId: 'new-id', ciphertext: 'new-ct' } }))
    expect(result.rekey).toEqual({ keyId: 'new-id', ciphertext: 'new-ct' })
  })

  it('omits rekey when the relay does not include it', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok' }))
    expect('rekey' in result).toBe(false)
  })

  it('omits rekey when ciphertext is an empty string', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: { keyId: 'k', ciphertext: '' } }))
    expect('rekey' in result).toBe(false)
  })

  it('omits rekey when keyId is missing', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: { ciphertext: 'abc' } }))
    expect('rekey' in result).toBe(false)
  })

  it('omits rekey when the value is not an object', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: 'bad' }))
    expect('rekey' in result).toBe(false)
  })

  it('omits rekey when ciphertext exceeds 512 characters', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: { keyId: 'k', ciphertext: 'A'.repeat(513) } }))
    expect('rekey' in result).toBe(false)
  })

  it('omits rekey when keyId or ciphertext are null', async () => {
    const result = await postRelay(ENDPOINT, REQUEST, mockFetch({ text: 'ok', rekey: { keyId: null, ciphertext: null } }))
    expect('rekey' in result).toBe(false)
  })

  it('forwards the AbortSignal to fetch', async () => {
    const fetchFn = mockFetch({ text: '{}' })
    const signal = new AbortController().signal
    await postRelay(ENDPOINT, REQUEST, fetchFn, signal)
    expect((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).signal).toBe(signal)
  })
})
