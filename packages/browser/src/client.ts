import { getPublicKey, postRelay, RELAY_PATH } from './api.js'
import { importPublicKey, encryptApiKey as defaultEncryptApiKey } from './crypto.js'
import { clearKeyBlob, loadKeyBlob, saveKeyBlob } from './storage.js'
import { isMessageItem } from './thread.js'
import type { PublicKeyInfo } from './crypto.js'
import type { RelayThreadItem } from './api.js'
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
    encryptApiKey = defaultEncryptApiKey,
    fetchPublicKey = async (ep, fn) => {
      const { keyId, publicKeyPem } = await getPublicKey(ep, fn)
      const publicKey = await importPublicKey(publicKeyPem)
      return { keyId, publicKey }
    },
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

      const relayItems: RelayThreadItem[] = items.flatMap(item => {
        if (isMessageItem(item)) return [{ from: item.from, body: item.body }]
        const ctx = item.toContext()
        return ctx !== null ? [{ from: 'context' as const, body: ctx }] : []
      })

      return postRelay(endpoint, {
        model,
        system,
        items: relayItems,
        additions,
        _relay: { keyId: blob.keyId, ciphertext: blob.ciphertext, provider },
      }, fetchFn, signal)
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

        return fetchFn(`${endpoint}${RELAY_PATH}`, {
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
