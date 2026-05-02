import { describe, expect, it, vi } from 'vitest'
import { parseAgentResponse, createRuntime, PROTOCOL_PROMPT } from './runtime.js'
import type { HookDefinition } from './hooks.js'
import type { Relay } from './client.js'

// ── parseAgentResponse ────────────────────────────────────────────────────

describe('parseAgentResponse', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({ invocations: [{ hook: 'send-message', params: { text: 'hi' } }] })
    const res = parseAgentResponse(raw)
    expect(res.invocations).toHaveLength(1)
    expect(res.invocations[0].hook).toBe('send-message')
  })

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n{"invocations":[]}\n```'
    expect(parseAgentResponse(raw).invocations).toEqual([])
  })

  it('throws on non-JSON response', () => {
    expect(() => parseAgentResponse('hello there')).toThrow('not valid JSON')
  })

  it('throws when invocations key is missing', () => {
    expect(() => parseAgentResponse('{"foo":"bar"}')).toThrow('"invocations"')
  })

  it('throws when invocations is not an array', () => {
    expect(() => parseAgentResponse('{"invocations":"oops"}')).toThrow('"invocations"')
  })
})

// ── createRuntime ─────────────────────────────────────────────────────────

// Relay mock returns normalized { text } — the same shape the proxy Lambda produces
function makeRelay(responseText: string): Relay {
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ text: responseText }),
    text: async () => responseText,
  })
  return {
    setKey: vi.fn(),
    hasKey: () => true,
    clearKey: vi.fn(),
    createFetch: () => fetchFn as unknown as typeof fetch,
  }
}

const MODEL = 'test-model'

describe('createRuntime', () => {
  it('appends PROTOCOL_PROMPT to the system prompt sent to the relay', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: 'You are helpful.', hooks: [] })
    await runtime.send('hi')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.system).toContain('You are helpful.')
    expect(body.system).toContain(PROTOCOL_PROMPT)
  })

  it('uses PROTOCOL_PROMPT alone when no system prompt is provided', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('hi')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.system).toBe(PROTOCOL_PROMPT)
  })

  it('calls message hook with LLM response params', async () => {
    const received: unknown[] = []
    const hooks: HookDefinition[] = [{
      name: 'send-message',
      type: 'message',
      description: 'Send a message',
      handler: (p) => { received.push(p) },
    }]

    const relay = makeRelay(JSON.stringify({
      invocations: [{ hook: 'send-message', params: { text: 'Hello!' } }],
    }))

    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: 'You are helpful.', hooks })
    await runtime.send('hi')
    expect(received).toHaveLength(1)
    expect((received[0] as { text: string }).text).toBe('Hello!')
  })

  it('runs context hook and re-invokes with injected context', async () => {
    const messages: string[] = []

    const hooks: HookDefinition[] = [
      {
        name: 'get-pricing',
        type: 'context',
        description: 'Fetch pricing',
        handler: async () => 'Pricing: $99/mo',
      },
      {
        name: 'send-message',
        type: 'message',
        description: 'Send message',
        handler: (p) => { messages.push((p as { text: string }).text) },
      },
    ]

    let call = 0
    const texts = [
      JSON.stringify({ invocations: [{ hook: 'get-pricing' }] }),
      JSON.stringify({ invocations: [{ hook: 'send-message', params: { text: 'Pricing loaded!' } }] }),
    ]
    const fetchFn = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ text: texts[call++] }),
    }))

    const relay: Relay = {
      setKey: vi.fn(),
      hasKey: () => true,
      clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }

    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks })
    await runtime.send('what does it cost?')
    expect(messages).toEqual(['Pricing loaded!'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('runs ui hook before message hook', async () => {
    const order: string[] = []

    const hooks: HookDefinition[] = [
      {
        name: 'update-visualization',
        type: 'ui',
        description: 'Update page visualization',
        handler: () => { order.push('ui') },
      },
      {
        name: 'send-message',
        type: 'message',
        description: 'Send message',
        handler: () => { order.push('message') },
      },
    ]

    const relay = makeRelay(JSON.stringify({
      invocations: [
        { hook: 'update-visualization', params: {} },
        { hook: 'send-message', params: { text: 'Done!' } },
      ],
    }))

    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks })
    await runtime.send('show me')
    expect(order).toEqual(['ui', 'message'])
  })

  it('reset clears conversation state', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('hello')
    runtime.reset()
    await runtime.send('hello again')
    const calls = (relay.createFetch() as ReturnType<typeof vi.fn>).mock.calls
    const lastBody = JSON.parse((calls.at(-1)?.[1] as RequestInit).body as string)
    expect(lastBody.messages).toHaveLength(1)
  })

  it('throws when max context depth is exceeded', async () => {
    const hooks: HookDefinition[] = [{
      name: 'ctx',
      type: 'context',
      description: 'endless context',
      handler: async () => 'data',
    }]

    const relay = makeRelay(JSON.stringify({ invocations: [{ hook: 'ctx' }] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks, maxContextDepth: 2 })
    await expect(runtime.send('go')).rejects.toThrow('Max context depth')
  })
})
