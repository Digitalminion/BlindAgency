import { describe, expect, it, vi } from 'vitest'
import { parseAgentResponse, callLlm, runTurn, createRuntime, PROTOCOL_PROMPT } from './runtime.js'
import { createHookRegistry } from './hooks.js'
import { createThread, createMessageItem } from './thread.js'
import type { HookDefinition } from './hooks.js'
import type { TurnContext } from './runtime.js'
import type { ThreadMessage } from './thread.js'
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

  it('strips plain code fences (no language specifier)', () => {
    const raw = '```\n{"invocations":[]}\n```'
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

  it('throws when the top-level value is a JSON array', () => {
    expect(() => parseAgentResponse('[]')).toThrow('"invocations"')
  })

  it('throws when the top-level value is JSON null', () => {
    expect(() => parseAgentResponse('null')).toThrow('"invocations"')
  })

  it('truncates long responses to 200 chars in error messages', () => {
    const longGarbage = 'x'.repeat(300)
    let err: Error | undefined
    try { parseAgentResponse(longGarbage) } catch (e) { err = e as Error }
    expect(err).toBeDefined()
    expect(err!.message).toContain('x'.repeat(200))
    expect(err!.message).not.toContain('x'.repeat(201))
  })

  it('preserves params and extra invocation fields', () => {
    const raw = JSON.stringify({
      invocations: [{ hook: 'a', params: { n: 1 }, extra: 'ignored' }],
    })
    const res = parseAgentResponse(raw)
    expect((res.invocations[0].params as { n: number }).n).toBe(1)
  })

  it('parses a reasoning field when present', () => {
    const raw = JSON.stringify({ reasoning: 'I need more data.', invocations: [] })
    expect(parseAgentResponse(raw).reasoning).toBe('I need more data.')
  })

  it('reasoning is undefined when absent', () => {
    const raw = JSON.stringify({ invocations: [] })
    expect(parseAgentResponse(raw).reasoning).toBeUndefined()
  })

  it('ignores a non-string reasoning field', () => {
    const raw = JSON.stringify({ reasoning: 42, invocations: [] })
    expect(parseAgentResponse(raw).reasoning).toBeUndefined()
  })

  it('parses reasoningComplete: true', () => {
    const raw = JSON.stringify({ reasoningComplete: true, invocations: [] })
    expect(parseAgentResponse(raw).reasoningComplete).toBe(true)
  })

  it('reasoningComplete is undefined when absent', () => {
    const raw = JSON.stringify({ invocations: [] })
    expect(parseAgentResponse(raw).reasoningComplete).toBeUndefined()
  })

  it('ignores reasoningComplete: false — only literal true is accepted', () => {
    const raw = JSON.stringify({ reasoningComplete: false, invocations: [] })
    expect(parseAgentResponse(raw).reasoningComplete).toBeUndefined()
  })

  it('ignores a non-boolean reasoningComplete value', () => {
    const raw = JSON.stringify({ reasoningComplete: 'true', invocations: [] })
    expect(parseAgentResponse(raw).reasoningComplete).toBeUndefined()
  })
})

// ── callLlm ───────────────────────────────────────────────────────────────

function makeFetch(response: object, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }) as unknown as typeof fetch
}

describe('callLlm', () => {
  it('sends model, system prompt, and messages in the request body', async () => {
    const fetchFn = makeFetch({ text: 'reply' })
    await callLlm(fetchFn, 'claude-3', 'Be helpful.', [{ role: 'user', content: 'hi' }])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('claude-3')
    expect(body.system).toBe('Be helpful.')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('returns the text field from the relay response', async () => {
    const result = await callLlm(makeFetch({ text: 'hello!' }), 'm', 's', [])
    expect(result.text).toBe('hello!')
  })

  it('throws when the relay returns a non-ok status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => 'rate limited',
    }) as unknown as typeof fetch
    await expect(callLlm(fetchFn, 'm', 's', [])).rejects.toThrow('429')
  })

  it('throws when the relay response is missing the text field', async () => {
    await expect(callLlm(makeFetch({ result: 'oops' }), 'm', 's', [])).rejects.toThrow('"text"')
  })

  it('throws when the text field is not a string', async () => {
    await expect(callLlm(makeFetch({ text: 42 }), 'm', 's', [])).rejects.toThrow('"text"')
  })

  it('throws when the text field is null', async () => {
    await expect(callLlm(makeFetch({ text: null }), 'm', 's', [])).rejects.toThrow('"text"')
  })

  it('returns an empty string when text is empty', async () => {
    const result = await callLlm(makeFetch({ text: '' }), 'm', 's', [])
    expect(result.text).toBe('')
  })

  it('includes the error body in the thrown message on non-ok status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => 'PROTOCOL_VIOLATION',
    }) as unknown as typeof fetch
    await expect(callLlm(fetchFn, 'm', 's', [])).rejects.toThrow('PROTOCOL_VIOLATION')
  })

  it('propagates a network-level fetch rejection', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch
    await expect(callLlm(fetchFn, 'm', 's', [])).rejects.toThrow('network error')
  })

  it('returns usage from the relay response when present', async () => {
    const result = await callLlm(makeFetch({ text: '{}', usage: { inputTokens: 100, outputTokens: 50 } }), 'm', 's', [])
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('usage is undefined when the relay omits it', async () => {
    const result = await callLlm(makeFetch({ text: '{}' }), 'm', 's', [])
    expect(result.usage).toBeUndefined()
  })

  it('forwards the AbortSignal to fetch', async () => {
    const fetchFn = makeFetch({ text: '{}' })
    const signal = AbortSignal.abort()
    // AbortSignal.abort() is already aborted — fetch should receive it
    await callLlm(fetchFn, 'm', 's', [], signal)
    const init = vi.mocked(fetchFn).mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(signal)
  })

  it('sends an empty messages array when there is no history', async () => {
    const fetchFn = makeFetch({ text: 'ok' })
    await callLlm(fetchFn, 'm', 's', [])
    const body = JSON.parse((vi.mocked(fetchFn).mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages).toEqual([])
  })
})

// ── runTurn ───────────────────────────────────────────────────────────────

function makeCtx(
  responses: string[],
  hooks: HookDefinition[] = [],
  maxDepth = 5,
): TurnContext & { thread: ReturnType<typeof createThread> } {
  let call = 0
  const thread = createThread()
  return {
    callLlm: vi.fn().mockImplementation(async () => ({ text: responses[call++] ?? '{"invocations":[]}' })) as TurnContext['callLlm'],
    registry: createHookRegistry(hooks),
    thread,
    maxDepth,
  }
}

describe('runTurn', () => {
  it('appends the LLM response as an agent message item', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [] })])
    await runTurn(ctx, 0)
    const last = ctx.thread.items.at(-1) as ReturnType<typeof createMessageItem>
    expect(last.kind).toBe('message')
    expect(last.from).toBe('agent')
  })

  it('does not append a malformed response to the thread', async () => {
    const thread = createThread()
    thread.append(createMessageItem('user', 'hello'))
    const ctx: TurnContext = {
      callLlm: vi.fn().mockResolvedValue({ text: 'not valid json' }),
      registry: createHookRegistry(),
      thread,
      maxDepth: 5,
    }
    await expect(runTurn(ctx, 0)).rejects.toThrow()
    expect(thread.items).toHaveLength(1)
    expect((thread.items[0] as ReturnType<typeof createMessageItem>).from).toBe('user')
  })

  it('silently skips unknown hooks', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'ghost' }] })])
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('calls a ui hook with its params', async () => {
    const called: unknown[] = []
    const hooks: HookDefinition[] = [{
      name: 'highlight', type: 'ui', description: '',
      handler: (p) => { called.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'highlight', params: { id: 'x' } }] })], hooks)
    await runTurn(ctx, 0)
    expect(called).toEqual([{ id: 'x' }])
  })

  it('calls multiple ui hooks in order', async () => {
    const order: string[] = []
    const hooks: HookDefinition[] = [
      { name: 'a', type: 'ui', description: '', handler: () => { order.push('a') } },
      { name: 'b', type: 'ui', description: '', handler: () => { order.push('b') } },
    ]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'a' }, { hook: 'b' }] })], hooks)
    await runTurn(ctx, 0)
    expect(order).toEqual(['a', 'b'])
  })

  it('calls a message hook with its params', async () => {
    const received: unknown[] = []
    const hooks: HookDefinition[] = [{
      name: 'reply', type: 'message', description: '',
      handler: (p) => { received.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'reply', params: { text: 'done' } }] })], hooks)
    await runTurn(ctx, 0)
    expect(received).toEqual([{ text: 'done' }])
  })

  it('passes ephemeral context to callLlm on re-invocation', async () => {
    const hooks: HookDefinition[] = [
      { name: 'fetch-data', type: 'context', description: '', handler: async () => 'some data' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'fetch-data' }] }),
      JSON.stringify({ invocations: [{ hook: 'reply', params: { text: 'done' } }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.callLlm)).toHaveBeenCalledTimes(2)
    const secondCallEphemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[]
    expect(secondCallEphemeral?.some(m => m.content.includes('some data'))).toBe(true)
  })

  it('context injection does not write to the thread', async () => {
    const hooks: HookDefinition[] = [
      { name: 'fetch-data', type: 'context', description: '', handler: async () => 'ephemeral result' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'fetch-data' }] }),
      JSON.stringify({ invocations: [{ hook: 'reply', params: { text: 'done' } }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const hasContextItem = ctx.thread.items.some(i =>
      (i as ReturnType<typeof createMessageItem>).body?.includes('ephemeral result')
    )
    expect(hasContextItem).toBe(false)
  })

  it('joins multiple context results and passes them as one ephemeral message', async () => {
    const hooks: HookDefinition[] = [
      { name: 'ctx-a', type: 'context', description: '', handler: async () => 'result A' },
      { name: 'ctx-b', type: 'context', description: '', handler: async () => 'result B' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ctx-a' }, { hook: 'ctx-b' }] }),
      JSON.stringify({ invocations: [{ hook: 'reply' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const ephemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[]
    const contextMsg = ephemeral?.find(m => m.content.includes('result A') && m.content.includes('result B'))
    expect(contextMsg).toBeDefined()
  })

  it('does not inject context when the handler returns nothing', async () => {
    const hooks: HookDefinition[] = [
      { name: 'side-effect', type: 'context', description: '', handler: async () => { return undefined as unknown as string } },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'side-effect' }] }),
      JSON.stringify({ invocations: [{ hook: 'reply' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const secondCallEphemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[] | undefined
    expect(secondCallEphemeral?.length ?? 0).toBe(0)
  })

  it('does not inject context when a non-string value is returned', async () => {
    const hooks: HookDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 42 as unknown as string },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ctx' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const ephemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[] | undefined
    expect(ephemeral?.length ?? 0).toBe(0)
  })

  it('runs ui hooks before message hooks', async () => {
    const order: string[] = []
    const hooks: HookDefinition[] = [
      { name: 'ui-hook', type: 'ui', description: '', handler: () => { order.push('ui') } },
      { name: 'msg-hook', type: 'message', description: '', handler: () => { order.push('msg') } },
    ]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'msg-hook' }, { hook: 'ui-hook' }] })], hooks)
    await runTurn(ctx, 0)
    expect(order).toEqual(['ui', 'msg'])
  })

  it('runs ui hooks even when context hooks are present', async () => {
    const uiCalled: boolean[] = []
    const hooks: HookDefinition[] = [
      { name: 'ui', type: 'ui', description: '', handler: () => { uiCalled.push(true) } },
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ui' }, { hook: 'ctx' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(uiCalled).toHaveLength(1)
  })

  it('suppresses message hooks when context hooks are present', async () => {
    const msgCalled: boolean[] = []
    const hooks: HookDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => { msgCalled.push(true) } },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ctx' }, { hook: 'msg' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(msgCalled).toHaveLength(1)
  })

  it('passes empty object to hook when params is absent', async () => {
    const received: unknown[] = []
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: (p) => { received.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'msg' }] })], hooks)
    await runTurn(ctx, 0)
    expect(received).toEqual([{}])
  })

  it('throws when max context depth is exceeded', async () => {
    const hooks: HookDefinition[] = [
      { name: 'loop', type: 'context', description: '', handler: async () => 'data' },
    ]
    const ctx = makeCtx(Array(10).fill(JSON.stringify({ invocations: [{ hook: 'loop' }] })), hooks, 2)
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
  })

  it('allows a turn at maxDepth and throws one step beyond', async () => {
    const hooks: HookDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ctx' }] }),
      JSON.stringify({ invocations: [{ hook: 'ctx' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks, 1)
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
    expect(vi.mocked(ctx.callLlm)).toHaveBeenCalledTimes(2)
  })

  it('propagates parseAgentResponse errors', async () => {
    const ctx = makeCtx(['not json at all'])
    await expect(runTurn(ctx, 0)).rejects.toThrow('not valid JSON')
  })

  it('propagates a callLlm rejection', async () => {
    const ctx: TurnContext = {
      callLlm: vi.fn().mockRejectedValue(new Error('relay down')) as TurnContext['callLlm'],
      registry: createHookRegistry(),
      thread: createThread(),
      maxDepth: 5,
    }
    await expect(runTurn(ctx, 0)).rejects.toThrow('relay down')
  })

  it('propagates a ui hook rejection', async () => {
    const hooks: HookDefinition[] = [{
      name: 'bad-ui', type: 'ui', description: '',
      handler: async () => { throw new Error('ui exploded') },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'bad-ui' }] })], hooks)
    await expect(runTurn(ctx, 0)).rejects.toThrow('ui exploded')
  })

  it('propagates a context hook rejection', async () => {
    const hooks: HookDefinition[] = [{
      name: 'bad-ctx', type: 'context', description: '',
      handler: async () => { throw new Error('ctx exploded') },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'bad-ctx' }] })], hooks)
    await expect(runTurn(ctx, 0)).rejects.toThrow('ctx exploded')
  })

  // ── usage tracking ─────────────────────────────────────────────────────────

  it('attaches usage from callLlm to the agent thread item', async () => {
    const thread = createThread()
    const ctx: TurnContext = {
      callLlm: vi.fn().mockResolvedValue({
        text: JSON.stringify({ invocations: [] }),
        usage: { inputTokens: 200, outputTokens: 80 },
      }) as TurnContext['callLlm'],
      registry: createHookRegistry(),
      thread,
      maxDepth: 5,
    }
    await runTurn(ctx, 0)
    const item = thread.items[0] as ReturnType<typeof createMessageItem>
    expect(item.usage).toEqual({ inputTokens: 200, outputTokens: 80 })
  })

  it('usage is undefined on the thread item when callLlm returns no usage', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [] })])
    await runTurn(ctx, 0)
    const item = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    expect(item.usage).toBeUndefined()
  })

  it('forwards the AbortSignal to callLlm', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [] })])
    const signal = new AbortController().signal
    await runTurn(ctx, 0, [], ctx.thread.items.length, signal)
    expect(vi.mocked(ctx.callLlm).mock.calls[0][1]).toBe(signal)
  })

  it('passes the signal through on recursive re-invocation', async () => {
    const hooks: HookDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'ctx' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    const signal = new AbortController().signal
    await runTurn(ctx, 0, [], ctx.thread.items.length, signal)
    for (const call of vi.mocked(ctx.callLlm).mock.calls) {
      expect(call[1]).toBe(signal)
    }
  })

  // ── hook param validation ──────────────────────────────────────────────────

  it('throws when a required message hook param is missing', async () => {
    const hooks: HookDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: () => {},
    }]
    // LLM omits the required "text" param
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'reply', params: {} }] })], hooks)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"text" is missing')
  })

  it('throws when a required context hook param is missing', async () => {
    const hooks: HookDefinition[] = [
      {
        name: 'fetch-data',
        type: 'context',
        description: '',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        handler: async () => 'data',
      },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ hook: 'fetch-data', params: {} }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"id" is missing')
  })

  it('throws when a required ui hook param is missing', async () => {
    const hooks: HookDefinition[] = [{
      name: 'highlight',
      type: 'ui',
      description: '',
      params: { type: 'object', properties: { featureId: { type: 'string' } }, required: ['featureId'] },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'highlight', params: {} }] })], hooks)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"featureId" is missing')
  })

  it('does not throw when all required params are present', async () => {
    const hooks: HookDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'reply', params: { text: 'hi' } }] })], hooks)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('does not throw when hook has no required fields declared', async () => {
    const hooks: HookDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } } },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'reply', params: {} }] })], hooks)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('does not throw when hook has no params schema at all', async () => {
    const hooks: HookDefinition[] = [{
      name: 'reply', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ hook: 'reply' }] })], hooks)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  // ── reasoning ──────────────────────────────────────────────────────────────

  it('reasoning alone triggers a re-invocation', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Let me think...', invocations: [] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.callLlm)).toHaveBeenCalledTimes(2)
  })

  it('reasoning text is injected as [Reasoning] ephemeral on re-invocation', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'I need pricing data.', invocations: [] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const secondCallEphemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[]
    expect(secondCallEphemeral?.some(m => m.content.includes('[Reasoning]') && m.content.includes('I need pricing data.'))).toBe(true)
  })

  it('reasoning + context hook — both are injected together before re-invocation', async () => {
    const hooks: HookDefinition[] = [
      { name: 'fetch-pricing', type: 'context', description: '', handler: async () => '$99/mo' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'I need the pricing model.', invocations: [{ hook: 'fetch-pricing' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const secondCallEphemeral = vi.mocked(ctx.callLlm).mock.calls[1][0] as ThreadMessage[]
    const hasReasoning = secondCallEphemeral?.some(m => m.content.includes('[Reasoning]'))
    const hasContext = secondCallEphemeral?.some(m => m.content.includes('$99/mo'))
    expect(hasReasoning).toBe(true)
    expect(hasContext).toBe(true)
  })

  it('reasoning + context hook — single re-invocation, not two', async () => {
    const hooks: HookDefinition[] = [
      { name: 'fetch-pricing', type: 'context', description: '', handler: async () => '$99/mo' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Need pricing.', invocations: [{ hook: 'fetch-pricing' }] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.callLlm)).toHaveBeenCalledTimes(2)
  })

  it('reasoning accumulates across multiple turns', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'First thought.', invocations: [] }),
      JSON.stringify({ reasoning: 'Second thought.', invocations: [] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    const thirdCallEphemeral = vi.mocked(ctx.callLlm).mock.calls[2][0] as ThreadMessage[]
    const contents = thirdCallEphemeral?.map(m => m.content).join('\n')
    expect(contents).toContain('First thought.')
    expect(contents).toContain('Second thought.')
  })

  it('reasoning counts against maxDepth', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx(
      Array(10).fill(JSON.stringify({ reasoning: 'thinking...', invocations: [] })),
      hooks,
      2,
    )
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
  })

  it('reasoning is not injected as a separate thread item — only raw LLM responses are written', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'private thought', invocations: [] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    // The [Reasoning] prefix marks an ephemeral injection — it should never appear
    // as the start of a thread item body. Raw LLM JSON bodies may contain the
    // reasoning text as a field value, which is expected and correct.
    const hasInjectionItem = ctx.thread.items.some(i =>
      (i as ReturnType<typeof createMessageItem>).body?.startsWith('[Reasoning]')
    )
    expect(hasInjectionItem).toBe(false)
  })

  // ── reasoningComplete (garbage collection) ──────────────────────────────────

  it('reasoningComplete prunes intermediate reasoning turns, leaving only the final item', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'First thought.', invocations: [] }),
      JSON.stringify({ reasoning: 'Second thought.', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(1)
    const final = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    expect(final.body).toContain('reasoningComplete')
  })

  it('thread is unchanged when reasoningComplete is absent', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking...', invocations: [] }),
      JSON.stringify({ invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(2)
  })

  it('reasoningComplete on a single-turn response is a no-op — final item is kept', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoningComplete: true, invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(1)
  })

  it('pruning preserves items that existed before runTurn was called', async () => {
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking...', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ hook: 'msg' }] }),
    ], hooks)
    ctx.thread.append(createMessageItem('user', 'hello'))
    const startLength = ctx.thread.items.length
    await runTurn(ctx, 0, [], startLength)
    expect(ctx.thread.items).toHaveLength(2)
    const first = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    const second = ctx.thread.items[1] as ReturnType<typeof createMessageItem>
    expect(first.from).toBe('user')
    expect(second.from).toBe('agent')
  })

  it('message hook fires before pruning', async () => {
    const hookFired: boolean[] = []
    const hooks: HookDefinition[] = [{
      name: 'msg', type: 'message', description: '',
      handler: () => { hookFired.push(true) },
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking.', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ hook: 'msg' }] }),
    ], hooks)
    await runTurn(ctx, 0)
    expect(hookFired).toHaveLength(1)
    expect(ctx.thread.items).toHaveLength(1)
  })
})

// ── createRuntime (integration) ───────────────────────────────────────────

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
  it('appends PROTOCOL_PROMPT to the system prompt', async () => {
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

  it('includes the user message in the request body', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('hello from user')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello from user' })
  })

  it('accumulates conversation history across multiple sends', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('first')
    await runtime.send('second')
    const lastBody = JSON.parse((fetchFn.mock.calls.at(-1)![1] as RequestInit).body as string)
    expect(lastBody.messages.length).toBeGreaterThan(1)
    expect(lastBody.messages.at(-1)?.content).toBe('second')
  })

  it('reset clears conversation so the next send starts fresh', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('first message')
    runtime.reset()
    await runtime.send('after reset')
    const lastBody = JSON.parse((fetchFn.mock.calls.at(-1)![1] as RequestInit).body as string)
    expect(lastBody.messages).toHaveLength(1)
    expect(lastBody.messages[0].content).toBe('after reset')
  })

  it('exposes the thread for external access', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('hello')
    expect(runtime.thread.items.length).toBeGreaterThan(0)
  })

  it('accepts an externally-provided thread and writes to it', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const thread = createThread()
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [], thread })
    await runtime.send('hello')
    expect(thread.items.length).toBeGreaterThan(0)
    expect(runtime.thread).toBe(thread)
  })

  it('includes thread input context in the LLM request', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const thread = createThread()
    // Simulate a site appending a context input before sending
    thread.append({
      id: 'test-ctx',
      toContext: () => '[Workspace Card — confirmed]\nWorkspace: acme',
    })
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [], thread })
    await runtime.send('hello')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    const hasContext = body.messages.some((m: ThreadMessage) =>
      m.content.includes('Workspace Card')
    )
    expect(hasContext).toBe(true)
  })

  it('throws when send is called while already in progress', async () => {
    let resolveFetch!: () => void
    const hangingFetch = new Promise<Response>(resolve => {
      resolveFetch = () => resolve({
        ok: true,
        json: async () => ({ text: JSON.stringify({ invocations: [] }) }),
      } as Response)
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => () => hangingFetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    const first = runtime.send('first')
    await expect(runtime.send('second')).rejects.toThrow('busy')
    resolveFetch()
    await first
  })

  it('respects maxContextDepth from config', async () => {
    const hooks: HookDefinition[] = [{
      name: 'ctx', type: 'context', description: '', handler: async () => 'data',
    }]
    const loopResponse = JSON.stringify({ invocations: [{ hook: 'ctx' }] })
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: loopResponse }),
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks, maxContextDepth: 1 })
    await expect(runtime.send('go')).rejects.toThrow('Max context depth')
  })

  it('thread has both user and agent messages after a successful send', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('ping')
    const items = runtime.thread.items as ReturnType<typeof createMessageItem>[]
    expect(items.some(i => i.from === 'user' && i.body === 'ping')).toBe(true)
    expect(items.some(i => i.from === 'agent')).toBe(true)
  })

  it('user message remains in thread even when the LLM throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await expect(runtime.send('help')).rejects.toThrow('network down')
    const items = runtime.thread.items as ReturnType<typeof createMessageItem>[]
    expect(items.some(i => i.from === 'user' && i.body === 'help')).toBe(true)
  })

  it('busy is released after an error so subsequent sends succeed', async () => {
    let fail = true
    const fetchFn = vi.fn().mockImplementation(async () => {
      if (fail) { fail = false; throw new Error('first call fails') }
      return { ok: true, json: async () => ({ text: JSON.stringify({ invocations: [] }) }) }
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await expect(runtime.send('first')).rejects.toThrow()
    await expect(runtime.send('second')).resolves.not.toThrow()
  })

  it('reset throws when called while a send is in progress', async () => {
    let resolveFetch!: () => void
    const hangingFetch = new Promise<Response>(resolve => {
      resolveFetch = () => resolve({
        ok: true,
        json: async () => ({ text: JSON.stringify({ invocations: [] }) }),
      } as Response)
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => () => hangingFetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    const first = runtime.send('first')
    expect(() => runtime.reset()).toThrow('in progress')
    resolveFetch()
    await first
  })

  it('usage starts at zero', () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    expect(runtime.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('usage accumulates from relay responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: JSON.stringify({ invocations: [] }), usage: { inputTokens: 100, outputTokens: 40 } }),
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('first')
    await runtime.send('second')
    expect(runtime.usage.inputTokens).toBe(200)
    expect(runtime.usage.outputTokens).toBe(80)
  })

  it('usage does not reset on runtime.reset()', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: JSON.stringify({ invocations: [] }), usage: { inputTokens: 50, outputTokens: 20 } }),
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => fetchFn as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    await runtime.send('hello')
    runtime.reset()
    expect(runtime.usage.inputTokens).toBe(50)
  })

  it('send with AbortSignal propagates signal to the relay fetch', async () => {
    const fetchFn = makeFetch({ text: JSON.stringify({ invocations: [] }) }).createFetch?.()
    // Use makeRelay but intercept the fetch to verify signal
    const capturedInits: RequestInit[] = []
    const spyFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedInits.push(init ?? {})
      return { ok: true, json: async () => ({ text: JSON.stringify({ invocations: [] }) }) }
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      createFetch: () => spyFetch as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [] })
    const controller = new AbortController()
    await runtime.send('hello', { signal: controller.signal })
    expect(capturedInits[0].signal).toBe(controller.signal)
  })

  it('restore-then-send: LLM sees restored history plus new message', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const fetchFn = relay.createFetch() as ReturnType<typeof vi.fn>
    const thread = createThread()
    thread.restore([
      createMessageItem('user', 'restored user message'),
      createMessageItem('agent', 'restored agent reply'),
    ])
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', hooks: [], thread })
    await runtime.send('new message')
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'restored user message' })
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'restored agent reply' })
    expect(body.messages[2]).toEqual({ role: 'user', content: 'new message' })
  })
})
