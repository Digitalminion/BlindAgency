import { createThread, createMessageItem, threadToLlmMessages } from './thread.js'
import { createHookRegistry } from './hooks.js'
import type { HookRegistry } from './hooks.js'
import type { HookDefinition } from './hooks.js'
import type { Thread, ThreadMessage, TokenUsage } from './thread.js'
import type { Relay } from './client.js'

export interface AgentInvocation {
  hook: string
  params?: unknown
}

export interface AgentResponse {
  reasoning?: string
  reasoningComplete?: boolean
  invocations: AgentInvocation[]
}

export interface SendOptions {
  signal?: AbortSignal
}

export interface RuntimeConfig {
  relay: Relay
  model: string
  systemPrompt: string
  hooks: HookDefinition[]
  thread?: Thread
  maxContextDepth?: number
}

export interface Runtime {
  send(userMessage: string, options?: SendOptions): Promise<void>
  reset(): void
  readonly thread: Thread
  readonly usage: TokenUsage
}

export interface TurnContext {
  callLlm: (ephemeral?: ThreadMessage[], signal?: AbortSignal) => Promise<{ text: string; usage?: TokenUsage }>
  registry: HookRegistry
  thread: Thread
  maxDepth: number
}

const DEFAULT_MAX_CONTEXT_DEPTH = 5

export const PROTOCOL_PROMPT = `## Response Protocol

You MUST respond with valid JSON only — no prose, no markdown outside the JSON block.

Every response must use this exact structure:
{
  "reasoning": "<optional>",
  "reasoningComplete": false,
  "invocations": [
    { "hook": "<hook-name>", "params": { ... } }
  ]
}

### Reasoning

The "reasoning" field is optional. Use it to think through a problem before acting, or to explain why you are invoking a particular hook. Your reasoning will be injected back into the conversation before you are re-invoked — you can build on it across turns.

When you have gathered everything you need and are ready to reply to the user, set "reasoningComplete": true alongside your message hook:

{
  "reasoningComplete": true,
  "invocations": [{ "hook": "<message-hook>", "params": { "text": "..." } }]
}

This signals that the intermediate reasoning steps are no longer needed. They will be removed from the conversation history so future turns start clean.

### Invocation processing order

1. UI hooks run first — page-level side effects, nothing returned to you.
2. If "reasoning" is present or context hooks are invoked, you will be re-invoked. Your reasoning and any context results are injected together before the next call. Do NOT include a message hook in the same response.
3. Message hooks are terminal — include exactly one when you are ready to reply to the user. Set "reasoningComplete": true if you used reasoning to get here.`

export function parseAgentResponse(raw: string): AgentResponse {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error(`Agent response is not valid JSON: ${raw.slice(0, 200)}`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).invocations)
  ) {
    throw new Error(`Agent response missing "invocations" array: ${raw.slice(0, 200)}`)
  }

  const record = parsed as Record<string, unknown>
  const reasoning = typeof record.reasoning === 'string' ? record.reasoning : undefined
  const reasoningComplete = record.reasoningComplete === true ? true : undefined

  return { reasoning, reasoningComplete, invocations: (parsed as AgentResponse).invocations }
}

export async function callLlm(
  relayFetch: typeof fetch,
  model: string,
  systemPrompt: string,
  messages: ThreadMessage[],
  signal?: AbortSignal,
): Promise<{ text: string; usage?: TokenUsage }> {
  const res = await relayFetch('/', {
    method: 'POST',
    body: JSON.stringify({ model, system: systemPrompt, messages }),
    signal,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM request failed ${res.status}: ${text}`)
  }

  const data = await res.json() as { text: string; usage?: TokenUsage }
  if (typeof data.text !== 'string') throw new Error('Relay response missing "text" field')
  return { text: data.text, usage: data.usage }
}

function validateHookParams(hookName: string, schema: HookDefinition['params'], params: unknown): void {
  if (!schema) return
  const required = (schema as { required?: string[] }).required
  if (!required?.length) return
  if (typeof params !== 'object' || params === null) {
    throw new Error(`Hook "${hookName}": params must be an object`)
  }
  for (const field of required) {
    if (!(field in (params as Record<string, unknown>))) {
      throw new Error(`Hook "${hookName}": required param "${field}" is missing`)
    }
  }
}

// threadStartLength is the thread length when the outermost runTurn call began.
// It defaults on first call and is passed through unchanged on every recursive call
// so the cleanup knows exactly which items were added during this turn.
export async function runTurn(
  ctx: TurnContext,
  depth: number,
  ephemeral: ThreadMessage[] = [],
  threadStartLength = ctx.thread.items.length,
  signal?: AbortSignal,
): Promise<void> {
  if (depth > ctx.maxDepth) {
    throw new Error(`Max context depth (${ctx.maxDepth}) exceeded`)
  }

  const { text: raw, usage } = await ctx.callLlm(ephemeral, signal)
  const response = parseAgentResponse(raw)
  ctx.thread.append(createMessageItem('agent', raw, usage))

  const uiInvocations = response.invocations.filter(
    i => ctx.registry.get(i.hook)?.type === 'ui',
  )
  const contextInvocations = response.invocations.filter(
    i => ctx.registry.get(i.hook)?.type === 'context',
  )
  const messageInvocations = response.invocations.filter(
    i => ctx.registry.get(i.hook)?.type === 'message',
  )

  for (const inv of uiInvocations) {
    const hook = ctx.registry.get(inv.hook)
    if (hook) {
      validateHookParams(inv.hook, hook.params, inv.params ?? {})
      await hook.handler(inv.params ?? {})
    }
  }

  // Reasoning and context hooks are both non-terminal — collect whatever each
  // contributes and re-invoke once with everything injected together.
  if (response.reasoning !== undefined || contextInvocations.length > 0) {
    const nextEphemeral: ThreadMessage[] = [...ephemeral]

    if (response.reasoning !== undefined) {
      nextEphemeral.push({ role: 'user', content: `[Reasoning]\n${response.reasoning}` })
    }

    if (contextInvocations.length > 0) {
      const parts: string[] = []
      for (const inv of contextInvocations) {
        const hook = ctx.registry.get(inv.hook)
        if (hook) {
          validateHookParams(inv.hook, hook.params, inv.params ?? {})
          const result = await hook.handler(inv.params ?? {})
          if (typeof result === 'string') parts.push(`[${inv.hook}]\n${result}`)
        }
      }
      if (parts.length > 0) {
        nextEphemeral.push({ role: 'user', content: `[Context]\n${parts.join('\n\n')}` })
      }
    }

    await runTurn(ctx, depth + 1, nextEphemeral, threadStartLength, signal)
    return
  }

  for (const inv of messageInvocations) {
    const hook = ctx.registry.get(inv.hook)
    if (hook) {
      validateHookParams(inv.hook, hook.params, inv.params ?? {})
      await hook.handler(inv.params ?? {})
    }
  }

  // Prune intermediate reasoning turns from the thread so they don't pollute
  // future turns. Keeps everything up to threadStartLength (the items that
  // existed when this send() began) plus the final agent response.
  if (response.reasoningComplete) {
    const priorItems = ctx.thread.items.slice(0, threadStartLength)
    const finalItem = ctx.thread.items.at(-1)!
    ctx.thread.restore([...priorItems, finalItem])
  }
}

export function createRuntime(config: RuntimeConfig): Runtime {
  const { relay, model, systemPrompt, hooks, maxContextDepth = DEFAULT_MAX_CONTEXT_DEPTH } = config

  const registry = createHookRegistry(hooks)
  const thread = config.thread ?? createThread()
  const relayFetch = relay.createFetch()
  const fullSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${PROTOCOL_PROMPT}`
    : PROTOCOL_PROMPT

  const accumulated: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const ctx: TurnContext = {
    callLlm: async (ephemeral = [], signal) => {
      const result = await callLlm(
        relayFetch,
        model,
        fullSystemPrompt,
        [...threadToLlmMessages(thread.items), ...ephemeral],
        signal,
      )
      if (result.usage) {
        accumulated.inputTokens += result.usage.inputTokens
        accumulated.outputTokens += result.usage.outputTokens
      }
      return result
    },
    registry,
    thread,
    maxDepth: maxContextDepth,
  }

  let busy = false

  return {
    async send(userMessage, options = {}) {
      if (busy) throw new Error('Runtime is busy — await the current send() before calling again')
      busy = true
      try {
        thread.append(createMessageItem('user', userMessage))
        await runTurn(ctx, 0, [], thread.items.length, options.signal)
      } finally {
        busy = false
      }
    },
    reset() {
      if (busy) throw new Error('Cannot reset while a send() is in progress')
      thread.clear()
    },
    get thread() { return thread },
    get usage() { return { ...accumulated } },
  }
}
