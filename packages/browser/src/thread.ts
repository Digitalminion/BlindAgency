export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export type ThreadMessageRole = 'user' | 'assistant'

export interface ThreadMessage {
  role: ThreadMessageRole
  content: string
}

export interface ThreadItem {
  readonly id: string
  toContext(): string | null
}

// Built-in item type written by the runtime for each conversation turn.
export interface MessageItem extends ThreadItem {
  readonly kind: 'message'
  readonly from: 'agent' | 'user'
  readonly body: string
  readonly usage?: TokenUsage
}

export function createMessageItem(from: 'agent' | 'user', body: string, usage?: TokenUsage): MessageItem {
  return {
    id: crypto.randomUUID(),
    kind: 'message',
    from,
    body,
    usage,
    toContext: () => null,
  }
}

export interface Thread {
  readonly items: readonly ThreadItem[]
  append(item: ThreadItem): void
  restore(items: readonly ThreadItem[]): void
  clear(): void
  activeContext(): string[]
}

export function isMessageItem(item: ThreadItem): item is MessageItem {
  return 'kind' in item && (item as MessageItem).kind === 'message'
}

export function createThread(): Thread {
  let items: ThreadItem[] = []
  return {
    get items() { return items as readonly ThreadItem[] },
    append(item) { items = [...items, item] },
    restore(newItems) { items = [...newItems] },
    clear() { items = [] },
    activeContext() {
      return items.map(i => i.toContext()).filter((c): c is string => c !== null)
    },
  }
}

// Converts thread items into the ThreadMessage[] the LLM sees.
// MessageItems become role/content pairs. All other items inject their
// toContext() result as a user message at the point they appear in the thread.
export function threadToLlmMessages(items: readonly ThreadItem[]): ThreadMessage[] {
  return items.flatMap(item => {
    if (isMessageItem(item)) {
      return [{ role: item.from === 'agent' ? 'assistant' as const : 'user' as const, content: item.body }]
    }
    const ctx = item.toContext()
    return ctx !== null ? [{ role: 'user' as const, content: ctx }] : []
  })
}
