import { describe, expect, it } from 'vitest'
import { createActionRegistry } from './actions.js'
import type { ActionDefinition } from './actions.js'

const makeAction = (name: string, type: ActionDefinition['type']): ActionDefinition => ({
  name,
  type,
  description: `${name} action`,
  handler: () => {},
})

describe('createActionRegistry', () => {
  it('initializes with pre-supplied actions', () => {
    const a = makeAction('send-message', 'message')
    const reg = createActionRegistry([a])
    expect(reg.get('send-message')).toBe(a)
  })

  it('register overwrites existing action with same name', () => {
    const a1 = makeAction('send-message', 'message')
    const a2 = { ...makeAction('send-message', 'message'), description: 'updated' }
    const reg = createActionRegistry([a1])
    reg.register(a2)
    expect(reg.get('send-message')?.description).toBe('updated')
  })

  it('get returns undefined for unknown action', () => {
    const reg = createActionRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('all() returns every registered action', () => {
    const actions = [makeAction('a', 'message'), makeAction('b', 'context'), makeAction('c', 'ui')]
    const reg = createActionRegistry(actions)
    expect(reg.all()).toHaveLength(3)
  })

  it('byType filters correctly', () => {
    const actions = [
      makeAction('msg', 'message'),
      makeAction('ctx', 'context'),
      makeAction('ctx2', 'context'),
      makeAction('ui', 'ui'),
    ]
    const reg = createActionRegistry(actions)
    expect(reg.byType('context')).toHaveLength(2)
    expect(reg.byType('message')).toHaveLength(1)
    expect(reg.byType('ui')).toHaveLength(1)
  })
})
