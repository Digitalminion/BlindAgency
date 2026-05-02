import type { ActionDefinition, ActionType } from './actions.js'

export interface PromptConfig {
  base: string
  actions: ActionDefinition[]
}

const TYPE_LABELS: Record<ActionType, string> = {
  message: 'Message Actions (terminal — display to the user and end the turn)',
  context: 'Context Actions (fetch data and re-invoke you with the result)',
  ui: 'UI Actions (page-level side effects, no context returned)',
}

// Describes available actions grouped by type.
// The JSON response protocol is added automatically by createRuntime — do not duplicate it here.
export function buildSystemPrompt(config: PromptConfig): string {
  const { base, actions } = config
  const sections: string[] = [base.trimEnd()]

  const order: ActionType[] = ['message', 'context', 'ui']
  for (const type of order) {
    const group = actions.filter(a => a.type === type)
    if (group.length === 0) continue
    sections.push(`\n## ${TYPE_LABELS[type]}\n`)
    for (const action of group) sections.push(formatAction(action))
  }

  return sections.join('\n')
}

function formatAction(action: ActionDefinition): string {
  const lines = [`### ${action.name}`, action.description]
  if (action.params) {
    lines.push(`Parameters:\n${JSON.stringify(action.params, null, 2)}`)
  } else {
    lines.push('Parameters: none')
  }
  return lines.join('\n')
}
