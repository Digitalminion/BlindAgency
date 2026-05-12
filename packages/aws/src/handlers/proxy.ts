import { constants, publicEncrypt } from 'crypto'
import { DecryptCommand, InvalidCiphertextException, KMSClient, KMSInvalidStateException } from '@aws-sdk/client-kms'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { ADAPTERS } from './providers.js'
import type { CanonicalMessage, CanonicalRequest } from './providers.js'

const kms = new KMSClient({})
const ssm = new SSMClient({})

const SSM_CURRENT = process.env.SSM_KEY_PARAM ?? '/blindagency/keys/current'
const SSM_PREVIOUS = process.env.SSM_PREV_PARAM ?? '/blindagency/keys/previous'
function allowedProviders(): Set<string> {
  return new Set(
    (process.env.PROVIDERS ?? 'anthropic,openai,gemini').split(',').map(p => p.trim()).filter(Boolean)
  )
}

interface KeyEntry {
  keyId: string
  keyArn: string
  publicKeyPem: string
}

interface KeyLookup {
  entry: KeyEntry
  currentEntry: KeyEntry | null  // non-null when match came from SSM_PREVIOUS
}

interface RelayMeta {
  keyId: string
  ciphertext: string
  provider: string
}

function isRelayMeta(v: unknown): v is RelayMeta {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.keyId === 'string' && r.keyId.length > 0
    && typeof r.ciphertext === 'string' && r.ciphertext.length > 0
    && typeof r.provider === 'string' && r.provider.length > 0
}

function parseKeyEntry(value: string): KeyEntry | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const p = parsed as Record<string, unknown>
    if (typeof p.keyId !== 'string' || typeof p.keyArn !== 'string' || typeof p.publicKeyPem !== 'string') return null
    return parsed as KeyEntry
  } catch {
    return null
  }
}

interface RelayItem {
  from: 'user' | 'agent' | 'context'
  body: string
}

async function loadKeyEntry(keyId: string): Promise<KeyLookup | null> {
  const [currentRes, previousRes] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: SSM_CURRENT })).catch(() => null),
    ssm.send(new GetParameterCommand({ Name: SSM_PREVIOUS })).catch(() => null),
  ])

  const current = currentRes?.Parameter?.Value ? parseKeyEntry(currentRes.Parameter.Value) : null
  const previous = previousRes?.Parameter?.Value ? parseKeyEntry(previousRes.Parameter.Value) : null

  if (current?.keyId === keyId) return { entry: current, currentEntry: null }
  if (previous?.keyId === keyId) return { entry: previous, currentEntry: current }
  return null
}

function cors(): Record<string, string> {
  const origin = process.env.CORS_ORIGIN ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' }
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const relay = body._relay
  if (!isRelayMeta(relay)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Missing _relay metadata' }) }
  }

  // RSA-2048 ciphertext is exactly 256 bytes → 344 base64 chars; 512 is a generous upper bound
  if (relay.ciphertext.length > 512) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid ciphertext' }) }
  }

  const { model, system, items = [], additions = [] } =
    body as { model: string; system: string; items: RelayItem[]; additions: string[] }

  // Constrain model to safe characters — prevents path traversal in provider URL templates
  if (typeof model !== 'string' || !model || model.length > 200 || !/^[A-Za-z0-9._-]+$/.test(model)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid model' }) }
  }

  if (!Array.isArray(items) || !Array.isArray(additions)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'items and additions must be arrays' }) }
  }

  if (items.length > 200 || additions.length > 50) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Too many items or additions' }) }
  }

  if (typeof system === 'string' && system.length > 100_000) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'system prompt too long' }) }
  }

  if (!allowedProviders().has(relay.provider)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `Provider not allowed: ${relay.provider}` }) }
  }

  const adapter = ADAPTERS[relay.provider]
  if (!adapter) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `Unknown provider: ${relay.provider}` }) }
  }

  const lookup = await loadKeyEntry(relay.keyId)
  if (!lookup) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unknown or expired key ID' }) }
  }

  const ciphertextBuf = Buffer.from(relay.ciphertext, 'base64')
  const decrypted = await kms.send(new DecryptCommand({
    KeyId: lookup.entry.keyArn,
    CiphertextBlob: ciphertextBuf,
    EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
  })).catch((err: unknown) => {
    if (err instanceof KMSInvalidStateException || err instanceof InvalidCiphertextException) return null
    throw err
  })

  if (!decrypted || !decrypted.Plaintext) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Key has been revoked, please re-fetch the public key' }) }
  }

  // Construct request materials then immediately null sensitive references.
  // While the plaintext is in scope, opportunistically re-encrypt with the current key
  // so long-lived browser sessions can seamlessly upgrade without user interaction.
  let apiKey: string | null = Buffer.from(decrypted.Plaintext).toString('utf8')
  let headers: Record<string, string> | null = adapter.buildHeaders(apiKey)

  let rekey: { keyId: string; ciphertext: string } | null = null
  if (lookup.currentEntry) {
    try {
      const rekeyBuf = publicEncrypt(
        { key: lookup.currentEntry.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', mgf1Hash: 'sha256' },
        Buffer.from(apiKey),
      )
      rekey = { keyId: lookup.currentEntry.keyId, ciphertext: rekeyBuf.toString('base64') }
    } catch {
      // Re-encryption failed; the response still succeeds, client will rotate on next attempt
    }
  }

  apiKey = null

  const messages: CanonicalMessage[] = [
    ...items.flatMap((item): CanonicalMessage[] => {
      if (typeof item !== 'object' || item === null || typeof (item as RelayItem).body !== 'string') return []
      const r = item as RelayItem
      return [{ role: r.from === 'agent' ? 'assistant' : 'user', content: r.body }]
    }),
    ...additions.flatMap((content): CanonicalMessage[] =>
      typeof content === 'string' ? [{ role: 'user' as const, content }] : []
    ),
  ]

  const req: CanonicalRequest = { model, system: system ?? '', messages }
  const requestBody = JSON.stringify(adapter.buildRequestBody(req))

  const providerRes = await fetch(adapter.buildUrl(req.model), { method: 'POST', headers, body: requestBody })
    .finally(() => { headers = null })

  if (!providerRes.ok) {
    return { statusCode: providerRes.status, headers: cors(), body: JSON.stringify({ error: 'Provider error' }) }
  }

  let providerData: unknown
  try {
    providerData = await providerRes.json()
  } catch {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Invalid response from provider' }) }
  }
  const text = adapter.extractText(providerData)

  if (text === null) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Could not extract text from provider response' }) }
  }

  try {
    JSON.parse(text)
  } catch {
    return {
      statusCode: 422,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'PROTOCOL_VIOLATION', message: 'LLM response was not valid JSON' }),
    }
  }

  const usage = adapter.extractUsage(providerData)

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      ...(usage !== null && { usage }),
      ...(rekey !== null && { rekey }),
    }),
  }
}
