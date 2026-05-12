export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface CanonicalMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CanonicalRequest {
  model: string
  system: string
  messages: CanonicalMessage[]
}

export interface ProviderAdapter {
  buildUrl(model: string): string
  buildHeaders(apiKey: string): Record<string, string>
  buildRequestBody(req: CanonicalRequest): unknown
  extractText(response: unknown): string | null
  extractUsage(response: unknown): TokenUsage | null
}

const anthropic: ProviderAdapter = {
  buildUrl: () => 'https://api.anthropic.com/v1/messages',

  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }),

  buildRequestBody: ({ model, system, messages }) => ({
    model,
    ...(system ? { system } : {}),
    messages,
    max_tokens: 4096,
  }),

  extractText: (raw) => {
    const r = raw as { content?: Array<{ type: string; text: string }> }
    if (!Array.isArray(r.content)) return null
    return r.content.find(b => b.type === 'text')?.text ?? null
  },

  extractUsage: (raw) => {
    const r = raw as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }
    if (!r.usage) return null
    return {
      inputTokens: typeof r.usage.input_tokens === 'number' ? r.usage.input_tokens : 0,
      outputTokens: typeof r.usage.output_tokens === 'number' ? r.usage.output_tokens : 0,
    }
  },
}

const openai: ProviderAdapter = {
  buildUrl: () => 'https://api.openai.com/v1/chat/completions',

  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }),

  buildRequestBody: ({ model, system, messages }) => ({
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
  }),

  extractText: (raw) => {
    const r = raw as { choices?: Array<{ message?: { content?: string } }> }
    if (!Array.isArray(r.choices)) return null
    return r.choices[0]?.message?.content ?? null
  },

  extractUsage: (raw) => {
    const r = raw as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
    if (!r.usage) return null
    return {
      inputTokens: typeof r.usage.prompt_tokens === 'number' ? r.usage.prompt_tokens : 0,
      outputTokens: typeof r.usage.completion_tokens === 'number' ? r.usage.completion_tokens : 0,
    }
  },
}

const gemini: ProviderAdapter = {
  buildUrl: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,

  buildHeaders: (apiKey) => ({
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  }),

  buildRequestBody: ({ messages, system }) => ({
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  }),

  extractText: (raw) => {
    const r = raw as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    if (!Array.isArray(r.candidates)) return null
    return r.candidates[0]?.content?.parts?.[0]?.text ?? null
  },

  extractUsage: (raw) => {
    const r = raw as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } }
    if (!r.usageMetadata) return null
    return {
      inputTokens: typeof r.usageMetadata.promptTokenCount === 'number' ? r.usageMetadata.promptTokenCount : 0,
      outputTokens: typeof r.usageMetadata.candidatesTokenCount === 'number' ? r.usageMetadata.candidatesTokenCount : 0,
    }
  },
}

export const ADAPTERS: Record<string, ProviderAdapter> = { anthropic, openai, gemini }
