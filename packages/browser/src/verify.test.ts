import { describe, expect, it, vi } from 'vitest'
import { verify } from './verify.js'
import type { VerifyManifest } from './verify.js'

const ENDPOINT = 'https://relay.example.com'

const MANIFEST: VerifyManifest = {
  version: '0.1.2',
  handlers: {
    proxy:       'sha256:aaa=',
    rotation:    'sha256:bbb=',
    'public-key':'sha256:ccc=',
  },
}

function mockFetch(liveHandlers: Record<string, string>, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ handlers: liveHandlers }),
  }) as unknown as typeof fetch
}

const MATCHING_LIVE = { proxy: 'sha256:aaa=', rotation: 'sha256:bbb=', 'public-key': 'sha256:ccc=' }

describe('verify', () => {
  it('calls the /integrity endpoint on the given base URL', async () => {
    const fetchFn = mockFetch(MATCHING_LIVE)
    await verify(ENDPOINT, MANIFEST, fetchFn)
    expect(vi.mocked(fetchFn)).toHaveBeenCalledWith(`${ENDPOINT}/integrity`)
  })

  it('returns valid=true when all live hashes match the manifest', async () => {
    const result = await verify(ENDPOINT, MANIFEST, mockFetch(MATCHING_LIVE))
    expect(result.valid).toBe(true)
  })

  it('returns the manifest version in the result', async () => {
    const result = await verify(ENDPOINT, MANIFEST, mockFetch(MATCHING_LIVE))
    expect(result.version).toBe('0.1.2')
  })

  it('returns per-handler live, published, and match fields', async () => {
    const result = await verify(ENDPOINT, MANIFEST, mockFetch(MATCHING_LIVE))
    expect(result.handlers.proxy).toEqual({ live: 'sha256:aaa=', published: 'sha256:aaa=', match: true })
  })

  it('returns valid=false when any handler hash does not match', async () => {
    const result = await verify(ENDPOINT, MANIFEST, mockFetch({ ...MATCHING_LIVE, proxy: 'sha256:WRONG=' }))
    expect(result.valid).toBe(false)
    expect(result.handlers.proxy.match).toBe(false)
    expect(result.handlers.rotation.match).toBe(true)
  })

  it('treats a handler missing from the live response as a mismatch', async () => {
    const { proxy: _, ...withoutProxy } = MATCHING_LIVE
    const result = await verify(ENDPOINT, MANIFEST, mockFetch(withoutProxy))
    expect(result.valid).toBe(false)
    expect(result.handlers.proxy).toEqual({ live: '', published: 'sha256:aaa=', match: false })
  })

  it('throws when the integrity endpoint returns a non-ok status', async () => {
    await expect(verify(ENDPOINT, MANIFEST, mockFetch({}, false))).rejects.toThrow('500')
  })

  it('propagates a network-level fetch rejection', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    await expect(verify(ENDPOINT, MANIFEST, fetchFn)).rejects.toThrow('network down')
  })
})
