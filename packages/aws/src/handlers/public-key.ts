import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

const ssm = new SSMClient({})
const SSM_CURRENT = process.env.SSM_KEY_PARAM ?? '/blindagency/keys/current'

function cors(): Record<string, string> {
  const origin = process.env.CORS_ORIGIN ?? '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' }
  }

  const res = await ssm.send(new GetParameterCommand({ Name: SSM_CURRENT })).catch(() => null)
  const rawValue = res?.Parameter?.Value

  let entry: { keyId: string; publicKeyPem: string } | null = null
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue) as unknown
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof (parsed as Record<string, unknown>).keyId === 'string' &&
        typeof (parsed as Record<string, unknown>).publicKeyPem === 'string'
      ) {
        entry = parsed as { keyId: string; publicKeyPem: string }
      }
    } catch {
      // Malformed SSM entry — treat as uninitialized
    }
  }

  if (!entry) {
    return { statusCode: 503, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Key not yet initialized' }) }
  }

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId: entry.keyId, publicKeyPem: entry.publicKeyPem }),
  }
}
