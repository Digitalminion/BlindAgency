import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

const ssm = new SSMClient({})
const SSM_CURRENT = process.env.SSM_KEY_PARAM ?? '/blindagency/keys/current'

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const res = await ssm.send(new GetParameterCommand({ Name: SSM_CURRENT }))
  const entry = JSON.parse(res.Parameter?.Value ?? 'null') as { keyId: string; publicKeyPem: string } | null

  if (!entry) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Key not yet initialized' }) }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId: entry.keyId, publicKeyPem: entry.publicKeyPem }),
  }
}
