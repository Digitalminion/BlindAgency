import { describe, expect, it, vi } from 'vitest'
import { parseAgentResponse, runTurn, createRuntime, PROTOCOL_PROMPT } from './runtime.js'
import { createActionRegistry } from './actions.js'
import { createThread, createMessageItem, isMessageItem } from './thread.js'
import type { ActionDefinition } from './actions.js'
import type { TurnContext } from './runtime.js'
import type { MessageItem, ThreadItem } from './thread.js'
import type { Relay } from './client.js'

// ── parseAgentResponse ────────────────────────────────────────────────────

describe('parseAgentResponse', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({ invocations: [{ action: 'send-message', params: { text: 'hi' } }] })
    const res = parseAgentResponse(raw)
    expect(res.invocations).toHaveLength(1)
    expect(res.invocations[0].action).toBe('send-message')
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
      invocations: [{ action: 'a', params: { n: 1 }, extra: 'ignored' }],
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

// ── runTurn ───────────────────────────────────────────────────────────────

function makeCtx(
  responses: string[],
  actions: ActionDefinition[] = [],
  maxDepth = 5,
): TurnContext & { thread: ReturnType<typeof createThread> } {
  let call = 0
  const thread = createThread()
  return {
    invoke: vi.fn().mockImplementation(async () => ({ text: responses[call++] ?? '{"invocations":[]}' })) as unknown as TurnContext['invoke'],
    registry: createActionRegistry(actions),
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
      invoke: vi.fn().mockResolvedValue({ text: 'not valid json' }) as unknown as TurnContext['invoke'],
      registry: createActionRegistry(),
      thread,
      maxDepth: 5,
    }
    await expect(runTurn(ctx, 0)).rejects.toThrow()
    expect(thread.items).toHaveLength(1)
    expect((thread.items[0] as ReturnType<typeof createMessageItem>).from).toBe('user')
  })

  it('silently skips unknown actions', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'ghost' }] })])
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('calls a ui action with its params', async () => {
    const called: unknown[] = []
    const actions: ActionDefinition[] = [{
      name: 'highlight', type: 'ui', description: '',
      handler: (p) => { called.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'highlight', params: { id: 'x' } }] })], actions)
    await runTurn(ctx, 0)
    expect(called).toEqual([{ id: 'x' }])
  })

  it('calls multiple ui actions in order', async () => {
    const order: string[] = []
    const actions: ActionDefinition[] = [
      { name: 'a', type: 'ui', description: '', handler: () => { order.push('a') } },
      { name: 'b', type: 'ui', description: '', handler: () => { order.push('b') } },
    ]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'a' }, { action: 'b' }] })], actions)
    await runTurn(ctx, 0)
    expect(order).toEqual(['a', 'b'])
  })

  it('calls a message action with its params', async () => {
    const received: unknown[] = []
    const actions: ActionDefinition[] = [{
      name: 'reply', type: 'message', description: '',
      handler: (p) => { received.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'reply', params: { text: 'done' } }] })], actions)
    await runTurn(ctx, 0)
    expect(received).toEqual([{ text: 'done' }])
  })

  it('passes additions to ctx.invoke on re-invocation', async () => {
    const actions: ActionDefinition[] = [
      { name: 'fetch-data', type: 'context', description: '', handler: async () => 'some data' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'fetch-data' }] }),
      JSON.stringify({ invocations: [{ action: 'reply', params: { text: 'done' } }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.invoke)).toHaveBeenCalledTimes(2)
    const secondCallAdditions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[]
    expect(secondCallAdditions?.some(a => a.includes('some data'))).toBe(true)
  })

  it('context injection does not write to the thread', async () => {
    const actions: ActionDefinition[] = [
      { name: 'fetch-data', type: 'context', description: '', handler: async () => 'ephemeral result' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'fetch-data' }] }),
      JSON.stringify({ invocations: [{ action: 'reply', params: { text: 'done' } }] }),
    ], actions)
    await runTurn(ctx, 0)
    const hasContextItem = ctx.thread.items.some(i =>
      (i as ReturnType<typeof createMessageItem>).body?.includes('ephemeral result')
    )
    expect(hasContextItem).toBe(false)
  })

  it('joins multiple context results and passes them as one addition string', async () => {
    const actions: ActionDefinition[] = [
      { name: 'ctx-a', type: 'context', description: '', handler: async () => 'result A' },
      { name: 'ctx-b', type: 'context', description: '', handler: async () => 'result B' },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ctx-a' }, { action: 'ctx-b' }] }),
      JSON.stringify({ invocations: [{ action: 'reply' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const additions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[]
    const contextAddition = additions?.find(a => a.includes('result A') && a.includes('result B'))
    expect(contextAddition).toBeDefined()
  })

  it('does not inject context when the handler returns nothing', async () => {
    const actions: ActionDefinition[] = [
      { name: 'side-effect', type: 'context', description: '', handler: async () => { return undefined as unknown as string } },
      { name: 'reply', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'side-effect' }] }),
      JSON.stringify({ invocations: [{ action: 'reply' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const secondCallAdditions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[] | undefined
    expect(secondCallAdditions?.length ?? 0).toBe(0)
  })

  it('does not inject context when a non-string value is returned', async () => {
    const actions: ActionDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 42 as unknown as string },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ctx' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const additions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[] | undefined
    expect(additions?.length ?? 0).toBe(0)
  })

  it('runs ui actions before message hooks', async () => {
    const order: string[] = []
    const actions: ActionDefinition[] = [
      { name: 'ui-action', type: 'ui', description: '', handler: () => { order.push('ui') } },
      { name: 'msg-action', type: 'message', description: '', handler: () => { order.push('msg') } },
    ]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'msg-action' }, { action: 'ui-action' }] })], actions)
    await runTurn(ctx, 0)
    expect(order).toEqual(['ui', 'msg'])
  })

  it('runs ui actions even when context actions are present', async () => {
    const uiCalled: boolean[] = []
    const actions: ActionDefinition[] = [
      { name: 'ui', type: 'ui', description: '', handler: () => { uiCalled.push(true) } },
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ui' }, { action: 'ctx' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(uiCalled).toHaveLength(1)
  })

  it('suppresses message actions when context actions are present', async () => {
    const msgCalled: boolean[] = []
    const actions: ActionDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => { msgCalled.push(true) } },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ctx' }, { action: 'msg' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(msgCalled).toHaveLength(1)
  })

  it('passes empty object to action when params is absent', async () => {
    const received: unknown[] = []
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: (p) => { received.push(p) },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'msg' }] })], actions)
    await runTurn(ctx, 0)
    expect(received).toEqual([{}])
  })

  it('throws when max context depth is exceeded', async () => {
    const actions: ActionDefinition[] = [
      { name: 'loop', type: 'context', description: '', handler: async () => 'data' },
    ]
    const ctx = makeCtx(Array(10).fill(JSON.stringify({ invocations: [{ action: 'loop' }] })), actions, 2)
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
  })

  it('allows a turn at maxDepth and throws one step beyond', async () => {
    const actions: ActionDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ctx' }] }),
      JSON.stringify({ invocations: [{ action: 'ctx' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions, 1)
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
    expect(vi.mocked(ctx.invoke)).toHaveBeenCalledTimes(2)
  })

  it('propagates parseAgentResponse errors', async () => {
    const ctx = makeCtx(['not json at all'])
    await expect(runTurn(ctx, 0)).rejects.toThrow('not valid JSON')
  })

  it('propagates a ctx.invoke rejection', async () => {
    const ctx: TurnContext = {
      invoke: vi.fn().mockRejectedValue(new Error('relay down')) as unknown as TurnContext['invoke'],
      registry: createActionRegistry(),
      thread: createThread(),
      maxDepth: 5,
    }
    await expect(runTurn(ctx, 0)).rejects.toThrow('relay down')
  })

  it('propagates a ui action rejection', async () => {
    const actions: ActionDefinition[] = [{
      name: 'bad-ui', type: 'ui', description: '',
      handler: async () => { throw new Error('ui exploded') },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'bad-ui' }] })], actions)
    await expect(runTurn(ctx, 0)).rejects.toThrow('ui exploded')
  })

  it('propagates a context action rejection', async () => {
    const actions: ActionDefinition[] = [{
      name: 'bad-ctx', type: 'context', description: '',
      handler: async () => { throw new Error('ctx exploded') },
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'bad-ctx' }] })], actions)
    await expect(runTurn(ctx, 0)).rejects.toThrow('ctx exploded')
  })

  // ── usage tracking ─────────────────────────────────────────────────────────

  it('attaches usage from ctx.invoke to the agent thread item', async () => {
    const thread = createThread()
    const ctx: TurnContext = {
      invoke: vi.fn().mockResolvedValue({
        text: JSON.stringify({ invocations: [] }),
        usage: { inputTokens: 200, outputTokens: 80 },
      }) as unknown as TurnContext['invoke'],
      registry: createActionRegistry(),
      thread,
      maxDepth: 5,
    }
    await runTurn(ctx, 0)
    const item = thread.items[0] as ReturnType<typeof createMessageItem>
    expect(item.usage).toEqual({ inputTokens: 200, outputTokens: 80 })
  })

  it('usage is undefined on the thread item when ctx.invoke returns no usage', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [] })])
    await runTurn(ctx, 0)
    const item = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    expect(item.usage).toBeUndefined()
  })

  it('forwards the AbortSignal to ctx.invoke', async () => {
    const ctx = makeCtx([JSON.stringify({ invocations: [] })])
    const signal = new AbortController().signal
    await runTurn(ctx, 0, [], ctx.thread.items.length, signal)
    expect(vi.mocked(ctx.invoke).mock.calls[0][1]).toBe(signal)
  })

  it('passes the signal through on recursive re-invocation', async () => {
    const actions: ActionDefinition[] = [
      { name: 'ctx', type: 'context', description: '', handler: async () => 'data' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ invocations: [{ action: 'ctx' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    const signal = new AbortController().signal
    await runTurn(ctx, 0, [], ctx.thread.items.length, signal)
    for (const call of vi.mocked(ctx.invoke).mock.calls) {
      expect(call[1]).toBe(signal)
    }
  })

  // ── action param validation ──────────────────────────────────────────────────

  it('throws when a required message action param is missing', async () => {
    const actions: ActionDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: () => {},
    }]
    // LLM omits the required "text" param
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'reply', params: {} }] })], actions)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"text" is missing')
  })

  it('throws when a required context action param is missing', async () => {
    const actions: ActionDefinition[] = [
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
      JSON.stringify({ invocations: [{ action: 'fetch-data', params: {} }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"id" is missing')
  })

  it('throws when a required ui action param is missing', async () => {
    const actions: ActionDefinition[] = [{
      name: 'highlight',
      type: 'ui',
      description: '',
      params: { type: 'object', properties: { featureId: { type: 'string' } }, required: ['featureId'] },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'highlight', params: {} }] })], actions)
    await expect(runTurn(ctx, 0)).rejects.toThrow('"featureId" is missing')
  })

  it('does not throw when all required params are present', async () => {
    const actions: ActionDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'reply', params: { text: 'hi' } }] })], actions)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('does not throw when action has no required fields declared', async () => {
    const actions: ActionDefinition[] = [{
      name: 'reply',
      type: 'message',
      description: '',
      params: { type: 'object', properties: { text: { type: 'string' } } },
      handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'reply', params: {} }] })], actions)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  it('does not throw when action has no params schema at all', async () => {
    const actions: ActionDefinition[] = [{
      name: 'reply', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([JSON.stringify({ invocations: [{ action: 'reply' }] })], actions)
    await expect(runTurn(ctx, 0)).resolves.not.toThrow()
  })

  // ── reasoning ──────────────────────────────────────────────────────────────

  it('reasoning alone triggers a re-invocation', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Let me think...', invocations: [] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.invoke)).toHaveBeenCalledTimes(2)
  })

  it('reasoning text is injected as [Reasoning] addition on re-invocation', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'I need pricing data.', invocations: [] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const secondCallAdditions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[]
    expect(secondCallAdditions?.some(a => a.includes('[Reasoning]') && a.includes('I need pricing data.'))).toBe(true)
  })

  it('reasoning + context hook — both are injected together before re-invocation', async () => {
    const actions: ActionDefinition[] = [
      { name: 'fetch-pricing', type: 'context', description: '', handler: async () => '$99/mo' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'I need the pricing model.', invocations: [{ action: 'fetch-pricing' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const secondCallAdditions = vi.mocked(ctx.invoke).mock.calls[1][0] as string[]
    const hasReasoning = secondCallAdditions?.some(a => a.includes('[Reasoning]'))
    const hasContext = secondCallAdditions?.some(a => a.includes('$99/mo'))
    expect(hasReasoning).toBe(true)
    expect(hasContext).toBe(true)
  })

  it('reasoning + context hook — single re-invocation, not two', async () => {
    const actions: ActionDefinition[] = [
      { name: 'fetch-pricing', type: 'context', description: '', handler: async () => '$99/mo' },
      { name: 'msg', type: 'message', description: '', handler: () => {} },
    ]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Need pricing.', invocations: [{ action: 'fetch-pricing' }] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(vi.mocked(ctx.invoke)).toHaveBeenCalledTimes(2)
  })

  it('reasoning accumulates across multiple turns', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'First thought.', invocations: [] }),
      JSON.stringify({ reasoning: 'Second thought.', invocations: [] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    const thirdCallAdditions = vi.mocked(ctx.invoke).mock.calls[2][0] as string[]
    const contents = thirdCallAdditions?.join('\n')
    expect(contents).toContain('First thought.')
    expect(contents).toContain('Second thought.')
  })

  it('reasoning counts against maxDepth', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx(
      Array(10).fill(JSON.stringify({ reasoning: 'thinking...', invocations: [] })),
      actions,
      2,
    )
    await expect(runTurn(ctx, 0)).rejects.toThrow('Max context depth')
  })

  it('reasoning is not injected as a separate thread item — only raw LLM responses are written', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'private thought', invocations: [] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
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
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'First thought.', invocations: [] }),
      JSON.stringify({ reasoning: 'Second thought.', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(1)
    const final = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    expect(final.body).toContain('reasoningComplete')
  })

  it('thread is unchanged when reasoningComplete is absent', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking...', invocations: [] }),
      JSON.stringify({ invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(2)
  })

  it('reasoningComplete on a single-turn response is a no-op — final item is kept', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoningComplete: true, invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(ctx.thread.items).toHaveLength(1)
  })

  it('pruning preserves items that existed before runTurn was called', async () => {
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '', handler: () => {},
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking...', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ action: 'msg' }] }),
    ], actions)
    ctx.thread.append(createMessageItem('user', 'hello'))
    const startLength = ctx.thread.items.length
    await runTurn(ctx, 0, [], startLength)
    expect(ctx.thread.items).toHaveLength(2)
    const first = ctx.thread.items[0] as ReturnType<typeof createMessageItem>
    const second = ctx.thread.items[1] as ReturnType<typeof createMessageItem>
    expect(first.from).toBe('user')
    expect(second.from).toBe('agent')
  })

  it('message action fires before pruning', async () => {
    const hookFired: boolean[] = []
    const actions: ActionDefinition[] = [{
      name: 'msg', type: 'message', description: '',
      handler: () => { hookFired.push(true) },
    }]
    const ctx = makeCtx([
      JSON.stringify({ reasoning: 'Thinking.', invocations: [] }),
      JSON.stringify({ reasoningComplete: true, invocations: [{ action: 'msg' }] }),
    ], actions)
    await runTurn(ctx, 0)
    expect(hookFired).toHaveLength(1)
    expect(ctx.thread.items).toHaveLength(1)
  })
})

// ── createRuntime (integration) ───────────────────────────────────────────

function makeRelay(responseText: string): Relay {
  return {
    setKey: vi.fn(),
    hasKey: () => true,
    clearKey: vi.fn(),
    send: vi.fn().mockResolvedValue({ text: responseText }),
    createFetch: () => vi.fn() as unknown as typeof fetch,
  }
}

const MODEL = 'test-model'

describe('createRuntime', () => {
  it('appends PROTOCOL_PROMPT to the system prompt', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: 'You are helpful.', actions: [] })
    await runtime.send('hi')
    const system = vi.mocked(relay.send).mock.calls[0][1]
    expect(system).toContain('You are helpful.')
    expect(system).toContain(PROTOCOL_PROMPT)
  })

  it('uses PROTOCOL_PROMPT alone when no system prompt is provided', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('hi')
    const system = vi.mocked(relay.send).mock.calls[0][1]
    expect(system).toBe(PROTOCOL_PROMPT)
  })

  it('includes the user message in the items passed to relay.send()', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('hello from user')
    const items = vi.mocked(relay.send).mock.calls[0][2]
    const userItem = items.find(i => isMessageItem(i) && (i as MessageItem).from === 'user') as MessageItem
    expect(userItem?.body).toBe('hello from user')
  })

  it('accumulates conversation history across multiple sends', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('first')
    await runtime.send('second')
    const items = vi.mocked(relay.send).mock.calls.at(-1)![2]
    const messageItems = items.filter(i => isMessageItem(i)) as MessageItem[]
    expect(messageItems.length).toBeGreaterThan(1)
    expect(messageItems.at(-1)?.body).toBe('second')
  })

  it('reset clears conversation so the next send starts fresh', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('first message')
    runtime.reset()
    await runtime.send('after reset')
    const items = vi.mocked(relay.send).mock.calls.at(-1)![2]
    const messageItems = items.filter(i => isMessageItem(i)) as MessageItem[]
    expect(messageItems).toHaveLength(1)
    expect(messageItems[0].body).toBe('after reset')
  })

  it('exposes the thread for external access', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('hello')
    expect(runtime.thread.items.length).toBeGreaterThan(0)
  })

  it('accepts an externally-provided thread and writes to it', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const thread = createThread()
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [], thread })
    await runtime.send('hello')
    expect(thread.items.length).toBeGreaterThan(0)
    expect(runtime.thread).toBe(thread)
  })

  it('includes thread context items in the items passed to relay.send()', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const thread = createThread()
    const contextItem: ThreadItem = { id: 'test-ctx', toContext: () => '[Workspace Card — confirmed]\nWorkspace: acme' }
    thread.append(contextItem)
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [], thread })
    await runtime.send('hello')
    const items = vi.mocked(relay.send).mock.calls[0][2]
    expect(items.some(i => i.id === 'test-ctx')).toBe(true)
  })

  it('throws when send is called while already in progress', async () => {
    let resolveSend!: () => void
    const hangingSend = new Promise<{ text: string }>(resolve => {
      resolveSend = () => resolve({ text: JSON.stringify({ invocations: [] }) })
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockReturnValue(hangingSend),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    const first = runtime.send('first')
    await expect(runtime.send('second')).rejects.toThrow('busy')
    resolveSend()
    await first
  })

  it('respects maxContextDepth from config', async () => {
    const actions: ActionDefinition[] = [{
      name: 'ctx', type: 'context', description: '', handler: async () => 'data',
    }]
    const loopResponse = JSON.stringify({ invocations: [{ action: 'ctx' }] })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockResolvedValue({ text: loopResponse }),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions, maxContextDepth: 1 })
    await expect(runtime.send('go')).rejects.toThrow('Max context depth')
  })

  it('thread has both user and agent messages after a successful send', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('ping')
    const items = runtime.thread.items as ReturnType<typeof createMessageItem>[]
    expect(items.some(i => i.from === 'user' && i.body === 'ping')).toBe(true)
    expect(items.some(i => i.from === 'agent')).toBe(true)
  })

  it('user message remains in thread even when the LLM throws', async () => {
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockRejectedValue(new Error('network down')),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await expect(runtime.send('help')).rejects.toThrow('network down')
    const items = runtime.thread.items as ReturnType<typeof createMessageItem>[]
    expect(items.some(i => i.from === 'user' && i.body === 'help')).toBe(true)
  })

  it('busy is released after an error so subsequent sends succeed', async () => {
    let fail = true
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockImplementation(async () => {
        if (fail) { fail = false; throw new Error('first call fails') }
        return { text: JSON.stringify({ invocations: [] }) }
      }),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await expect(runtime.send('first')).rejects.toThrow()
    await expect(runtime.send('second')).resolves.not.toThrow()
  })

  it('reset throws when called while a send is in progress', async () => {
    let resolveSend!: () => void
    const hangingSend = new Promise<{ text: string }>(resolve => {
      resolveSend = () => resolve({ text: JSON.stringify({ invocations: [] }) })
    })
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockReturnValue(hangingSend),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    const first = runtime.send('first')
    expect(() => runtime.reset()).toThrow('in progress')
    resolveSend()
    await first
  })

  it('usage starts at zero', () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    expect(runtime.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('usage accumulates from relay responses', async () => {
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockResolvedValue({ text: JSON.stringify({ invocations: [] }), usage: { inputTokens: 100, outputTokens: 40 } }),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('first')
    await runtime.send('second')
    expect(runtime.usage.inputTokens).toBe(200)
    expect(runtime.usage.outputTokens).toBe(80)
  })

  it('usage does not reset on runtime.reset()', async () => {
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockResolvedValue({ text: JSON.stringify({ invocations: [] }), usage: { inputTokens: 50, outputTokens: 20 } }),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    await runtime.send('hello')
    runtime.reset()
    expect(runtime.usage.inputTokens).toBe(50)
  })

  it('send with AbortSignal propagates signal to relay.send()', async () => {
    const relay: Relay = {
      setKey: vi.fn(), hasKey: () => true, clearKey: vi.fn(),
      send: vi.fn().mockResolvedValue({ text: JSON.stringify({ invocations: [] }) }),
      createFetch: () => vi.fn() as unknown as typeof fetch,
    }
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [] })
    const controller = new AbortController()
    await runtime.send('hello', { signal: controller.signal })
    const signal = vi.mocked(relay.send).mock.calls[0][4]
    expect(signal).toBe(controller.signal)
  })

  it('restore-then-send: relay.send() receives restored history plus new message', async () => {
    const relay = makeRelay(JSON.stringify({ invocations: [] }))
    const thread = createThread()
    thread.restore([
      createMessageItem('user', 'restored user message'),
      createMessageItem('agent', 'restored agent reply'),
    ])
    const runtime = createRuntime({ relay, model: MODEL, systemPrompt: '', actions: [], thread })
    await runtime.send('new message')
    const items = vi.mocked(relay.send).mock.calls[0][2]
    const messageItems = items.filter(i => isMessageItem(i)) as MessageItem[]
    expect(messageItems[0]).toMatchObject({ from: 'user', body: 'restored user message' })
    expect(messageItems[1]).toMatchObject({ from: 'agent', body: 'restored agent reply' })
    expect(messageItems[2]).toMatchObject({ from: 'user', body: 'new message' })
  })
})
