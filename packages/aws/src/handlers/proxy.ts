import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { ADAPTERS } from './providers.js'
import type { CanonicalRequest } from './providers.js'

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
  provider: string
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

  const adapter = ADAPTERS[relay.provider]
  if (!adapter) {
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
  let headers: Record<string, string> | null = adapter.buildHeaders(apiKey)
  apiKey = null

  const { _relay: _removed, ...canonical } = body
  const req = canonical as CanonicalRequest
  const requestBody = JSON.stringify(adapter.buildRequestBody(req))

  const providerRes = await fetch(adapter.buildUrl(req.model), { method: 'POST', headers, body: requestBody })
  headers = null

  if (!providerRes.ok) {
    const errText = await providerRes.text()
    return { statusCode: providerRes.status, headers: cors(), body: JSON.stringify({ error: errText }) }
  }

  const providerData: unknown = await providerRes.json()
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
    body: JSON.stringify({ text, ...(usage !== null && { usage }) }),
  }
}
