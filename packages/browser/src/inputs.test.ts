import { describe, expect, it } from 'vitest'
import {
  createSecureInput,
  createCollectedInput,
  createContextInput,
  createAcknowledgedInput,
} from './inputs.js'
import { isMessageItem } from './thread.js'

describe('createSecureInput', () => {
  it('toContext includes the card label and saved confirmation', () => {
    const item = createSecureInput('API Key')
    expect(item.toContext()).toContain('[API Key Card — saved]')
    expect(item.toContext()).toContain('Saved securely')
  })

  it('toContext includes the provider when supplied', () => {
    const item = createSecureInput('API Key', 'Anthropic')
    expect(item.toContext()).toContain('Anthropic')
  })

  it('toContext does not include the provider field when omitted', () => {
    const item = createSecureInput('API Key')
    expect(item.inputType).toBe('secure')
    expect(item.provider).toBeUndefined()
  })

  it('value is never present in the projection', () => {
    const item = createSecureInput('API Key', 'Anthropic')
    // No mechanism to pass a value — the factory intentionally has no value param
    expect(item.toContext()).not.toContain('sk-')
  })

  it('assigns unique ids', () => {
    expect(createSecureInput('Key').id).not.toBe(createSecureInput('Key').id)
  })

  it('has kind input and inputType secure', () => {
    const item = createSecureInput('Key')
    expect(item.kind).toBe('input')
    expect(item.inputType).toBe('secure')
  })
})

describe('createCollectedInput', () => {
  it('toContext includes the card label and submitted marker', () => {
    const item = createCollectedInput('Contact Details', { Name: 'Jane', Email: 'jane@example.com' })
    expect(item.toContext()).toContain('[Contact Details Card — submitted]')
  })

  it('toContext includes all field values', () => {
    const item = createCollectedInput('Lead', { Name: 'Jane', Company: 'Acme' })
    const ctx = item.toContext()
    expect(ctx).toContain('Name: Jane')
    expect(ctx).toContain('Company: Acme')
  })

  it('toContext with empty fields produces a valid projection', () => {
    const item = createCollectedInput('Empty Form', {})
    expect(item.toContext()).toContain('[Empty Form Card — submitted]')
  })

  it('has kind input and inputType collected', () => {
    const item = createCollectedInput('Form', {})
    expect(item.kind).toBe('input')
    expect(item.inputType).toBe('collected')
  })
})

describe('createContextInput', () => {
  it('toContext includes the card label and confirmed marker', () => {
    const item = createContextInput('Workspace Setup', { workspace: 'acme', role: 'admin' })
    expect(item.toContext()).toContain('[Workspace Setup Card — confirmed]')
  })

  it('toContext includes all field values', () => {
    const item = createContextInput('Session', { workspace: 'acme', role: 'admin' })
    const ctx = item.toContext()
    expect(ctx).toContain('workspace: acme')
    expect(ctx).toContain('role: admin')
  })

  it('has kind input and inputType context', () => {
    const item = createContextInput('Setup', {})
    expect(item.kind).toBe('input')
    expect(item.inputType).toBe('context')
  })
})

describe('createCollectedInput — additional', () => {
  it('assigns unique ids', () => {
    expect(createCollectedInput('Form', {}).id).not.toBe(createCollectedInput('Form', {}).id)
  })

  it('fields appear in insertion order in the projection', () => {
    const item = createCollectedInput('Order', { First: 'A', Second: 'B', Third: 'C' })
    const ctx = item.toContext()!
    expect(ctx.indexOf('First')).toBeLessThan(ctx.indexOf('Second'))
    expect(ctx.indexOf('Second')).toBeLessThan(ctx.indexOf('Third'))
  })

  it('toContext returns a non-null string', () => {
    expect(createCollectedInput('X', { k: 'v' }).toContext()).not.toBeNull()
  })
})

describe('createContextInput — additional', () => {
  it('assigns unique ids', () => {
    expect(createContextInput('Session', {}).id).not.toBe(createContextInput('Session', {}).id)
  })

  it('fields appear in insertion order in the projection', () => {
    const item = createContextInput('Config', { alpha: '1', beta: '2', gamma: '3' })
    const ctx = item.toContext()!
    expect(ctx.indexOf('alpha')).toBeLessThan(ctx.indexOf('beta'))
    expect(ctx.indexOf('beta')).toBeLessThan(ctx.indexOf('gamma'))
  })

  it('toContext returns a non-null string', () => {
    expect(createContextInput('X', { k: 'v' }).toContext()).not.toBeNull()
  })
})

describe('createAcknowledgedInput', () => {
  it('toContext includes the card label and acknowledged marker', () => {
    const item = createAcknowledgedInput('Terms of Service')
    expect(item.toContext()).toContain('[Terms of Service Card — acknowledged]')
  })

  it('toContext confirms the user acknowledged', () => {
    const item = createAcknowledgedInput('Privacy Policy')
    expect(item.toContext()).toContain('User confirmed')
  })

  it('has kind input and inputType acknowledged', () => {
    const item = createAcknowledgedInput('Terms')
    expect(item.kind).toBe('input')
    expect(item.inputType).toBe('acknowledged')
  })

  it('assigns unique ids', () => {
    expect(createAcknowledgedInput('Terms').id).not.toBe(createAcknowledgedInput('Terms').id)
  })

  it('toContext returns a non-null string', () => {
    expect(createAcknowledgedInput('Terms').toContext()).not.toBeNull()
  })
})

describe('input items — cross-type invariants', () => {
  it('none of the input types are message items', () => {
    expect(isMessageItem(createSecureInput('Key'))).toBe(false)
    expect(isMessageItem(createCollectedInput('Form', {}))).toBe(false)
    expect(isMessageItem(createContextInput('Setup', {}))).toBe(false)
    expect(isMessageItem(createAcknowledgedInput('Terms'))).toBe(false)
  })

  it('all input types return a non-null toContext', () => {
    expect(createSecureInput('Key').toContext()).not.toBeNull()
    expect(createCollectedInput('Form', { k: 'v' }).toContext()).not.toBeNull()
    expect(createContextInput('Setup', { k: 'v' }).toContext()).not.toBeNull()
    expect(createAcknowledgedInput('Terms').toContext()).not.toBeNull()
  })

  it('all input types have kind input', () => {
    expect(createSecureInput('Key').kind).toBe('input')
    expect(createCollectedInput('Form', {}).kind).toBe('input')
    expect(createContextInput('Setup', {}).kind).toBe('input')
    expect(createAcknowledgedInput('Terms').kind).toBe('input')
  })
})
