import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockKmsSend, mockSsmSend, KMSInvalidStateException, InvalidCiphertextException, mockPublicEncrypt } = vi.hoisted(() => {
  class KMSInvalidStateException extends Error {
    readonly name = 'KMSInvalidStateException'
    readonly $fault = 'client' as const
    readonly $metadata = {}
  }
  class InvalidCiphertextException extends Error {
    readonly name = 'InvalidCiphertextException'
    readonly $fault = 'client' as const
    readonly $metadata = {}
  }
  return {
    mockKmsSend: vi.fn(),
    mockSsmSend: vi.fn(),
    KMSInvalidStateException,
    InvalidCiphertextException,
    mockPublicEncrypt: vi.fn(() => Buffer.from('re-encrypted')),
  }
})

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class {
    send(...args: unknown[]) { return mockKmsSend(...args) }
  },
  DecryptCommand: class {
    constructor(public input: unknown) {}
  },
  KMSInvalidStateException,
  InvalidCiphertextException,
}))

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  return { ...actual, publicEncrypt: mockPublicEncrypt }
})

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send(...args: unknown[]) { return mockSsmSend(...args) }
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}))

import { handler } from './proxy.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const KEY_ENTRY = {
  keyId: 'test-key-id',
  keyArn: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
}

const CURRENT_KEY_ENTRY = {
  keyId: 'current-key-id',
  keyArn: 'arn:aws:kms:us-east-1:123456789012:key/current-key-id',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\ncurrent\n-----END PUBLIC KEY-----',
}

function makeEvent(provider: 'anthropic' | 'openai' | 'gemini' = 'anthropic') {
  return {
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({
      model: 'claude-3',
      system: 'Be helpful.',
      items: [],
      additions: [],
      _relay: {
        keyId: 'test-key-id',
        ciphertext: Buffer.from('encrypted').toString('base64'),
        provider,
      },
    }),
  }
}

// KEY_ENTRY is SSM_CURRENT — key is current, no re-encryption needed
function stubSsm() {
  mockSsmSend
    .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(KEY_ENTRY) } })
    .mockResolvedValueOnce(null)
}

// KEY_ENTRY has been rotated to SSM_PREVIOUS; CURRENT_KEY_ENTRY is SSM_CURRENT
function stubSsmStale() {
  mockSsmSend
    .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(CURRENT_KEY_ENTRY) } })
    .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(KEY_ENTRY) } })
}

function stubProviderFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }))
}

// ── usage extraction ──────────────────────────────────────────────────────────

describe('proxy handler — usage extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test-key') })
  })

  it('includes normalized usage for Anthropic responses', async () => {
    stubProviderFetch({
      content: [{ type: 'text', text: '{"invocations":[]}' }],
      usage: { input_tokens: 150, output_tokens: 60 },
    })
    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.usage).toEqual({ inputTokens: 150, outputTokens: 60 })
  })

  it('includes normalized usage for OpenAI responses', async () => {
    stubProviderFetch({
      choices: [{ message: { content: '{"invocations":[]}' } }],
      usage: { prompt_tokens: 200, completion_tokens: 75 },
    })
    const result = await handler(makeEvent('openai') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.usage).toEqual({ inputTokens: 200, outputTokens: 75 })
  })

  it('includes normalized usage for Gemini responses', async () => {
    stubProviderFetch({
      candidates: [{ content: { parts: [{ text: '{"invocations":[]}' }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
    })
    const result = await handler(makeEvent('gemini') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.usage).toEqual({ inputTokens: 120, outputTokens: 45 })
  })

  it('omits usage when provider response has no usage field', async () => {
    stubProviderFetch({
      content: [{ type: 'text', text: '{"invocations":[]}' }],
    })
    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect('usage' in body).toBe(false)
  })

  it('defaults missing token counts to zero', async () => {
    stubProviderFetch({
      content: [{ type: 'text', text: '{"invocations":[]}' }],
      usage: {},
    })
    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('always includes text alongside usage', async () => {
    stubProviderFetch({
      content: [{ type: 'text', text: '{"invocations":[]}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(typeof body.text).toBe('string')
    expect(body.usage).toBeDefined()
  })
})

// ── key re-encryption ─────────────────────────────────────────────────────────

describe('proxy handler — key re-encryption', () => {
  beforeEach(() => vi.clearAllMocks())

  it('includes rekey in the response when the request key is in SSM_PREVIOUS', async () => {
    stubSsmStale()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test-key') })
    mockPublicEncrypt.mockReturnValue(Buffer.from('re-encrypted'))
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })

    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.rekey).toEqual({
      keyId: CURRENT_KEY_ENTRY.keyId,
      ciphertext: Buffer.from('re-encrypted').toString('base64'),
    })
  })

  it('calls publicEncrypt with the current key PEM and OAEP/SHA-256 params', async () => {
    stubSsmStale()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test-key') })
    mockPublicEncrypt.mockReturnValue(Buffer.from('re-encrypted'))
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })

    await handler(makeEvent('anthropic') as never)
    const [opts] = mockPublicEncrypt.mock.calls[0] as [{ key: string; oaepHash: string; mgf1Hash: string }]
    expect(opts.key).toBe(CURRENT_KEY_ENTRY.publicKeyPem)
    expect(opts.oaepHash).toBe('sha256')
    expect(opts.mgf1Hash).toBe('sha256')
  })

  it('omits rekey when the request key is already the current key', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test-key') })
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })

    const result = await handler(makeEvent('anthropic') as never)
    const body = JSON.parse((result as { body: string }).body)
    expect('rekey' in body).toBe(false)
    expect(mockPublicEncrypt).not.toHaveBeenCalled()
  })

  it('still returns 200 with text when re-encryption throws', async () => {
    stubSsmStale()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test-key') })
    mockPublicEncrypt.mockImplementation(() => { throw new Error('bad pem') })
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })

    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(200)
    const body = JSON.parse((result as { body: string }).body)
    expect(typeof body.text).toBe('string')
    expect('rekey' in body).toBe(false)
  })
})

// ── input validation ──────────────────────────────────────────────────────────

describe('proxy handler — input validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a ciphertext longer than 512 characters with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3',
        system: '',
        items: [],
        additions: [],
        _relay: { keyId: 'k', ciphertext: 'A'.repeat(513), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
    expect(JSON.parse((result as { body: string }).body).error).toMatch(/ciphertext/i)
  })

  it('rejects a non-string ciphertext with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3',
        system: '',
        items: [],
        additions: [],
        _relay: { keyId: 'k', ciphertext: 12345, provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
  })

  it('rejects a model with path-traversal characters with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: '../../etc',
        system: '',
        items: [],
        additions: [],
        _relay: { keyId: 'k', ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
    expect(JSON.parse((result as { body: string }).body).error).toMatch(/model/i)
  })

  it('rejects a model with query-injection characters with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'gemini?redirect=evil.com',
        system: '',
        items: [],
        additions: [],
        _relay: { keyId: 'k', ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
  })

  it('accepts a valid model name', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test') })
    stubProviderFetch({ content: [{ type: 'text', text: '{"ok":true}' }] })
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(200)
  })

  it('rejects items array longer than 200 with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: '', additions: [],
        items: Array.from({ length: 201 }, () => ({ from: 'user', body: 'hi' })),
        _relay: { keyId: 'k', ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
    expect(JSON.parse((result as { body: string }).body).error).toMatch(/too many/i)
  })

  it('rejects additions array longer than 50 with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: '', items: [],
        additions: Array.from({ length: 51 }, () => 'extra'),
        _relay: { keyId: 'k', ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
  })

  it('rejects a system prompt longer than 100k characters with 400', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: 'x'.repeat(100_001), items: [], additions: [],
        _relay: { keyId: 'k', ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
    expect(JSON.parse((result as { body: string }).body).error).toMatch(/too long/i)
  })

  it('silently drops items with non-string body', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test') })
    stubProviderFetch({ content: [{ type: 'text', text: '{"ok":true}' }] })
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: '', additions: [],
        items: [{ from: 'user', body: 'valid' }, { from: 'user', body: null }, { from: 'user', body: 42 }],
        _relay: { keyId: KEY_ENTRY.keyId, ciphertext: Buffer.from('ct').toString('base64'), provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(200)
  })
})

// ── SSM shape validation ──────────────────────────────────────────────────────

describe('proxy handler — SSM shape validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when SSM current contains malformed JSON', async () => {
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'not-valid-json{{{' } })
      .mockResolvedValueOnce(null)
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(401)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toMatch(/unknown or expired/i)
  })

  it('returns 401 when SSM entry is missing required fields', async () => {
    mockSsmSend
      .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify({ keyId: 123, keyArn: 'arn', publicKeyPem: 'pem' }) } })
      .mockResolvedValueOnce(null)
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(401)
  })
})

// ── relay meta validation ─────────────────────────────────────────────────────

describe('proxy handler — relay meta validation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when relay keyId is not a string', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: '', items: [], additions: [],
        _relay: { keyId: 123, ciphertext: 'abc', provider: 'anthropic' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
  })

  it('returns 400 when relay provider is not a string', async () => {
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'claude-3', system: '', items: [], additions: [],
        _relay: { keyId: 'k', ciphertext: 'abc', provider: 42 },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
  })
})

// ── kms error handling ────────────────────────────────────────────────────────

describe('proxy handler — KMS error handling', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when KMS throws InvalidCiphertextException', async () => {
    stubSsm()
    mockKmsSend.mockRejectedValue(new InvalidCiphertextException('bad ciphertext'))
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(401)
  })

  it('returns 401 when KMS Decrypt returns undefined Plaintext', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: undefined })
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(401)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toMatch(/revoked/)
  })

  it('does not include the plaintext key in any 200 response', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-super-secret-key') })
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { body: string }).body).not.toContain('sk-super-secret-key')
  })

  it('does not include the plaintext key in any rekey response', async () => {
    stubSsmStale()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-super-secret-key') })
    mockPublicEncrypt.mockReturnValue(Buffer.from('re-encrypted'))
    stubProviderFetch({ content: [{ type: 'text', text: '{"invocations":[]}' }] })
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { body: string }).body).not.toContain('sk-super-secret-key')
  })
})

// ── key state guard ───────────────────────────────────────────────────────────

describe('proxy handler — key state guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when KMS rejects the key as PendingDeletion', async () => {
    stubSsm()
    mockKmsSend.mockRejectedValue(new KMSInvalidStateException('Key is pending deletion'))
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(401)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toMatch(/revoked/)
  })

  it('re-throws unexpected KMS errors', async () => {
    stubSsm()
    mockKmsSend.mockRejectedValue(new Error('InternalServiceError'))
    await expect(handler(makeEvent('anthropic') as never)).rejects.toThrow('InternalServiceError')
  })
})

// ── provider response handling ────────────────────────────────────────────────

describe('proxy handler — provider response handling', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns opaque "Provider error" and not the raw provider body on non-ok response', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":{"type":"rate_limit_error","message":"rate limited"}}',
      json: async () => ({}),
    }))
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(429)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toBe('Provider error')
    expect(JSON.stringify(body)).not.toContain('rate_limit_error')
  })

  it('returns 502 when provider returns a non-JSON 200 body', async () => {
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test') })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    }))
    const result = await handler(makeEvent('anthropic') as never)
    expect((result as { statusCode: number }).statusCode).toBe(502)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toMatch(/invalid response/i)
  })
})

// ── provider guard ────────────────────────────────────────────────────────────

describe('proxy handler — provider guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a provider not in the PROVIDERS env var', async () => {
    vi.stubEnv('PROVIDERS', 'anthropic')
    const event = {
      requestContext: { http: { method: 'POST' } },
      body: JSON.stringify({
        model: 'gpt-4',
        system: '',
        items: [],
        additions: [],
        _relay: { keyId: 'k', ciphertext: 'c', provider: 'openai' },
      }),
    }
    const result = await handler(event as never)
    expect((result as { statusCode: number }).statusCode).toBe(400)
    const body = JSON.parse((result as { body: string }).body)
    expect(body.error).toMatch(/not allowed/)
    vi.unstubAllEnvs()
  })

  it('accepts a provider that is in the PROVIDERS env var', async () => {
    vi.stubEnv('PROVIDERS', 'anthropic,openai')
    stubSsm()
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-test') })
    stubProviderFetch({ choices: [{ message: { content: '{"ok":true}' } }] })
    const result = await handler(makeEvent('openai') as never)
    expect((result as { statusCode: number }).statusCode).toBe(200)
    vi.unstubAllEnvs()
  })
})
