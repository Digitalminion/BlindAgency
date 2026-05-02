import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt.js'
import { PROTOCOL_PROMPT } from './runtime.js'
import type { HookDefinition } from './hooks.js'

const noop = () => {}

const msgHook: HookDefinition = {
  name: 'send-message',
  type: 'message',
  description: 'Send a text reply to the user.',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: noop,
}

const ctxHook: HookDefinition = {
  name: 'get-pricing',
  type: 'context',
  description: 'Fetch current pricing tiers.',
  handler: noop,
}

const uiHook: HookDefinition = {
  name: 'update-visualization',
  type: 'ui',
  description: 'Update the page visualization.',
  params: { type: 'object', properties: { data: { type: 'object' } } },
  handler: noop,
}

describe('buildSystemPrompt', () => {
  it('includes the base prompt', () => {
    const result = buildSystemPrompt({ base: 'You are a helpful assistant.', hooks: [] })
    expect(result).toContain('You are a helpful assistant.')
  })

  it('does not include the protocol section — runtime adds it', () => {
    const result = buildSystemPrompt({ base: '', hooks: [] })
    expect(result).not.toContain('"invocations"')
  })

  it('groups hooks by type with correct section headers', () => {
    const result = buildSystemPrompt({ base: '', hooks: [msgHook, ctxHook, uiHook] })
    expect(result).toContain('Message Hooks')
    expect(result).toContain('Context Hooks')
    expect(result).toContain('UI Hooks')
  })

  it('includes hook names and descriptions', () => {
    const result = buildSystemPrompt({ base: '', hooks: [msgHook] })
    expect(result).toContain('send-message')
    expect(result).toContain('Send a text reply to the user.')
  })

  it('includes serialized params schema when provided', () => {
    const result = buildSystemPrompt({ base: '', hooks: [msgHook] })
    expect(result).toContain('"required"')
  })

  it('omits type sections when no hooks of that type exist', () => {
    const result = buildSystemPrompt({ base: '', hooks: [msgHook] })
    expect(result).not.toContain('Context Hooks')
    expect(result).not.toContain('UI Hooks')
  })

  it('context hook section explains re-invocation', () => {
    const result = buildSystemPrompt({ base: '', hooks: [ctxHook] })
    expect(result).toContain('re-invoke')
  })
})

describe('PROTOCOL_PROMPT', () => {
  it('contains the invocations structure', () => {
    expect(PROTOCOL_PROMPT).toContain('"invocations"')
  })

  it('requires valid JSON responses', () => {
    expect(PROTOCOL_PROMPT).toContain('valid JSON')
  })

  it('describes all three hook types in order', () => {
    const ui = PROTOCOL_PROMPT.indexOf('UI hooks')
    const ctx = PROTOCOL_PROMPT.indexOf('context hooks')
    const msg = PROTOCOL_PROMPT.indexOf('Message hooks')
    expect(ui).toBeLessThan(ctx)
    expect(ctx).toBeLessThan(msg)
  })
})
