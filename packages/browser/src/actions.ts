export type ActionType = 'message' | 'context' | 'ui'

export type JSONSchema = Record<string, unknown>

export interface ActionDefinition {
  name: string
  type: ActionType
  description: string
  params?: JSONSchema
  handler: ActionHandler
}

export type ActionHandler =
  | ((params: unknown) => void | Promise<void>)
  | ((params: unknown) => string | Promise<string>)

export interface ActionRegistry {
  register(action: ActionDefinition): void
  get(name: string): ActionDefinition | undefined
  all(): ActionDefinition[]
  byType(type: ActionType): ActionDefinition[]
}

export function createActionRegistry(actions: ActionDefinition[] = []): ActionRegistry {
  const map = new Map<string, ActionDefinition>()
  for (const action of actions) map.set(action.name, action)

  return {
    register(action) { map.set(action.name, action) },
    get(name) { return map.get(name) },
    all() { return Array.from(map.values()) },
    byType(type) { return Array.from(map.values()).filter(a => a.type === type) },
  }
}
