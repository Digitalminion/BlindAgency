# @blindagency/aws

CDK L3 construct that deploys the BlindAgency relay infrastructure to AWS. Wires up an API Gateway HTTP API, three Lambda functions, KMS asymmetric key management, SSM Parameter Store, and an EventBridge rotation schedule — all with least-privilege IAM.

Used alongside [`@blindagency/browser`](https://www.npmjs.com/package/@blindagency/browser), which handles client-side key encryption and the agent runtime.

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

// Pass these to your frontend config
console.log(relay.apiUrl)        // https://{id}.execute-api.{region}.amazonaws.com
console.log(relay.publicKeyUrl)  // https://{id}.execute-api.{region}.amazonaws.com/public-key
```

## Connecting to the browser package

After `cdk deploy`, pass `relay.apiUrl` as the `endpoint` to `createRelay` in `@blindagency/browser`:

```typescript
import { createRelay } from '@blindagency/browser'

const relay = createRelay({
  endpoint: 'https://{id}.execute-api.{region}.amazonaws.com', // relay.apiUrl from CDK output
  provider: 'anthropic',
})

await relay.setKey(userApiKey)
```

The browser package handles key encryption, session storage, and the agent runtime. This package only handles the AWS infrastructure.

## What gets deployed

| Resource | Purpose |
|----------|---------|
| `GET /public-key` Lambda | Returns the current `{ keyId, publicKeyPem }` for client-side encryption |
| `POST /relay` Lambda | Decrypts the API key via KMS, forwards the request to the LLM provider, returns `{ text }` |
| Rotation Lambda | Creates a new KMS RSA-2048 key pair on schedule, rotates SSM entries, schedules deletion of the old key |
| KMS asymmetric key | RSA-OAEP key pair — private key never leaves KMS |
| SSM Parameter Store | Stores `current` and `previous` key entries (`{ keyId, keyArn, publicKeyPem }`) |
| EventBridge rule | Triggers the rotation Lambda on the configured interval |
| CloudFormation Custom Resource | Invokes the rotation Lambda once on first deploy so the endpoint is live immediately |

## Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `providers` | `('anthropic' \| 'openai' \| 'gemini')[]` | Yes | — | LLM providers the relay will accept requests for |
| `corsOrigins` | `string[]` | Yes | — | Origins allowed by CORS. Pass `['*']` for development only. |
| `rotationInterval` | `Duration` | No | `Duration.hours(1)` | How often to rotate the KMS key pair |
| `maxConcurrency` | `number` | No | `10` | Reserved concurrent executions for the relay Lambda. Prevents the relay from being used as an open LLM proxy at scale and limits blast radius if credentials are stolen. |

## Outputs

| Property | Description |
|----------|-------------|
| `apiUrl` | Base URL of the HTTP API — pass to `createRelay({ endpoint })` in `@blindagency/browser` |
| `publicKeyUrl` | Full URL of the `GET /public-key` endpoint |

## Security

**KMS key permissions are tag-scoped.** The rotation Lambda can only create keys that carry the `Application: BlindAgency` tag (`aws:RequestTag` condition), and can only manage keys that already carry that tag (`aws:ResourceTag` condition). The relay Lambda can only decrypt using tagged keys. This means the IAM policies are bounded even though they target `resources: ['*']` — they cannot touch any KMS key in your account that was not created by this construct.

**CloudTrail data events are not configured by this construct.** If your account has CloudTrail data events enabled at the account level, KMS decrypt calls and SSM parameter reads will appear in those logs. The logs contain only key metadata (`keyId`, parameter names) — not plaintext key material — but you should be aware of this if you operate in an audited environment. This is an account-level concern, not something this construct can suppress.

**The decrypted API key exists in Lambda memory only for the duration of request construction.** The handler nulls both the key variable and the headers reference before the provider `fetch` is awaited. It is never logged, written to storage, or included in any response.

**Key rotation grace window.** When a new key pair is created, the previous key remains valid in SSM for the duration of one rotation interval — long enough for any in-flight browser sessions to complete. The old KMS key is then scheduled for deletion with a 7-day pending window (KMS minimum). Access is cut off at the SSM layer well before the KMS deletion fires.

## Limitations

This construct meaningfully reduces the risk surface around API key handling, but it is important to understand what it does and does not guarantee.

**What the architecture prevents:**
- The relay cannot persist keys — there is no database, no logging path, and no code that writes the decrypted key anywhere
- A breach of the SSM parameters exposes only key metadata (`keyArn`, `keyId`) — the private key material never leaves KMS
- Key rotation limits the blast radius of a compromised key to a single rotation window

**What the architecture does not prevent:**
- A compromised Lambda execution environment — if an attacker has arbitrary code execution in the relay Lambda, they can read the decrypted key from memory during request construction. The architecture minimizes the exposure window; it does not eliminate the Lambda as a trust boundary.
- A compromised AWS account — if your AWS account credentials are stolen, all bets are off regardless of this construct
- Provider-side exposure — once the request reaches Anthropic, OpenAI, or Gemini, it is subject to their data handling policies

The relay is designed to let you truthfully say to users: *we do not store your API key and our infrastructure has no mechanism to do so*. It is not designed for adversarial contexts where the infrastructure itself may be compromised.

## How the relay handles providers

The relay accepts a `provider` field in each request (set by `@blindagency/browser` via `createRelay({ provider })`). It routes to the appropriate API endpoint, sets the correct authentication headers for that provider, and normalizes the response to `{ text: string }` before returning it to the browser. The browser runtime has no provider-specific logic.

| Provider | Endpoint |
|----------|----------|
| `anthropic` | `https://api.anthropic.com/v1/messages` |
| `openai` | `https://api.openai.com/v1/chat/completions` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/models:generateContent` |

## Protocol enforcement

If the LLM returns a response that is not valid JSON, the relay returns `422` with `{ error: 'PROTOCOL_VIOLATION' }` rather than forwarding malformed data to the browser. This catches cases where the model drifts off the structured response protocol before the browser runtime attempts to parse the response.
