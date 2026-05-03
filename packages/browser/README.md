# @blindagency/browser

This package handles the browser side of the BlindAgency system: encrypting the user's API key before it leaves their device, managing the encrypted credential across requests, and running the LLM agent loop.

The typical shape of a BlindAgency integration is: your user supplies their own API key for Anthropic, OpenAI, or Gemini; you want to use it to power an agent in your product without ever seeing the plaintext. This package encrypts the key client-side using the Web Crypto API (RSA-OAEP), stores only the encrypted blob in `sessionStorage`, and wraps every outbound LLM request with the ciphertext so your relay can decrypt it on the fly. The key is never in your server's database, and it never crosses the network unencrypted.

Requires a deployed relay endpoint. See [`@blindagency/aws`](https://www.npmjs.com/package/@blindagency/aws) for the CDK construct that provisions one.

## Install

```bash
npm install @blindagency/browser
```

## Quick start

```typescript
import { createRelay, createRuntime, buildSystemPrompt } from '@blindagency/browser'

// Point the relay at your deployed @blindagency/aws endpoint
const relay = createRelay({
  endpoint: 'https://your-relay.execute-api.us-east-1.amazonaws.com',
  provider: 'anthropic',
})

// Encrypt and store the user's API key — call this once when they supply it
await relay.setKey(userApiKey)

// Define your actions — these are the things the LLM can do
const actions = [
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

// buildSystemPrompt formats action documentation for the LLM.
// The JSON response protocol is appended automatically by createRuntime.
const systemPrompt = buildSystemPrompt({
  base: 'You are a helpful assistant for Acme Corp.',
  actions,
})

const runtime = createRuntime({ relay, model: 'claude-opus-4-5-20251101', systemPrompt, actions })

await runtime.send('What are your pricing plans?')
```

## How the agent loop works

Every LLM response in BlindAgency is a JSON payload — not prose. The runtime instructs the model to respond exclusively with `{ "invocations": [...] }`, where each invocation names an action and optionally provides parameters. The runtime then executes those actions in a defined order.

This structure means the LLM cannot go off-script and render raw text. It must pick an action. If it needs information before it can answer (a `context` action), it asks for it, gets the result injected into the conversation, and is re-invoked. When it's ready to reply, it calls a `message` action and the turn ends.

### `message` — terminal

The LLM has finished reasoning and wants to show the user something. Every turn must resolve to exactly one message invocation.

```typescript
{
  name: 'send-message',
  type: 'message',
  description: 'Send a reply to the user.',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: ({ text }) => { /* render text */ },
}
```

### `context` — fetch data and re-invoke

The LLM is requesting information. Your handler fetches it, the result is injected into the conversation as a user message, and the LLM is called again. This lets the model pull in live data — pricing, inventory, user records — without you having to pre-load everything into the system prompt.

Do not include a `message` action in the same response as a `context` action. The re-invocation handles the message.

```typescript
{
  name: 'fetch-inventory',
  type: 'context',
  description: 'Fetch current product inventory.',
  handler: async () => JSON.stringify(await fetch('/api/inventory').then(r => r.json())),
}
```

### `ui` — side effects

Triggers a page-level action. Nothing is returned to the LLM — this is purely for your UI. Use it for animations, highlights, state updates, or anything that should happen alongside the response.

```typescript
{
  name: 'highlight-feature',
  type: 'ui',
  description: 'Highlight a feature on the page.',
  params: { type: 'object', properties: { featureId: { type: 'string' } }, required: ['featureId'] },
  handler: ({ featureId }) => document.getElementById(featureId)?.classList.add('highlighted'),
}
```

## Thread

The `Thread` is the shared state object that holds the conversation. The runtime writes to it as the conversation progresses; you can read from it at any time, serialize it for persistence, and restore it later.

```typescript
import { createThread, createMessageItem } from '@blindagency/browser'

// Pass an external thread to createRuntime — it will read and write to it
const thread = createThread()
const runtime = createRuntime({ relay, model, systemPrompt, actions, thread })

// After a send(), thread.items contains the full conversation
await runtime.send('Hello')
console.log(thread.items) // [MessageItem(user, 'Hello'), MessageItem(agent, ...)]

// Serialize and restore across page loads
const saved = JSON.stringify(thread.items)
// ...
thread.restore(JSON.parse(saved))
```

### Input items

Sites can append typed input records to the thread before sending. These project themselves into LLM context via `toContext()` so the model knows what happened, without raw form data flowing through the message stream.

```typescript
import { createCollectedInput, createContextInput, createSecureInput, createAcknowledgedInput } from '@blindagency/browser'

// A form submission — LLM sees the field values
thread.append(createCollectedInput('Contact Details', { Name: 'Jane', Email: 'jane@example.com' }))

// Session configuration — LLM uses this to calibrate behavior
thread.append(createContextInput('Workspace', { workspace: 'acme', role: 'admin' }))

// An API key was provided — LLM gets an acknowledgment, never the value
thread.append(createSecureInput('API Key', 'Anthropic'))

// User agreed to something — LLM knows it happened
thread.append(createAcknowledgedInput('Terms of Service'))
```

## API reference

### `createRelay(config)`

```typescript
createRelay({
  endpoint: string             // Base URL of your @blindagency/aws deployment
  provider?: 'anthropic' | 'openai' | 'gemini'  // Default: 'anthropic'
}): Relay
```

| Method | Description |
|--------|-------------|
| `setKey(apiKey)` | Encrypts the API key with the relay's current public key and stores the blob in `sessionStorage`. |
| `hasKey()` | Returns `true` if an encrypted blob is in storage. |
| `clearKey()` | Removes the encrypted blob from storage. Call on logout. |

### `createRuntime(config)`

```typescript
createRuntime({
  relay: Relay
  model: string
  systemPrompt: string          // Protocol instructions are appended automatically
  actions: ActionDefinition[]
  thread?: Thread               // Provide your own, or a new one is created
  maxContextDepth?: number      // Max context re-invocation loops (default: 5)
}): Runtime
```

| Method | Description |
|--------|-------------|
| `send(message)` | Appends the user message and runs the agent loop to completion. Throws if already in progress. |
| `reset()` | Clears the thread. Throws if a send is in progress. |
| `thread` | The `Thread` instance — readable at any time. |

### `buildSystemPrompt(config)`

Formats action documentation into a structured system prompt section. The JSON response protocol is appended automatically by `createRuntime` — do not add it manually.

```typescript
buildSystemPrompt({ base: string, actions: ActionDefinition[] }): string
```

### `PROTOCOL_PROMPT`

The JSON protocol instruction string injected into every system prompt. Exported for inspection or testing.

## Key lifecycle

Keys are stored as `{ keyId, ciphertext }` blobs in `sessionStorage`, falling back to an in-memory store if `sessionStorage` is unavailable. The `keyId` tells the relay which KMS key to use for decryption. The plaintext API key is never written to storage at any point.

`sessionStorage` is cleared when the tab closes, so keys do not survive browser restarts by default. Call `relay.clearKey()` on logout to clear them explicitly within a session.

## Security model and limitations

This package meaningfully reduces the risk of API key exposure compared to proxying keys through a server you control, but it does not eliminate trust in the relay entirely.

**What this protects against:**
- Server-side persistence — the relay has no database, no logging of keys, and no mechanism to store them
- Storage breaches — only ciphertext is written to `sessionStorage`; it is useless without the KMS private key
- Key exposure across sessions — `sessionStorage` is cleared when the tab closes

**What this does not protect against:**
- A compromised relay deployment — if an attacker controls the Lambda execution environment, they can read the decrypted key from memory during request construction. The architecture minimizes the exposure window but cannot eliminate it entirely.
- A compromised public key endpoint — the browser trusts the public key returned by `GET /public-key`. If an attacker can serve a different key (via a compromised deployment or DNS hijack), they can capture future submissions.
- The LLM provider — once the request reaches Anthropic, OpenAI, or Gemini, their standard data handling applies.

The right framing: this is a **trust-minimizing relay**, not a zero-trust system. It is well-suited for "bring your own key" flows where you want to credibly tell users you are not storing their credentials. It is not a substitute for end-to-end encryption in high-security contexts.

## License

Apache-2.0
