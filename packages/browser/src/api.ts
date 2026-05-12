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
  rekey?: { keyId: string; ciphertext: string }
}

export async function getPublicKey(endpoint: string, fetchFn: typeof fetch): Promise<PublicKeyData> {
  const res = await fetchFn(`${endpoint}${PUBLIC_KEY_PATH}`)
  if (!res.ok) throw new Error(`getPublicKey failed: ${res.status}`)
  const data = await res.json() as unknown
  if (
    typeof data !== 'object' || data === null ||
    typeof (data as Record<string, unknown>).keyId !== 'string' ||
    typeof (data as Record<string, unknown>).publicKeyPem !== 'string'
  ) {
    throw new Error('getPublicKey: invalid response shape')
  }
  return data as PublicKeyData
}

function isValidRekey(value: unknown): value is { keyId: string; ciphertext: string } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.keyId === 'string' && v.keyId.length > 0
    && typeof v.ciphertext === 'string' && v.ciphertext.length > 0
    && v.ciphertext.length <= 512
}

function isValidUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.inputTokens === 'number' && typeof v.outputTokens === 'number'
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
  const data = await res.json() as Record<string, unknown>
  const text = data.text
  if (typeof text !== 'string') throw new Error('Relay response missing "text" field')
  const usage = isValidUsage(data.usage) ? data.usage : undefined
  const rekey = isValidRekey(data.rekey) ? data.rekey : undefined
  return { text, usage, ...(rekey && { rekey }) }
}
