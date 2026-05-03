# @blindagency/aws

This package provisions the AWS infrastructure that makes BlindAgency work. Drop `BlindAgencyConstruct` into your CDK stack and it wires up everything the relay needs: an HTTP API, three Lambda functions, asymmetric KMS key management, SSM Parameter Store for key distribution, and an EventBridge schedule that rotates the key pair automatically.

The relay's job is narrow and deliberate. It receives an encrypted API key blob from the browser, uses KMS to decrypt it in memory, forwards the LLM request to the appropriate provider, and returns a normalized `{ text }` response. It has no database, no persistent state, and no mechanism to log or store the plaintext key. The architecture is designed so that you can truthfully tell users: *we do not store your API key and our infrastructure has no way to do so.*

Used alongside [`@blindagency/browser`](https://www.npmjs.com/package/@blindagency/browser), which handles client-side encryption and the agent runtime.

## Install

```bash
npm install @blindagency/aws
```

Requires peer dependencies:

```bash
npm install aws-cdk-lib constructs
```

## Usage

```typescript
import { Stack, App, Duration } from 'aws-cdk-lib'
import { BlindAgencyConstruct } from '@blindagency/aws'

const app = new App()
const stack = new Stack(app, 'BlindAgencyStack', {
  env: { account: process.env.CDK_ACCOUNT, region: process.env.CDK_REGION },
})

const relay = new BlindAgencyConstruct(stack, 'Relay', {
  providers: ['anthropic', 'openai'],
  corsOrigins: ['https://yoursite.com'],
  rotationInterval: Duration.hours(1), // optional, default 1 hour
})

// Pass these URLs to your frontend configuration
console.log(relay.apiUrl)        // https://{id}.execute-api.{region}.amazonaws.com
console.log(relay.publicKeyUrl)  // https://{id}.execute-api.{region}.amazonaws.com/public-key
```

After `cdk deploy`, pass `relay.apiUrl` as the `endpoint` to `createRelay` in `@blindagency/browser`:

```typescript
import { createRelay } from '@blindagency/browser'

const relay = createRelay({
  endpoint: relay.apiUrl,
  provider: 'anthropic',
})

await relay.setKey(userApiKey)
```

## What gets deployed

Four Lambdas serve distinct roles and are granted only the permissions they need.

| Resource | Purpose |
|----------|---------|
| `GET /public-key` Lambda | Returns `{ keyId, publicKeyPem }` — the current RSA public key for client-side encryption |
| `POST /relay` Lambda | Decrypts the API key via KMS, forwards the request to the LLM provider, returns `{ text }` |
| Rotation Lambda | Creates a new KMS RSA-2048 key pair on schedule, updates SSM, schedules deletion of the old key |
| `GET /integrity` Lambda | Queries AWS for the live `CodeSha256` of each handler and returns them — used to verify the deployed code matches the published npm release |
| KMS asymmetric key | RSA-OAEP key pair — the private key never leaves KMS |
| SSM Parameter Store | Holds `current` and `previous` key entries (`{ keyId, keyArn, publicKeyPem }`) |
| EventBridge rule | Triggers the rotation Lambda on the configured interval |
| CloudFormation Custom Resource | Invokes the rotation Lambda once on first deploy so a valid key pair exists immediately |

## Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `providers` | `('anthropic' \| 'openai' \| 'gemini')[]` | Yes | — | LLM providers the relay will accept requests for |
| `corsOrigins` | `string[]` | Yes | — | Allowed CORS origins. Use `['*']` for development only. |
| `rotationInterval` | `Duration` | No | `Duration.hours(1)` | How often to rotate the KMS key pair |
| `maxConcurrency` | `number` | No | `10` | Reserved concurrent executions on the relay Lambda. Caps scale and limits blast radius if credentials are stolen. |

## Outputs

| Property | Description |
|----------|-------------|
| `apiUrl` | Base URL of the HTTP API — pass to `createRelay({ endpoint })` |
| `publicKeyUrl` | Full URL of the `GET /public-key` endpoint |
| `integrityUrl` | Full URL of the `GET /integrity` endpoint |

## Supply chain verification

Every published version of this package includes `dist/lambda-hashes.json` — a manifest of SHA-256 hashes for each Lambda handler ZIP, computed during the build and locked to the exact bytes that get uploaded to AWS.

```json
{
  "version": "0.1.2",
  "handlers": {
    "proxy":       "sha256:r8Ollo22lUVh6cziFXmfA1yY5aeOQbvEPTdluebUYwI=",
    "rotation":    "sha256:77YF0dMv0TaELNPaA2Cpg/7JstGwQOAEF9pQHS6d19Q=",
    "public-key":  "sha256:DPXXPxajWN5OYutPxjWz5l6uU0ZxYPl9/y7TBQlgCSY=",
    "integrity":   "sha256:ErqGGAwYX53lHRJOdTUXmOpWvrjuNzVQaU+mfmSpWpA="
  }
}
```

The hashes use the same encoding (`sha256:<base64>`) that AWS uses for `CodeSha256` on Lambda function configurations. When CDK deploys the construct, it uploads those exact ZIPs — no re-zipping, no transformation. The hash you see in the manifest is the hash AWS records.

The `/integrity` endpoint returns the live `CodeSha256` values by calling `GetFunctionConfiguration` on each handler directly from the Lambda control plane. This is not a self-reported value baked into the function's code — it is AWS's own record of what is running.

**To verify a deployed relay against the published manifest:**

```bash
# Fetch the live hashes from the deployed endpoint
curl https://your-relay.execute-api.us-east-1.amazonaws.com/integrity

# Compare against the published manifest for the installed version
cat node_modules/@blindagency/aws/dist/lambda-hashes.json
```

Or programmatically using `verify()` from `@blindagency/browser`:

```typescript
import { verify } from '@blindagency/browser'
import manifest from '@blindagency/aws/dist/lambda-hashes.json' assert { type: 'json' }

const result = await verify('https://your-relay.execute-api.us-east-1.amazonaws.com', manifest)

if (!result.valid) {
  const mismatched = Object.entries(result.handlers)
    .filter(([, h]) => !h.match)
    .map(([name]) => name)
  console.error('Hash mismatch on:', mismatched)
}
```

**What a matching hash proves:** the Lambda handler running in the deployer's AWS account is byte-for-byte identical to the code published under that npm version. It does not prove anything about the deployer's AWS account configuration, IAM policies, or infrastructure outside this construct.

**The integrity handler itself** is intentionally excluded from its own response — a Lambda cannot reference its own ARN in an IAM policy without creating a CloudFormation dependency cycle. Its hash is in the npm manifest (`handlers.integrity`) and can be verified independently with `aws lambda get-function-configuration --function-name <IntegrityFn-name> --query CodeSha256`.

## Security

**KMS permissions are tag-scoped.** The rotation Lambda can only create KMS keys tagged `Application: BlindAgency` (enforced by `aws:RequestTag`), and can only manage keys that already carry that tag (enforced by `aws:ResourceTag`). The relay Lambda can only decrypt with tagged keys. This means the IAM policies are bounded even though they reference `resources: ['*']` — they cannot touch any key in your account that this construct did not create.

**The proxy Lambda runs at WARN log level.** The Lambda runtime emits `START`, `END`, and `REPORT` lines at INFO by default — suppressed here so that nothing is written to CloudWatch for a normal successful invocation. The log group exists but stays empty under normal operation.

**The proxy log group is KMS-encrypted.** A dedicated log encryption key ensures that if anything were ever logged (an error, for example), it would be unreadable without the encryption key. The log group has a one-day retention policy.

**The decrypted API key exists in Lambda memory only for the duration of request construction.** The handler nulls both the key variable and the headers reference before the provider `fetch` is awaited. It is never logged, written to storage, or included in any response.

**Key rotation grace window.** When a new key pair is created, the previous key remains valid in SSM for one full rotation interval — long enough for any in-flight browser sessions to complete their current request. The old KMS key is then scheduled for deletion with a 7-day pending window (the KMS minimum). Access is cut off at the SSM layer well before the KMS deletion fires.

**CloudTrail data events are not configured by this construct.** If your account has CloudTrail data events enabled at the account level, KMS decrypt calls and SSM parameter reads will appear in those logs. Those logs contain only key metadata — `keyId`, parameter names — not plaintext key material. Worth being aware of in an audited environment; not something this construct can suppress.

**Access logging on the HTTP API is intentionally disabled.** API Gateway access logs include request metadata but not bodies. Disabling them removes any path by which request-level metadata could be written to a persistent store.

## Limitations

**What the architecture prevents:**
- The relay cannot persist keys — there is no database, no logging path, and no code that writes the decrypted key anywhere
- A breach of SSM exposes only key metadata (`keyArn`, `keyId`) — the private key material never leaves KMS
- Key rotation limits the blast radius of a compromised session to a single rotation window

**What the architecture does not prevent:**
- A compromised Lambda execution environment — if an attacker achieves arbitrary code execution inside the relay Lambda, they can read the decrypted key from memory. The architecture minimizes the window; it cannot eliminate the Lambda as a trust boundary.
- A compromised AWS account — if your account credentials are stolen, all bets are off regardless of this construct.
- Provider-side exposure — once the request reaches Anthropic, OpenAI, or Gemini, it is subject to their data handling policies.

## How the relay handles providers

The relay reads the `provider` field set by `@blindagency/browser`, routes to the appropriate API endpoint, sets the correct authentication headers, and normalizes the response to `{ text: string }` before returning it. The browser runtime has no provider-specific logic.

| Provider | Endpoint |
|----------|----------|
| `anthropic` | `https://api.anthropic.com/v1/messages` |
| `openai` | `https://api.openai.com/v1/chat/completions` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models:generateContent` |

## Protocol enforcement

If the LLM returns a response that is not valid JSON, the relay returns `422` with `{ error: 'PROTOCOL_VIOLATION' }` rather than forwarding malformed data to the browser. This catches cases where the model drifts off the structured response protocol before the browser runtime attempts to parse the response.

## License

Apache-2.0
