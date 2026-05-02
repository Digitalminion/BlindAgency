import type { ThreadItem } from './thread.js'

export type InputType = 'secure' | 'collected' | 'context' | 'acknowledged'

// Base for all four input types. Sites extend ThreadItem via these interfaces
// to attach card submissions to the thread.
export interface InputItem extends ThreadItem {
  readonly kind: 'input'
  readonly inputType: InputType
  readonly label: string
}

// ── Secure ────────────────────────────────────────────────────────────────
// Credential handoff. Value travels an encrypted path — never present in state.
// LLM receives acknowledgment only.

export interface SecureInput extends InputItem {
  readonly inputType: 'secure'
  readonly provider?: string
}

export function createSecureInput(label: string, provider?: string): SecureInput {
  return {
    id: crypto.randomUUID(),
    kind: 'input',
    inputType: 'secure',
    label,
    provider,
    toContext() {
      const who = provider ? `${provider} ` : ''
      return `[${label} Card — saved]\nUser provided their ${who}${label.toLowerCase()}. Saved securely.`
    },
  }
}

// ── Collected ─────────────────────────────────────────────────────────────
// Structured data extracted from the user. LLM sees the values.
// Also flows to an external system — the thread records what was captured.

export interface CollectedInput extends InputItem {
  readonly inputType: 'collected'
  readonly fields: Record<string, string>
}

export function createCollectedInput(label: string, fields: Record<string, string>): CollectedInput {
  return {
    id: crypto.randomUUID(),
    kind: 'input',
    inputType: 'collected',
    label,
    fields,
    toContext() {
      const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
      return `[${label} Card — submitted]\n${lines}`
    },
  }
}

// ── Context ───────────────────────────────────────────────────────────────
// Session configuration provided by the user. LLM sees the values and uses
// them to calibrate behavior. Memory only — not submitted anywhere.

export interface ContextInput extends InputItem {
  readonly inputType: 'context'
  readonly fields: Record<string, string>
}

export function createContextInput(label: string, fields: Record<string, string>): ContextInput {
  return {
    id: crypto.randomUUID(),
    kind: 'input',
    inputType: 'context',
    label,
    fields,
    toContext() {
      const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
      return `[${label} Card — confirmed]\n${lines}`
    },
  }
}

// ── Acknowledged ──────────────────────────────────────────────────────────
// User confirmed or agreed to something. LLM knows it happened — no data
// extracted, nothing submitted externally.

export interface AcknowledgedInput extends InputItem {
  readonly inputType: 'acknowledged'
}

export function createAcknowledgedInput(label: string): AcknowledgedInput {
  return {
    id: crypto.randomUUID(),
    kind: 'input',
    inputType: 'acknowledged',
    label,
    toContext() {
      return `[${label} Card — acknowledged]\nUser confirmed the ${label.toLowerCase()}.`
    },
  }
}
