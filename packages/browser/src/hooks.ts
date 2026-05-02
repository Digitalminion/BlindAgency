export type HookType = 'message' | 'context' | 'ui'

export type JSONSchema = Record<string, unknown>

export interface HookDefinition {
  name: string
  type: HookType
  description: string
  params?: JSONSchema
  handler: HookHandler
}

export type HookHandler =
  | ((params: unknown) => void | Promise<void>)
  | ((params: unknown) => string | Promise<string>)

export interface HookRegistry {
  register(hook: HookDefinition): void
  get(name: string): HookDefinition | undefined
  all(): HookDefinition[]
  byType(type: HookType): HookDefinition[]
}

export function createHookRegistry(hooks: HookDefinition[] = []): HookRegistry {
  const map = new Map<string, HookDefinition>()
  for (const hook of hooks) map.set(hook.name, hook)

  return {
    register(hook) { map.set(hook.name, hook) },
    get(name) { return map.get(name) },
    all() { return Array.from(map.values()) },
    byType(type) { return Array.from(map.values()).filter(h => h.type === type) },
  }
}
