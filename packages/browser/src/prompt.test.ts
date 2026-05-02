import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompt.js'
import { PROTOCOL_PROMPT } from './runtime.js'
import type { ActionDefinition } from './actions.js'

const noop = () => {}

const msgAction: ActionDefinition = {
  name: 'send-message',
  type: 'message',
  description: 'Send a text reply to the user.',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: noop,
}

const ctxAction: ActionDefinition = {
  name: 'get-pricing',
  type: 'context',
  description: 'Fetch current pricing tiers.',
  handler: noop,
}

const uiAction: ActionDefinition = {
  name: 'update-visualization',
  type: 'ui',
  description: 'Update the page visualization.',
  params: { type: 'object', properties: { data: { type: 'object' } } },
  handler: noop,
}

describe('buildSystemPrompt', () => {
  it('includes the base prompt', () => {
    const result = buildSystemPrompt({ base: 'You are a helpful assistant.', actions: [] })
    expect(result).toContain('You are a helpful assistant.')
  })

  it('does not include the protocol section — runtime adds it', () => {
    const result = buildSystemPrompt({ base: '', actions: [] })
    expect(result).not.toContain('"invocations"')
  })

  it('groups actions by type with correct section headers', () => {
    const result = buildSystemPrompt({ base: '', actions: [msgAction, ctxAction, uiAction] })
    expect(result).toContain('Message Actions')
    expect(result).toContain('Context Actions')
    expect(result).toContain('UI Actions')
  })

  it('includes action names and descriptions', () => {
    const result = buildSystemPrompt({ base: '', actions: [msgAction] })
    expect(result).toContain('send-message')
    expect(result).toContain('Send a text reply to the user.')
  })

  it('includes serialized params schema when provided', () => {
    const result = buildSystemPrompt({ base: '', actions: [msgAction] })
    expect(result).toContain('"required"')
  })

  it('omits type sections when no actions of that type exist', () => {
    const result = buildSystemPrompt({ base: '', actions: [msgAction] })
    expect(result).not.toContain('Context Actions')
    expect(result).not.toContain('UI Actions')
  })

  it('context action section explains re-invocation', () => {
    const result = buildSystemPrompt({ base: '', actions: [ctxAction] })
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

  it('describes all three action types in order', () => {
    const ui = PROTOCOL_PROMPT.indexOf('UI actions')
    const ctx = PROTOCOL_PROMPT.indexOf('context actions')
    const msg = PROTOCOL_PROMPT.indexOf('Message actions')
    expect(ui).toBeLessThan(ctx)
    expect(ctx).toBeLessThan(msg)
  })
})
