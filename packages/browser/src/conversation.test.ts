import { describe, expect, it } from 'vitest'
import { createConversationManager } from './conversation.js'

describe('createConversationManager', () => {
  it('starts empty', () => {
    const m = createConversationManager()
    expect(m.messages()).toEqual([])
  })

  it('appends messages in order', () => {
    const m = createConversationManager()
    m.append({ role: 'user', content: 'hello' })
    m.append({ role: 'assistant', content: 'hi' })
    expect(m.messages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('returns a copy from messages()', () => {
    const m = createConversationManager()
    m.append({ role: 'user', content: 'hi' })
    const first = m.messages()
    m.append({ role: 'assistant', content: 'hello' })
    expect(first).toHaveLength(1)
  })

  it('injectContext appends a user message with [Context] prefix', () => {
    const m = createConversationManager()
    m.append({ role: 'user', content: 'tell me about pricing' })
    m.injectContext('Pricing: $99/mo')
    const msgs = m.messages()
    expect(msgs[1]).toEqual({ role: 'user', content: '[Context]\nPricing: $99/mo' })
  })

  it('clear resets history', () => {
    const m = createConversationManager()
    m.append({ role: 'user', content: 'hi' })
    m.clear()
    expect(m.messages()).toEqual([])
  })
})
