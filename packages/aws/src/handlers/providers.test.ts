import { describe, expect, it } from 'vitest'
import { ADAPTERS } from './providers.js'
import type { CanonicalRequest } from './providers.js'

const req: CanonicalRequest = {
  model: 'test-model',
  system: 'You are helpful.',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ],
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

describe('anthropic adapter', () => {
  const a = ADAPTERS.anthropic

  it('buildUrl returns the messages endpoint regardless of model', () => {
    expect(a.buildUrl('claude-opus-4')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('buildHeaders sets x-api-key and anthropic-version', () => {
    const h = a.buildHeaders('sk-test')
    expect(h['x-api-key']).toBe('sk-test')
    expect(h['anthropic-version']).toBeDefined()
    expect(h['Authorization']).toBeUndefined()
  })

  it('buildRequestBody passes model, system, messages, and max_tokens', () => {
    const body = a.buildRequestBody(req) as Record<string, unknown>
    expect(body.model).toBe('test-model')
    expect(body.system).toBe('You are helpful.')
    expect(body.messages).toEqual(req.messages)
    expect(typeof body.max_tokens).toBe('number')
  })

  it('buildRequestBody omits system when empty', () => {
    const body = a.buildRequestBody({ ...req, system: '' }) as Record<string, unknown>
    expect('system' in body).toBe(false)
  })

  it('extractText returns the first text content block', () => {
    const raw = { content: [{ type: 'text', text: '{"invocations":[]}' }] }
    expect(a.extractText(raw)).toBe('{"invocations":[]}')
  })

  it('extractText returns null when content is missing', () => {
    expect(a.extractText({})).toBeNull()
  })

  it('extractUsage normalizes input_tokens and output_tokens', () => {
    expect(a.extractUsage({ usage: { input_tokens: 100, output_tokens: 50 } }))
      .toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('extractUsage returns null when usage is absent', () => {
    expect(a.extractUsage({})).toBeNull()
  })

  it('extractUsage defaults missing counts to zero', () => {
    expect(a.extractUsage({ usage: {} })).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

// ── OpenAI ────────────────────────────────────────────────────────────────────

describe('openai adapter', () => {
  const a = ADAPTERS.openai

  it('buildUrl returns the chat completions endpoint regardless of model', () => {
    expect(a.buildUrl('gpt-4o')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('buildHeaders sets Authorization Bearer', () => {
    const h = a.buildHeaders('sk-test')
    expect(h['Authorization']).toBe('Bearer sk-test')
    expect(h['x-api-key']).toBeUndefined()
  })

  it('buildRequestBody injects system as first role:system message', () => {
    const body = a.buildRequestBody(req) as { model: string; messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('buildRequestBody omits system message when system is empty', () => {
    const body = a.buildRequestBody({ ...req, system: '' }) as { messages: unknown[] }
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('extractText returns the first choice content', () => {
    const raw = { choices: [{ message: { content: '{"invocations":[]}' } }] }
    expect(a.extractText(raw)).toBe('{"invocations":[]}')
  })

  it('extractText returns null when choices is missing', () => {
    expect(a.extractText({})).toBeNull()
  })

  it('extractUsage normalizes prompt_tokens and completion_tokens', () => {
    expect(a.extractUsage({ usage: { prompt_tokens: 200, completion_tokens: 75 } }))
      .toEqual({ inputTokens: 200, outputTokens: 75 })
  })

  it('extractUsage returns null when usage is absent', () => {
    expect(a.extractUsage({})).toBeNull()
  })
})

// ── Gemini ────────────────────────────────────────────────────────────────────

describe('gemini adapter', () => {
  const a = ADAPTERS.gemini

  it('buildUrl embeds the model in the path', () => {
    expect(a.buildUrl('gemini-2.0-flash'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
  })

  it('buildHeaders sets x-goog-api-key', () => {
    const h = a.buildHeaders('goog-test')
    expect(h['x-goog-api-key']).toBe('goog-test')
    expect(h['Authorization']).toBeUndefined()
  })

  it('buildRequestBody maps messages to contents with role translation', () => {
    const body = a.buildRequestBody(req) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
      systemInstruction?: { parts: Array<{ text: string }> }
    }
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] })
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'hi there' }] })
  })

  it('buildRequestBody sets systemInstruction when system is present', () => {
    const body = a.buildRequestBody(req) as { systemInstruction?: { parts: Array<{ text: string }> } }
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] })
  })

  it('buildRequestBody omits systemInstruction when system is empty', () => {
    const body = a.buildRequestBody({ ...req, system: '' }) as Record<string, unknown>
    expect('systemInstruction' in body).toBe(false)
  })

  it('buildRequestBody does not include model in the body', () => {
    const body = a.buildRequestBody(req) as Record<string, unknown>
    expect('model' in body).toBe(false)
  })

  it('extractText returns the first candidate text part', () => {
    const raw = { candidates: [{ content: { parts: [{ text: '{"invocations":[]}' }] } }] }
    expect(a.extractText(raw)).toBe('{"invocations":[]}')
  })

  it('extractText returns null when candidates is missing', () => {
    expect(a.extractText({})).toBeNull()
  })

  it('extractUsage normalizes promptTokenCount and candidatesTokenCount', () => {
    expect(a.extractUsage({ usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 } }))
      .toEqual({ inputTokens: 120, outputTokens: 45 })
  })

  it('extractUsage returns null when usageMetadata is absent', () => {
    expect(a.extractUsage({})).toBeNull()
  })
})

// ── Registry ──────────────────────────────────────────────────────────────────

describe('ADAPTERS registry', () => {
  it('contains entries for all three providers', () => {
    expect(ADAPTERS.anthropic).toBeDefined()
    expect(ADAPTERS.openai).toBeDefined()
    expect(ADAPTERS.gemini).toBeDefined()
  })

  it('returns undefined for an unknown provider', () => {
    expect(ADAPTERS['unknown']).toBeUndefined()
  })
})
