import { createConversationManager } from './conversation.js'
import { createHookRegistry } from './hooks.js'
import type { HookDefinition } from './hooks.js'
import type { Relay } from './client.js'

export interface AgentInvocation {
  hook: string
  params?: unknown
}

export interface AgentResponse {
  invocations: AgentInvocation[]
}

export interface RuntimeConfig {
  relay: Relay
  model: string
  systemPrompt: string
  hooks: HookDefinition[]
  maxContextDepth?: number
}

export interface Runtime {
  send(userMessage: string): Promise<void>
  reset(): void
}

const DEFAULT_MAX_CONTEXT_DEPTH = 5

// Injected into every system prompt by createRuntime — guarantees the LLM always
// knows it must respond with structured JSON regardless of what else the prompt says.
export const PROTOCOL_PROMPT = `## Response Protocol

You MUST respond with valid JSON only — no prose, no markdown outside the JSON block.

Every response must use this exact structure:
{
  "invocations": [
    { "hook": "<hook-name>", "params": { ... } }
  ]
}

Invocation processing order:
1. UI hooks run first — page-level side effects, nothing returned to you.
2. Context hooks run next — each result is injected into the conversation and you are re-invoked. Do NOT include a message hook in the same response as a context hook.
3. Message hooks are terminal — include exactly one as the last invocation when you are ready to reply to the user.`

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

  return parsed as AgentResponse
}

export function createRuntime(config: RuntimeConfig): Runtime {
  const { relay, model, systemPrompt, hooks, maxContextDepth = DEFAULT_MAX_CONTEXT_DEPTH } = config

  const registry = createHookRegistry(hooks)
  const conversation = createConversationManager()
  const relayFetch = relay.createFetch()
  const fullSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${PROTOCOL_PROMPT}`
    : PROTOCOL_PROMPT

  async function callLlm(): Promise<string> {
    const body = {
      model,
      system: fullSystemPrompt,
      messages: conversation.messages(),
    }

    const res = await relayFetch('/', {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM request failed ${res.status}: ${text}`)
    }

    // Relay normalizes all provider responses to { text: string }
    const data = await res.json() as { text: string }
    if (typeof data.text !== 'string') throw new Error('Relay response missing "text" field')
    return data.text
  }

  async function runTurn(depth: number): Promise<void> {
    if (depth > maxContextDepth) {
      throw new Error(`Max context depth (${maxContextDepth}) exceeded`)
    }

    const raw = await callLlm()
    conversation.append({ role: 'assistant', content: raw })

    const response = parseAgentResponse(raw)

    const uiInvocations = response.invocations.filter(
      i => registry.get(i.hook)?.type === 'ui',
    )
    const contextInvocations = response.invocations.filter(
      i => registry.get(i.hook)?.type === 'context',
    )
    const messageInvocations = response.invocations.filter(
      i => registry.get(i.hook)?.type === 'message',
    )

    for (const inv of uiInvocations) {
      const hook = registry.get(inv.hook)
      if (hook) await hook.handler(inv.params ?? {})
    }

    if (contextInvocations.length > 0) {
      const parts: string[] = []
      for (const inv of contextInvocations) {
        const hook = registry.get(inv.hook)
        if (hook) {
          const result = await hook.handler(inv.params ?? {})
          if (typeof result === 'string') parts.push(`[${inv.hook}]\n${result}`)
        }
      }
      if (parts.length > 0) conversation.injectContext(parts.join('\n\n'))
      await runTurn(depth + 1)
      return
    }

    for (const inv of messageInvocations) {
      const hook = registry.get(inv.hook)
      if (hook) await hook.handler(inv.params ?? {})
    }
  }

  return {
    async send(userMessage) {
      conversation.append({ role: 'user', content: userMessage })
      await runTurn(0)
    },
    reset() {
      conversation.clear()
    },
  }
}
