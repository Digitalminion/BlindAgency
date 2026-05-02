import { describe, expect, it } from 'vitest'
import { createThread, createMessageItem, threadToLlmMessages, isMessageItem } from './thread.js'
import type { ThreadItem } from './thread.js'

// ── createThread ──────────────────────────────────────────────────────────

describe('createThread', () => {
  it('starts empty', () => {
    expect(createThread().items).toHaveLength(0)
  })

  it('append adds items in order', () => {
    const thread = createThread()
    const a: ThreadItem = { id: 'a', toContext: () => 'ctx-a' }
    const b: ThreadItem = { id: 'b', toContext: () => 'ctx-b' }
    thread.append(a)
    thread.append(b)
    expect(thread.items).toEqual([a, b])
  })

  it('items is immutable — appending returns a new array reference', () => {
    const thread = createThread()
    const before = thread.items
    thread.append({ id: 'x', toContext: () => null })
    expect(thread.items).not.toBe(before)
  })

  it('restore replaces all items', () => {
    const thread = createThread()
    thread.append({ id: 'old', toContext: () => null })
    const newItems: ThreadItem[] = [{ id: 'new', toContext: () => 'ctx' }]
    thread.restore(newItems)
    expect(thread.items).toHaveLength(1)
    expect(thread.items[0].id).toBe('new')
  })

  it('clear empties the thread', () => {
    const thread = createThread()
    thread.append({ id: 'x', toContext: () => null })
    thread.clear()
    expect(thread.items).toHaveLength(0)
  })

  it('activeContext returns non-null toContext results in order', () => {
    const thread = createThread()
    thread.append({ id: 'a', toContext: () => 'first' })
    thread.append({ id: 'b', toContext: () => null })
    thread.append({ id: 'c', toContext: () => 'third' })
    expect(thread.activeContext()).toEqual(['first', 'third'])
  })

  it('activeContext returns empty array when all items return null', () => {
    const thread = createThread()
    thread.append({ id: 'a', toContext: () => null })
    expect(thread.activeContext()).toEqual([])
  })

  it('restore makes a defensive copy — mutating the passed array does not affect thread items', () => {
    const thread = createThread()
    const arr: ThreadItem[] = [{ id: 'a', toContext: () => 'ctx-a' }]
    thread.restore(arr)
    arr.push({ id: 'b', toContext: () => 'ctx-b' })
    expect(thread.items).toHaveLength(1)
    expect(thread.items[0].id).toBe('a')
  })

  it('restore with an empty array leaves the thread empty', () => {
    const thread = createThread()
    thread.append({ id: 'x', toContext: () => null })
    thread.restore([])
    expect(thread.items).toHaveLength(0)
  })

  it('append after restore accumulates items in order', () => {
    const thread = createThread()
    const restored: ThreadItem = { id: 'old', toContext: () => null }
    thread.restore([restored])
    const fresh: ThreadItem = { id: 'new', toContext: () => null }
    thread.append(fresh)
    expect(thread.items).toHaveLength(2)
    expect(thread.items[0].id).toBe('old')
    expect(thread.items[1].id).toBe('new')
  })

  it('two threads are independent — appending to one does not affect the other', () => {
    const a = createThread()
    const b = createThread()
    a.append({ id: 'a1', toContext: () => null })
    expect(b.items).toHaveLength(0)
  })
})

// ── createMessageItem ─────────────────────────────────────────────────────

describe('createMessageItem', () => {
  it('creates a user message item', () => {
    const item = createMessageItem('user', 'hello')
    expect(item.kind).toBe('message')
    expect(item.from).toBe('user')
    expect(item.body).toBe('hello')
  })

  it('creates an agent message item', () => {
    const item = createMessageItem('agent', 'reply')
    expect(item.from).toBe('agent')
  })

  it('toContext returns null — messages are not context injections', () => {
    expect(createMessageItem('user', 'hi').toContext()).toBeNull()
    expect(createMessageItem('agent', 'hi').toContext()).toBeNull()
  })

  it('assigns a unique id to each item', () => {
    const a = createMessageItem('user', 'hi')
    const b = createMessageItem('user', 'hi')
    expect(a.id).not.toBe(b.id)
  })
})

// ── isMessageItem ─────────────────────────────────────────────────────────

describe('isMessageItem', () => {
  it('returns true for items created by createMessageItem', () => {
    expect(isMessageItem(createMessageItem('user', 'hi'))).toBe(true)
    expect(isMessageItem(createMessageItem('agent', 'reply'))).toBe(true)
  })

  it('returns false for plain ThreadItems without a kind field', () => {
    const item: ThreadItem = { id: 'x', toContext: () => null }
    expect(isMessageItem(item)).toBe(false)
  })

  it('returns false for items with a different kind', () => {
    const item = { id: 'y', kind: 'input', toContext: () => null } as unknown as ThreadItem
    expect(isMessageItem(item)).toBe(false)
  })
})

// ── threadToLlmMessages ───────────────────────────────────────────────────

describe('threadToLlmMessages', () => {
  it('converts user MessageItems to role:user messages', () => {
    const items = [createMessageItem('user', 'hello')]
    expect(threadToLlmMessages(items)).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('converts agent MessageItems to role:assistant messages', () => {
    const items = [createMessageItem('agent', 'reply')]
    expect(threadToLlmMessages(items)).toEqual([{ role: 'assistant', content: 'reply' }])
  })

  it('injects non-null toContext results as role:user messages', () => {
    const items: ThreadItem[] = [{ id: 'x', toContext: () => '[Card — saved]\nsome context' }]
    expect(threadToLlmMessages(items)).toEqual([{ role: 'user', content: '[Card — saved]\nsome context' }])
  })

  it('skips items where toContext returns null and kind is not message', () => {
    const items: ThreadItem[] = [{ id: 'x', toContext: () => null }]
    expect(threadToLlmMessages(items)).toHaveLength(0)
  })

  it('preserves item order across mixed types', () => {
    const items: ThreadItem[] = [
      createMessageItem('user', 'hi'),
      { id: 'ctx', toContext: () => '[Card — confirmed]\nworkspace: acme' },
      createMessageItem('agent', 'got it'),
    ]
    const messages = threadToLlmMessages(items)
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: '[Card — confirmed]\nworkspace: acme' },
      { role: 'assistant', content: 'got it' },
    ])
  })

  it('returns empty array for empty items', () => {
    expect(threadToLlmMessages([])).toEqual([])
  })
})
