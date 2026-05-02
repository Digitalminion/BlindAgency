# @blindagency/browser

Browser-native LLM agent runtime with encrypted key relay. Users supply their own API key — it is encrypted client-side with RSA-OAEP before it ever leaves their browser. Your relay server sees only ciphertext.

Requires a deployed relay endpoint. See [`@blindagency/aws`](https://www.npmjs.com/package/@blindagency/aws) for the CDK construct that provisions one.

## Install

```bash
npm install @blindagency/browser
```

## Quick start

```typescript
import {
  createRelay,
  createRuntime,
  buildSystemPrompt,
} from '@blindagency/browser'

// 1. Create a relay pointed at your deployed @blindagency/aws endpoint
const relay = createRelay({
  endpoint: 'https://your-relay.execute-api.us-east-1.amazonaws.com',
  provider: 'anthropic',
})

// 2. Set the user's API key — encrypts it immediately, stores ciphertext in sessionStorage
await relay.setKey(userApiKey)

// 3. Define your hooks
const hooks = [
  {
    name: 'send-message',
    type: 'message',
    description: 'Send a response to the user.',
    params: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    handler: ({ text }) => {
      document.querySelector('#chat').innerText = text
    },
  },
  {
    name: 'fetch-pricing',
    type: 'context',
    description: 'Retrieve current pricing information.',
    handler: async () => {
      const res = await fetch('/api/pricing')
      return JSON.stringify(await res.json())
    },
  },
]

// 4. Build the system prompt with hook documentation
//    The JSON response protocol is added automatically by createRuntime.
const systemPrompt = buildSystemPrompt({
  base: 'You are a helpful assistant for Acme Corp.',
  hooks,
})

// 5. Create the runtime
const runtime = createRuntime({
  relay,
  model: 'claude-opus-4-5-20251101',
  systemPrompt,
  hooks,
})

// 6. Send a message
await runtime.send('What are your pricing plans?')
```

## Hook types

Every LLM response is a JSON payload with an ordered list of invocations. The runtime processes them in a fixed order regardless of how they appear in the response.

### `message` — terminal

Displays a response to the user and ends the turn. Every conversation turn must resolve to exactly one message invocation.

```typescript
{
  name: 'send-message',
  type: 'message',
  description: 'Send a reply to the user.',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: ({ text }) => { /* render text */ },
}
```

### `context` — re-invokes with data

Fetches data and injects the result into the conversation, then re-invokes the LLM. Use this to give the LLM access to live information without exposing your data to the browser upfront. The LLM requests what it needs; your handler fetches it.

```typescript
{
  name: 'fetch-inventory',
  type: 'context',
  description: 'Fetch current product inventory.',
  handler: async () => {
    const data = await fetch('/api/inventory').then(r => r.json())
    return JSON.stringify(data)
  },
}
```

Do not include a `message` hook in the same response as a `context` hook — the LLM is re-invoked after context is injected, and will produce its message hook then.

### `ui` — side effects

Triggers a page-level side effect. Nothing is returned to the LLM. Use this for visualizations, animations, or state updates that should happen before or alongside the message.

```typescript
{
  name: 'highlight-feature',
  type: 'ui',
  description: 'Highlight a feature on the page.',
  params: { type: 'object', properties: { featureId: { type: 'string' } }, required: ['featureId'] },
  handler: ({ featureId }) => {
    document.getElementById(featureId)?.classList.add('highlighted')
  },
}
```

## API

### `createRelay(config)`

```typescript
createRelay({
  endpoint: string   // Base URL of your @blindagency/aws deployment
  provider?: 'anthropic' | 'openai' | 'gemini'  // Default: 'anthropic'
}): Relay
```

| Method | Description |
|--------|-------------|
| `setKey(apiKey)` | Encrypts and stores the API key. Fetches the current public key from the relay. |
| `hasKey()` | Returns `true` if an encrypted key is in storage. |
| `clearKey()` | Removes the encrypted key from storage. Call on logout. |
| `createFetch()` | Returns a fetch-compatible function that routes requests through the relay. |

### `createRuntime(config)`

```typescript
createRuntime({
  relay: Relay
  model: string         // LLM model identifier
  systemPrompt: string  // Your prompt (protocol instructions are appended automatically)
  hooks: HookDefinition[]
  maxContextDepth?: number  // Max context re-invocation loops (default: 5)
}): Runtime
```

| Method | Description |
|--------|-------------|
| `send(message)` | Appends the user message and runs the agent loop to completion. |
| `reset()` | Clears conversation history. |

### `buildSystemPrompt(config)`

Assembles hook documentation into a structured system prompt section. The JSON response protocol (`PROTOCOL_PROMPT`) is appended automatically by `createRuntime` — do not add it manually.

```typescript
buildSystemPrompt({
  base: string           // Your base system prompt
  hooks: HookDefinition[]
}): string
```

### `PROTOCOL_PROMPT`

The JSON protocol instruction injected into every system prompt by `createRuntime`. Exported for inspection or testing.

## Key lifecycle

Keys are stored as encrypted blobs in `sessionStorage` (falls back to an in-memory store if `sessionStorage` is unavailable). The blob contains `{ keyId, ciphertext }` — the `keyId` tells the relay which KMS key to use for decryption, and the `ciphertext` is the RSA-OAEP encrypted API key. The plaintext API key is never written to storage at any point.

Call `relay.clearKey()` when the user logs out or closes their session.

## Security model and limitations

This package meaningfully reduces the risk of API key exposure compared to sending keys directly to a server, but it does not eliminate trust in the relay entirely.

**What this protects against:**
- Server-side persistence — the relay has no database, no logging of keys, and no mechanism to store them
- Storage breaches — only ciphertext is written to `sessionStorage`; a breach of client-side storage exposes nothing usable without the KMS private key
- Key exposure across sessions — `sessionStorage` is cleared when the tab closes; keys do not survive browser restarts

**What this does not protect against:**
- A compromised relay deployment — if an attacker controls the Lambda execution environment, they can intercept the decrypted key during request construction. The architecture minimizes exposure time but cannot eliminate it entirely.
- A compromised public key endpoint — the browser trusts the public key returned by `GET /public-key`. If an attacker can serve a different public key (via a compromised deployment or DNS hijack), they can capture future keys. The relay itself has no key-pinning mechanism.
- The LLM provider — once the request reaches Anthropic, OpenAI, or Gemini, their standard data handling applies. This relay does not change what the provider sees.

The right framing: this is a **trust-minimizing relay**, not a zero-trust system. It is well-suited for "bring your own key" flows where you want to credibly tell users you are not storing their credentials. It is not a substitute for end-to-end encryption in high-security contexts.
