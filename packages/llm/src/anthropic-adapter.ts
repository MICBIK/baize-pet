// SPDX-License-Identifier: AGPL-3.0-only
import Anthropic from '@anthropic-ai/sdk'
import {
  type ChatAdapter,
  type ChatDelta,
  type ChatMessage,
  type ChatOptions,
  LlmError,
  type ProviderCapabilities,
  redactSecret,
} from './types'

/** Minimal surface of the Anthropic client the adapter depends on (injectable for tests). */
export interface AnthropicStreamLike {
  [Symbol.asyncIterator](): AsyncIterator<{
    type: string
    delta?: { type?: string; text?: string }
    message?: { usage?: { input_tokens?: number } }
    usage?: { output_tokens?: number }
  }>
  on(event: 'streamEvent', handler: (event: Record<string, unknown>) => void): void
}

export interface AnthropicClientLike {
  messages: {
    stream: (
      params: {
        model: string
        max_tokens: number
        temperature?: number
        system?: string
        messages: { role: 'user' | 'assistant'; content: string }[]
      },
      options?: { signal?: AbortSignal },
    ) => AnthropicStreamLike
  }
}

/** Adapter for the Anthropic Messages API (Claude). */
export class AnthropicAdapter implements ChatAdapter {
  readonly id = 'anthropic'

  constructor(
    private readonly createClient: (options: ChatOptions) => AnthropicClientLike = defaultClient,
  ) {}

  capabilities(): ProviderCapabilities {
    return { streaming: true, tools: true, images: true }
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<ChatDelta> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const turns = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }))

    let usageTokens: number | undefined
    let stream: AnthropicStreamLike
    try {
      const client = this.createClient(options)
      stream = client.messages.stream(
        {
          model: options.model,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature,
          system: system || undefined,
          messages: turns,
        },
        { signal: options.signal },
      )
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_start') {
          const usage = (event.message as { usage?: { input_tokens?: number } } | undefined)?.usage
          usageTokens = usage?.input_tokens
        }
        if (event.type === 'message_delta') {
          const usage = event.usage as { output_tokens?: number } | undefined
          usageTokens = (usageTokens ?? 0) + (usage?.output_tokens ?? 0)
        }
      })
    } catch (error) {
      throw translateAnthropicError(error, options.apiKey)
    }

    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          yield { text: event.delta.text }
        }
      }
    } catch (error) {
      throw translateAnthropicError(error, options.apiKey)
    }
    if (usageTokens !== undefined) {
      yield { text: '', totalTokens: usageTokens }
    }
  }
}

function defaultClient(options: ChatOptions): AnthropicClientLike {
  const client = new Anthropic({
    apiKey: options.apiKey ?? 'not-needed',
    baseURL: options.baseUrl,
    maxRetries: 0,
    timeout: 60_000,
    fetch: options.signal
      ? (url, init) => fetch(url, { ...init, signal: options.signal })
      : undefined,
  })
  return client as unknown as AnthropicClientLike
}

export function translateAnthropicError(error: unknown, apiKey?: string): LlmError {
  if (error instanceof LlmError) return error
  const status = (error as { status?: number | null } | null)?.status
  if (status === 401 || status === 403) {
    return new LlmError('认证失败：API key 无效或没有权限，请到设置中检查。', status)
  }
  if (status === 429) {
    return new LlmError('请求太频繁或额度不足：请稍后再试，或检查 Anthropic 控制台的余额。', status)
  }
  if (status !== undefined && status !== null && status >= 500) {
    return new LlmError('模型服务暂时不可用（服务端错误），请稍后再试。', status)
  }
  const name = (error as { name?: string } | null)?.name
  if (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'AbortError'
  ) {
    return new LlmError('无法连接到模型服务：请检查网络连接。')
  }
  return new LlmError(
    redactSecret(`调用模型失败：${(error as Error).message}`, apiKey),
    status ?? undefined,
  )
}
