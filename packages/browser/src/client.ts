import { encryptApiKey as defaultEncryptApiKey, fetchPublicKey as defaultFetchPublicKey } from './crypto.js'
import { clearKeyBlob, loadKeyBlob, saveKeyBlob } from './storage.js'
import { threadToLlmMessages } from './thread.js'
import type { PublicKeyInfo } from './crypto.js'
import type { ThreadItem, TokenUsage } from './thread.js'

export type Provider = 'anthropic' | 'openai' | 'gemini'

export interface RelayConfig {
  endpoint: string
  provider?: Provider
  fetch?: typeof globalThis.fetch
  fetchPublicKey?: (endpoint: string, fetchFn: typeof fetch) => Promise<PublicKeyInfo>
  encryptApiKey?: (apiKey: string, publicKey: CryptoKey) => Promise<ArrayBuffer>
}

export interface Relay {
  setKey(apiKey: string): Promise<void>
  hasKey(): boolean
  clearKey(): void
  send(
    model: string,
    system: string,
    items: readonly ThreadItem[],
    additions?: string[],
    signal?: AbortSignal,
  ): Promise<{ text: string; usage?: TokenUsage }>
  createFetch(): typeof fetch
}

export function createRelay(config: RelayConfig): Relay {
  const {
    endpoint,
    provider = 'anthropic',
    fetch: fetchFn = globalThis.fetch,
    fetchPublicKey = defaultFetchPublicKey,
    encryptApiKey = defaultEncryptApiKey,
  } = config

  return {
    async setKey(apiKey) {
      const { keyId, publicKey } = await fetchPublicKey(endpoint, fetchFn)
      const encrypted = await encryptApiKey(apiKey, publicKey)
      const bytes = new Uint8Array(encrypted)
      const ciphertext = btoa(String.fromCharCode(...bytes))
      saveKeyBlob({ keyId, ciphertext })
    },

    hasKey() {
      return loadKeyBlob() !== null
    },

    clearKey() {
      clearKeyBlob()
    },

    async send(model, system, items, additions = [], signal) {
      const blob = loadKeyBlob()
      if (!blob) throw new Error('No API key configured — call setKey first')

      const messages = [
        ...threadToLlmMessages(items),
        ...additions.map(content => ({ role: 'user' as const, content })),
      ]

      const res = await fetchFn(`${endpoint}/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          system,
          messages,
          _relay: { keyId: blob.keyId, ciphertext: blob.ciphertext, provider },
        }),
        signal,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LLM request failed ${res.status}: ${text}`)
      }

      const data = await res.json() as { text: string; usage?: TokenUsage }
      if (typeof data.text !== 'string') throw new Error('Relay response missing "text" field')
      return { text: data.text, usage: data.usage }
    },

    createFetch() {
      return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const blob = loadKeyBlob()
        if (!blob) throw new Error('No API key configured — call setKey first')

        let bodyObj: Record<string, unknown> = {}
        const rawBody = init?.body
        if (typeof rawBody === 'string') {
          try { bodyObj = JSON.parse(rawBody) } catch { /* non-JSON body, pass as-is in wrapper */ }
        }

        const wrapped = {
          ...bodyObj,
          _relay: { keyId: blob.keyId, ciphertext: blob.ciphertext, provider },
        }

        return fetchFn(`${endpoint}/relay`, {
          ...(init ?? {}),
          method: 'POST',
          headers: {
            ...((init?.headers as Record<string, string> | undefined) ?? {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(wrapped),
        })
      }
    },
  }
}
