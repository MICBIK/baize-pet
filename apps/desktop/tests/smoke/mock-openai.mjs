// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal OpenAI-compatible mock for the smoke test: streams an SSE chat
 * completion exactly like the real endpoints (chat.completions with
 * stream_options.include_usage) and records every request for assertions.
 */
import { createServer } from 'node:http'

const REPLY = '你好呀，主人！'

export function createMockOpenAi() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization ?? null,
        contentType: request.headers['content-type'] ?? null,
        body: body ? JSON.parse(body) : null,
      })
      if (request.method !== 'POST' || !request.url?.includes('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      // Two text deltas (exercises streaming aggregation) + one usage chunk.
      const chunks = [
        { choices: [{ delta: { content: REPLY.slice(0, 3) }, index: 0 }] },
        { choices: [{ delta: { content: REPLY.slice(3) }, index: 0 }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } },
      ]
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  return { server, requests, REPLY }
}

export function startMockOpenAi() {
  const mock = createMockOpenAi()
  const port = new Promise((resolveListen, reject) => {
    mock.server.once('error', reject)
    mock.server.listen(0, '127.0.0.1', () => resolveListen(mock.server.address().port))
  })
  return { ...mock, baseUrl: port.then((port) => `http://127.0.0.1:${port}/v1`) }
}

export function stopMockOpenAi(mock) {
  return new Promise((resolveClose) => mock.server.close(resolveClose))
}
