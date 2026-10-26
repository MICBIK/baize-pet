// SPDX-License-Identifier: AGPL-3.0-only
import type { APIError } from 'openai'
import OpenAI from 'openai'
import {
  type ChatAdapter,
  type ChatDelta,
  type ChatMessage,
  type ChatOptions,
  LlmError,
  type ProviderCapabilities,
  redactSecret,
} from './types'

/**
 * Adapter for every OpenAI-compatible endpoint (DeepSeek / GLM / Kimi / MiniMax /
 * Ollama / GPT …). Streams chat completions and surfaces friendly, key-free errors.
 */
export class OpenAiCompatibleAdapter implements ChatAdapter {
  readonly id: string

  constructor(
    id = 'openai-compatible',
    private readonly capabilitiesOverride?: Partial<ProviderCapabilities>,
  ) {
    this.id = id
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, tools: true, images: false, ...this.capabilitiesOverride }
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<ChatDelta> {
    const client = new OpenAI({
      apiKey: options.apiKey ?? 'not-needed',
      baseURL: options.baseUrl,
      maxRetries: 0,
      timeout: 60_000,
      fetch: options.signal
        ? (url, init) => fetch(url, { ...init, signal: options.signal })
        : undefined,
    })

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>
    try {
      stream = await client.chat.completions.create(
        {
          model: options.model,
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream_options: { include_usage: true },
        },
        { signal: options.signal },
      )
    } catch (error) {
      throw translateError(error, options.apiKey)
    }

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? ''
      if (text) yield { text }
      if (chunk.usage) {
        yield { text: '', totalTokens: chunk.usage.total_tokens }
      }
    }
  }
}

export function translateError(error: unknown, apiKey?: string): LlmError {
  if (error instanceof LlmError) return error
  if (isTimeoutOrConnection(error)) {
    return new LlmError('无法连接到模型服务：请检查网络连接和 baseURL 是否正确。')
  }
  if (isApiError(error)) {
    const status = error.status
    if (status === 401 || status === 403) {
      return new LlmError('认证失败：API key 无效或没有权限，请到设置中检查。', status)
    }
    if (status === 429) {
      return new LlmError('请求太频繁或额度不足：请稍后再试，或检查服务商控制台的余额。', status)
    }
    if (status !== undefined && status >= 500) {
      return new LlmError('模型服务暂时不可用（服务端错误），请稍后再试。', status)
    }
    return new LlmError(redactSecret(`模型服务返回错误：${error.message}`, apiKey), status)
  }
  return new LlmError(redactSecret(`调用模型失败：${(error as Error).message}`, apiKey))
}

function isApiError(error: unknown): error is APIError & { status: number | undefined } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status !== 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

function isTimeoutOrConnection(error: unknown): boolean {
  // The SDK does not always set `name`; the constructor name is stable.
  const ctor = (error as object | null)?.constructor?.name
  const name = (error as { name?: string } | null)?.name
  return (
    ctor === 'APIConnectionError' ||
    ctor === 'APIConnectionTimeoutError' ||
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'AbortError'
  )
}
