import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockKmsSend, mockSsmSend } = vi.hoisted(() => ({
  mockKmsSend: vi.fn(),
  mockSsmSend: vi.fn(),
}))

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class {
    send(...args: unknown[]) { return mockKmsSend(...args) }
  },
  DecryptCommand: class {
    constructor(public input: unknown) {}
  },
}))

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

function stubSsm() {
  mockSsmSend
    .mockResolvedValueOnce({ Parameter: { Value: JSON.stringify(KEY_ENTRY) } })
    .mockResolvedValueOnce(null)
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
