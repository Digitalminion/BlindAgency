import { describe, expect, it } from 'vitest'
import { createHookRegistry } from './hooks.js'
import type { HookDefinition } from './hooks.js'

const makeHook = (name: string, type: HookDefinition['type']): HookDefinition => ({
  name,
  type,
  description: `${name} hook`,
  handler: () => {},
})

describe('createHookRegistry', () => {
  it('initializes with pre-supplied hooks', () => {
    const h = makeHook('send-message', 'message')
    const reg = createHookRegistry([h])
    expect(reg.get('send-message')).toBe(h)
  })

  it('register overwrites existing hook with same name', () => {
    const h1 = makeHook('send-message', 'message')
    const h2 = { ...makeHook('send-message', 'message'), description: 'updated' }
    const reg = createHookRegistry([h1])
    reg.register(h2)
    expect(reg.get('send-message')?.description).toBe('updated')
  })

  it('get returns undefined for unknown hook', () => {
    const reg = createHookRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('all() returns every registered hook', () => {
    const hooks = [makeHook('a', 'message'), makeHook('b', 'context'), makeHook('c', 'ui')]
    const reg = createHookRegistry(hooks)
    expect(reg.all()).toHaveLength(3)
  })

  it('byType filters correctly', () => {
    const hooks = [
      makeHook('msg', 'message'),
      makeHook('ctx', 'context'),
      makeHook('ctx2', 'context'),
      makeHook('ui', 'ui'),
    ]
    const reg = createHookRegistry(hooks)
    expect(reg.byType('context')).toHaveLength(2)
    expect(reg.byType('message')).toHaveLength(1)
    expect(reg.byType('ui')).toHaveLength(1)
  })
})
