import type { TokenUsage } from './thread.js'

export const RELAY_PATH = '/relay' as const
export const PUBLIC_KEY_PATH = '/public-key' as const
export const INTEGRITY_PATH = '/integrity' as const

export interface PublicKeyData {
  keyId: string
  publicKeyPem: string
}

export interface RelayThreadItem {
  from: 'user' | 'agent' | 'context'
  body: string
}

export interface RelayRequest {
  model: string
  system: string
  items: RelayThreadItem[]
  additions: string[]
  _relay: { keyId: string; ciphertext: string; provider: string }
}

export interface RelayResponse {
  text: string
  usage?: TokenUsage
}

export async function getPublicKey(endpoint: string, fetchFn: typeof fetch): Promise<PublicKeyData> {
  const res = await fetchFn(`${endpoint}${PUBLIC_KEY_PATH}`)
  if (!res.ok) throw new Error(`getPublicKey failed: ${res.status}`)
  return res.json() as Promise<PublicKeyData>
}

export async function postRelay(
  endpoint: string,
  body: RelayRequest,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<RelayResponse> {
  const res = await fetchFn(`${endpoint}${RELAY_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Relay request failed ${res.status}: ${text}`)
  }
  const data = await res.json() as RelayResponse
  if (typeof data.text !== 'string') throw new Error('Relay response missing "text" field')
  return { text: data.text, usage: data.usage }
}
