// SPDX-License-Identifier: AGPL-3.0-only

/** One chat message. `system` is only sent to providers that support it natively. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model: string
  apiKey?: string
  baseUrl?: string
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
}

export interface ChatDelta {
  text: string
  /** Provider-reported usage, when available (last delta). */
  totalTokens?: number
}

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  images: boolean
}

export interface ChatAdapter {
  id: string
  capabilities(): ProviderCapabilities
  /** Streams the reply as text deltas. */
  chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<ChatDelta>
}

/** Friendly error raised by adapters; the message never contains the API key. */
export class LlmError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

/** Removes any occurrence of the secret from a string (defense in depth). */
export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join('[REDACTED]')
}
