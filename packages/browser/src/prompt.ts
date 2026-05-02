import type { HookDefinition, HookType } from './hooks.js'

export interface PromptConfig {
  base: string
  hooks: HookDefinition[]
}

const TYPE_LABELS: Record<HookType, string> = {
  message: 'Message Hooks (terminal — display to the user and end the turn)',
  context: 'Context Hooks (fetch data and re-invoke you with the result)',
  ui: 'UI Hooks (page-level side effects, no context returned)',
}

// Describes available hooks grouped by type.
// The JSON response protocol is added automatically by createRuntime — do not duplicate it here.
export function buildSystemPrompt(config: PromptConfig): string {
  const { base, hooks } = config
  const sections: string[] = [base.trimEnd()]

  const order: HookType[] = ['message', 'context', 'ui']
  for (const type of order) {
    const group = hooks.filter(h => h.type === type)
    if (group.length === 0) continue
    sections.push(`\n## ${TYPE_LABELS[type]}\n`)
    for (const hook of group) sections.push(formatHook(hook))
  }

  return sections.join('\n')
}

function formatHook(hook: HookDefinition): string {
  const lines = [`### ${hook.name}`, hook.description]
  if (hook.params) {
    lines.push(`Parameters:\n${JSON.stringify(hook.params, null, 2)}`)
  } else {
    lines.push('Parameters: none')
  }
  return lines.join('\n')
}
