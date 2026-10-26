// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicAdapter } from './anthropic-adapter'
import { OpenAiCompatibleAdapter, translateError } from './openai-adapter'
import { type ChatOptions, LlmError } from './types'

const FAKE_KEY = 'sk-test-abcdef1234567890'

const baseOptions: ChatOptions = {
  model: 'test-model',
  apiKey: FAKE_KEY,
  baseUrl: 'https://api.example.test/v1',
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAiCompatibleAdapter', () => {
  it('streams text deltas from an SSE chat-completions stream', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，主人"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":42}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAiCompatibleAdapter('deepseek')
    const deltas: string[] = []
    let tokens: number | undefined
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], baseOptions)) {
      deltas.push(delta.text)
      if (delta.totalTokens !== undefined) tokens = delta.totalTokens
    }
    expect(deltas.join('')).toBe('你好，主人')
    expect(tokens).toBe(42)
    // Request went to the configured endpoint with the model and stream flag.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.example.test/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(true)
  })

  it('translates 401 into a friendly error without leaking the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }), {
            status: 401,
          }),
      ),
    )
    const adapter = new OpenAiCompatibleAdapter('deepseek')
    const error = await adapter
      .chat([{ role: 'user', content: 'hi' }], baseOptions)
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e)
    expect((error as LlmError).status).toBe(401)
    expect((error as LlmError).message).toContain('API key')
    expect((error as LlmError).message).not.toContain(FAKE_KEY)
  })

  it('translates connection failures into a friendly error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new (class extends Error {
          override name = 'APIConnectionError'
          constructor() {
            super('fetch failed')
          }
        })()
      }),
    )
    const adapter = new OpenAiCompatibleAdapter('ollama')
    await expect(async () => {
      for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], {
        ...baseOptions,
        apiKey: undefined,
      })) {
        // consume
      }
    }).rejects.toThrow(/无法连接到模型服务/)
  })

  it('translateError redacts secrets from upstream messages', () => {
    const error = translateError(new Error(`auth failed for ${FAKE_KEY}`), FAKE_KEY)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.message).not.toContain(FAKE_KEY)
    expect(error.message).toContain('[REDACTED]')
  })
})

describe('AnthropicAdapter', () => {
  function fakeClient(
    events: {
      type: string
      delta?: { type?: string; text?: string }
      message?: { usage?: { input_tokens?: number } }
      usage?: { output_tokens?: number }
    }[],
  ) {
    return {
      messages: {
        stream: (params: Record<string, unknown>) => {
          capturedParams = params
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield event
            },
            on(_event: string, _handler: (event: Record<string, unknown>) => void) {
              // usage accounting tested via message_delta handling below
            },
          }
        },
      },
    }
  }
  let capturedParams: Record<string, unknown> | null = null

  it('streams text deltas from anthropic events and extracts the system prompt', async () => {
    const adapter = new AnthropicAdapter(
      () =>
        fakeClient([
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '早上好' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '呀' } },
        ]) as never,
    )
    const deltas: string[] = []
    for await (const delta of adapter.chat(
      [
        { role: 'system', content: '你是白泽' },
        { role: 'user', content: 'hi' },
      ],
      baseOptions,
    )) {
      deltas.push(delta.text)
    }
    expect(deltas.join('')).toBe('早上好呀')
    expect(capturedParams?.system).toBe('你是白泽')
    expect(capturedParams?.messages).toHaveLength(1)
  })

  it('translates 401 into a friendly error without leaking the key', async () => {
    const adapter = new AnthropicAdapter(() => {
      throw Object.assign(new Error(`bad key ${FAKE_KEY}`), { status: 401 })
    })
    const error = await adapter
      .chat([{ role: 'user', content: 'hi' }], baseOptions)
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e)
    expect((error as LlmError).status).toBe(401)
    expect((error as LlmError).message).toContain('API key')
    expect((error as LlmError).message).not.toContain(FAKE_KEY)
  })

  it('reports usage tokens from stream events', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
    ]
    const adapter = new AnthropicAdapter(
      () =>
        ({
          messages: {
            stream: () => {
              const streamEventHandler = { fn: (_event: Record<string, unknown>) => {} }
              return {
                async *[Symbol.asyncIterator]() {
                  for (const event of events) {
                    // The real SDK notifies streamEvent listeners for every event.
                    streamEventHandler.fn(event)
                    yield event
                  }
                },
                on(_event: string, handler: (event: Record<string, unknown>) => void) {
                  streamEventHandler.fn = handler
                },
              }
            },
          },
        }) as never,
    )
    let tokens: number | undefined
    for await (const delta of adapter.chat([{ role: 'user', content: 'x' }], baseOptions)) {
      if (delta.totalTokens !== undefined) tokens = delta.totalTokens
    }
    expect(tokens).toBe(17)
  })
})
