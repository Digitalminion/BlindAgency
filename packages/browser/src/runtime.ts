import { createThread, createMessageItem } from './thread.js'
import { createActionRegistry } from './actions.js'
import type { ActionRegistry, ActionDefinition } from './actions.js'
import type { Thread, TokenUsage } from './thread.js'
import type { Relay } from './client.js'

export interface AgentInvocation {
  action: string
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
  actions: ActionDefinition[]
  thread?: Thread
  maxContextDepth?: number
  debug?: boolean
}

export interface Runtime {
  send(userMessage: string, options?: SendOptions): Promise<void>
  reset(): void
  readonly thread: Thread
  readonly usage: TokenUsage
}

export interface TurnContext {
  invoke: (additions?: string[], signal?: AbortSignal) => Promise<{ text: string; usage?: TokenUsage }>
  registry: ActionRegistry
  thread: Thread
  maxDepth: number
  debug: boolean
}

const DEFAULT_MAX_CONTEXT_DEPTH = 5

export const PROTOCOL_PROMPT = `## Response Protocol

You MUST respond with valid JSON only — no prose, no markdown outside the JSON block.

Every response must use this exact structure:
{
  "reasoning": "<optional>",
  "reasoningComplete": false,
  "invocations": [
    { "action": "<action-name>", "params": { ... } }
  ]
}

### Reasoning

The "reasoning" field is optional. Use it to think through a problem before acting, or to explain why you are invoking a particular action. Your reasoning will be injected back into the conversation before you are re-invoked — you can build on it across turns.

When you have gathered everything you need and are ready to reply to the user, set "reasoningComplete": true alongside your message action:

{
  "reasoningComplete": true,
  "invocations": [{ "action": "<message-action>", "params": { "text": "..." } }]
}

This signals that the intermediate reasoning steps are no longer needed. They will be removed from the conversation history so future turns start clean.

### Invocation processing order

1. UI actions run first — page-level side effects, nothing returned to you.
2. If "reasoning" is present or context actions are invoked, you will be re-invoked. Your reasoning and any context results are injected together before the next call. Do NOT include a message action in the same response.
3. Message actions are terminal — include exactly one when you are ready to reply to the user. Set "reasoningComplete": true if you used reasoning to get here.`

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

function validateActionParams(actionName: string, schema: ActionDefinition['params'], params: unknown): void {
  if (!schema) return
  const required = (schema as { required?: string[] }).required
  if (!required?.length) return
  if (typeof params !== 'object' || params === null) {
    throw new Error(`Action "${actionName}": params must be an object`)
  }
  for (const field of required) {
    if (!(field in (params as Record<string, unknown>))) {
      throw new Error(`Action "${actionName}": required param "${field}" is missing`)
    }
  }
}

interface ResolvedInvocation {
  inv: AgentInvocation
  action: ActionDefinition
}

interface PartitionedInvocations {
  ui: ResolvedInvocation[]
  context: ResolvedInvocation[]
  message: ResolvedInvocation[]
}

function partitionInvocations(invocations: AgentInvocation[], registry: ActionRegistry): PartitionedInvocations {
  const result: PartitionedInvocations = { ui: [], context: [], message: [] }
  for (const inv of invocations) {
    const action = registry.get(inv.action)
    if (!action) continue
    result[action.type].push({ inv, action })
  }
  return result
}

// threadStartLength is the thread length when the outermost runTurn call began.
// It defaults on first call and is passed through unchanged on every recursive call
// so the cleanup knows exactly which items were added during this turn.
export async function runTurn(
  ctx: TurnContext,
  depth: number,
  additions: string[] = [],
  threadStartLength = ctx.thread.items.length,
  signal?: AbortSignal,
): Promise<void> {
  if (depth > ctx.maxDepth) {
    throw new Error(`Max context depth (${ctx.maxDepth}) exceeded`)
  }

  const { text: raw, usage } = await ctx.invoke(additions, signal)
  const response = parseAgentResponse(raw)
  ctx.thread.append(createMessageItem('agent', raw, usage))

  const { ui, context, message } = partitionInvocations(response.invocations, ctx.registry)

  for (const { inv, action } of ui) {
    validateActionParams(inv.action, action.params, inv.params ?? {})
    await action.handler(inv.params ?? {})
  }

  // Reasoning and context actions are both non-terminal — collect whatever each
  // contributes and re-invoke once with everything injected together.
  if (response.reasoning !== undefined || context.length > 0) {
    const newAdditions: string[] = []

    if (response.reasoning !== undefined) {
      if (ctx.debug) console.log(`[BlindAgency] depth ${depth} — reasoning: ${response.reasoning}`)
      newAdditions.push(`[Reasoning]\n${response.reasoning}`)
    }

    if (context.length > 0) {
      const parts: string[] = []
      for (const { inv, action } of context) {
        if (ctx.debug) console.log(`[BlindAgency] depth ${depth} — context: ${inv.action}`)
        validateActionParams(inv.action, action.params, inv.params ?? {})
        const result = await action.handler(inv.params ?? {})
        if (typeof result === 'string') parts.push(`[${inv.action}]\n${result}`)
      }
      if (parts.length > 0) {
        newAdditions.push(`[Context]\n${parts.join('\n\n')}`)
      }
    }

    await runTurn(ctx, depth + 1, [...additions, ...newAdditions], threadStartLength, signal)
    return
  }

  for (const { inv, action } of message) {
    validateActionParams(inv.action, action.params, inv.params ?? {})
    await action.handler(inv.params ?? {})
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
  const { relay, model, systemPrompt, actions, maxContextDepth = DEFAULT_MAX_CONTEXT_DEPTH, debug = false } = config

  const registry = createActionRegistry(actions)
  const thread = config.thread ?? createThread()
  const fullSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${PROTOCOL_PROMPT}`
    : PROTOCOL_PROMPT

  const accumulated: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  const ctx: TurnContext = {
    invoke: async (additions = [], signal) => {
      const result = await relay.send(model, fullSystemPrompt, thread.items, additions, signal)
      if (result.usage) {
        accumulated.inputTokens += result.usage.inputTokens
        accumulated.outputTokens += result.usage.outputTokens
      }
      return result
    },
    registry,
    thread,
    maxDepth: maxContextDepth,
    debug,
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
