import { INTEGRITY_PATH } from './api.js'

export interface VerifyManifest {
  version: string
  handlers: Record<string, string>
}

export interface HandlerVerification {
  live: string
  published: string
  match: boolean
}

export interface VerifyResult {
  valid: boolean
  version: string
  handlers: Record<string, HandlerVerification>
}

/**
 * Verifies that a deployed relay's Lambda hashes match a published npm manifest.
 *
 * @param endpoint - The relay API base URL (same value as RelayConfig.endpoint)
 * @param manifest - The contents of lambda-hashes.json from @blindagency/aws
 * @param fetchFn  - Optional fetch override for testing
 *
 * @example
 * import { verify } from '@blindagency/browser'
 * import manifest from '@blindagency/aws/dist/lambda-hashes.json' assert { type: 'json' }
 *
 * const result = await verify('https://your-relay.execute-api.us-east-1.amazonaws.com', manifest)
 * console.log(result.valid) // true if all handlers match published hashes
 */
export async function verify(
  endpoint: string,
  manifest: VerifyManifest,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<VerifyResult> {
  const res = await fetchFn(`${endpoint}${INTEGRITY_PATH}`)
  if (!res.ok) throw new Error(`verify: integrity check failed with status ${res.status}`)

  const data = await res.json() as { handlers: Record<string, string> }

  const handlers: Record<string, HandlerVerification> = {}
  for (const [name, published] of Object.entries(manifest.handlers)) {
    const live = data.handlers[name] ?? ''
    handlers[name] = { live, published, match: live === published }
  }

  return {
    valid: Object.values(handlers).every(h => h.match),
    version: manifest.version,
    handlers,
  }
}
