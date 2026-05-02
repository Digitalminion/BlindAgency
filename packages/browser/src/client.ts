import { encryptApiKey as defaultEncryptApiKey, fetchPublicKey as defaultFetchPublicKey } from './crypto.js'
import { clearKeyBlob, loadKeyBlob, saveKeyBlob } from './storage.js'
import type { PublicKeyInfo } from './crypto.js'

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
