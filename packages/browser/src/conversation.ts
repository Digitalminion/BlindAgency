export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string
}

export interface ConversationManager {
  append(message: ConversationMessage): void
  messages(): ConversationMessage[]
  injectContext(context: string): void
  clear(): void
}

export function createConversationManager(): ConversationManager {
  let history: ConversationMessage[] = []

  return {
    append(message) { history.push(message) },
    messages() { return [...history] },
    injectContext(context) {
      history.push({ role: 'user', content: `[Context]\n${context}` })
    },
    clear() { history = [] },
  }
}
