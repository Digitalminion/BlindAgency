import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

const kms = new KMSClient({})
const ssm = new SSMClient({})

const SSM_CURRENT = process.env.SSM_KEY_PARAM ?? '/blindagency/keys/current'
const SSM_PREVIOUS = process.env.SSM_PREV_PARAM ?? '/blindagency/keys/previous'

interface KeyEntry {
  keyId: string
  keyArn: string
  publicKeyPem: string
}

interface RelayMeta {
  keyId: string
  ciphertext: string
  provider: 'anthropic' | 'openai' | 'gemini'
}

const PROVIDER_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models:generateContent',
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

function extractUsage(provider: string, raw: unknown): TokenUsage | null {
  if (provider === 'anthropic') {
    const r = raw as { usage?: { input_tokens?: number; output_tokens?: number } }
    if (!r.usage) return null
    return { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0 }
  }
  if (provider === 'openai') {
    const r = raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
    if (!r.usage) return null
    return { inputTokens: r.usage.prompt_tokens ?? 0, outputTokens: r.usage.completion_tokens ?? 0 }
  }
  if (provider === 'gemini') {
    const r = raw as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
    if (!r.usageMetadata) return null
    return { inputTokens: r.usageMetadata.promptTokenCount ?? 0, outputTokens: r.usageMetadata.candidatesTokenCount ?? 0 }
  }
  return null
}

async function loadKeyEntry(keyId: string): Promise<KeyEntry | null> {
  const [currentRes, previousRes] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: SSM_CURRENT })).catch(() => null),
    ssm.send(new GetParameterCommand({ Name: SSM_PREVIOUS })).catch(() => null),
  ])

  for (const res of [currentRes, previousRes]) {
    if (!res?.Parameter?.Value) continue
    const entry = JSON.parse(res.Parameter.Value) as KeyEntry
    if (entry.keyId === keyId) return entry
  }

  return null
}

function buildProviderHeaders(provider: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

// Normalize each provider's wire format to { text: string } so the browser runtime
// is completely agnostic about which LLM is behind the relay.
function extractText(provider: string, raw: unknown): string | null {
  if (provider === 'anthropic') {
    const r = raw as { content?: Array<{ type: string; text: string }> }
    return r.content?.find(b => b.type === 'text')?.text ?? null
  }
  if (provider === 'openai') {
    const r = raw as { choices?: Array<{ message?: { content?: string } }> }
    return r.choices?.[0]?.message?.content ?? null
  }
  if (provider === 'gemini') {
    const r = raw as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    return r.candidates?.[0]?.content?.parts?.[0]?.text ?? null
  }
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

  const relay = body._relay as RelayMeta | undefined
  if (!relay?.keyId || !relay?.ciphertext || !relay?.provider) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Missing _relay metadata' }) }
  }

  const providerUrl = PROVIDER_URLS[relay.provider]
  if (!providerUrl) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: `Unknown provider: ${relay.provider}` }) }
  }

  const keyEntry = await loadKeyEntry(relay.keyId)
  if (!keyEntry) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unknown or expired key ID' }) }
  }

  const ciphertextBuf = Buffer.from(relay.ciphertext, 'base64')
  const decrypted = await kms.send(new DecryptCommand({
    KeyId: keyEntry.keyArn,
    CiphertextBlob: ciphertextBuf,
    EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
  }))

  // Construct request materials then immediately null sensitive references
  let apiKey: string | null = Buffer.from(decrypted.Plaintext!).toString('utf8')
  let headers: Record<string, string> | null = buildProviderHeaders(relay.provider, apiKey)
  apiKey = null

  const { _relay: _removed, ...forwardBody } = body
  const requestBody = JSON.stringify(forwardBody)

  const providerRes = await fetch(providerUrl, {
    method: 'POST',
    headers: headers,
    body: requestBody,
  })
  headers = null

  if (!providerRes.ok) {
    const errText = await providerRes.text()
    return { statusCode: providerRes.status, headers: cors(), body: JSON.stringify({ error: errText }) }
  }

  const providerData: unknown = await providerRes.json()
  const text = extractText(relay.provider, providerData)

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

  const usage = extractUsage(relay.provider, providerData)

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(usage !== null && { usage }) }),
  }
}
