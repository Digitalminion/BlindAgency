import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

const lambda = new LambdaClient({})

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

  const targets: Record<string, string> = {
    proxy: process.env.PROXY_FN_NAME!,
    rotation: process.env.ROTATION_FN_NAME!,
    'public-key': process.env.PUBLIC_KEY_FN_NAME!,
  }

  const entries = await Promise.all(
    Object.entries(targets).map(async ([key, name]) => {
      const { CodeSha256 } = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: name }),
      )
      return [key, `sha256:${CodeSha256}`] as const
    }),
  )

  return {
    statusCode: 200,
    headers: { ...cors(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ handlers: Object.fromEntries(entries) }),
  }
}
