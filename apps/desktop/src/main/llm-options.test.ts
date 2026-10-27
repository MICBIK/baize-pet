// SPDX-License-Identifier: AGPL-3.0-only

import { presetById } from '@baize/llm'
import { describe, expect, it } from 'vitest'
import { adapterFor, optionsFor, withSavedKeyFallback } from './llm-options'

describe('optionsFor', () => {
  it('sends the wizard draft plaintext key and the preset base URL (P0-3)', () => {
    const preset = presetById('deepseek')
    const options = optionsFor({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    })
    expect(options.apiKey).toBe('sk-test')
    expect(options.baseUrl).toBe(preset?.baseUrl)
    expect(options.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('prefers the draft baseUrl over the preset default', () => {
    const options = optionsFor({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    expect(options.baseUrl).toBe('http://127.0.0.1:9/v1')
  })

  it('falls back to the saved ciphertext when the draft has no plaintext key', () => {
    const decrypt = (cipher: string): string => `decrypted:${cipher}`
    const options = optionsFor(
      { providerId: 'deepseek', model: 'deepseek-chat', keyCipher: 'Q0lQSEVS' },
      decrypt,
    )
    expect(options.apiKey).toBe('decrypted:Q0lQSEVS')
  })

  it('prefers the draft plaintext key over the saved ciphertext', () => {
    const options = optionsFor(
      {
        providerId: 'kimi',
        model: 'kimi-k2-turbo-preview',
        apiKey: 'sk-new',
        keyCipher: 'Q0lQSEVS',
      },
      () => 'decrypted',
    )
    expect(options.apiKey).toBe('sk-new')
  })

  it('leaves the key undefined for keyless runtimes (Ollama)', () => {
    const options = optionsFor({ providerId: 'ollama', model: 'llama3.2' })
    expect(options.apiKey).toBeUndefined()
    expect(options.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('throws a readable error for an unknown provider', () => {
    expect(() => optionsFor({ providerId: 'nope', model: 'm' })).toThrow('未知的模型厂商：nope')
  })
})

describe('withSavedKeyFallback', () => {
  it('reuses the stored key for the same provider when the draft has none', () => {
    const source = withSavedKeyFallback(
      { providerId: 'deepseek', model: 'deepseek-chat' },
      { providerId: 'deepseek', keyCipher: 'Q0lQSEVS' },
    )
    expect(source.keyCipher).toBe('Q0lQSEVS')
  })

  it('never reuses a key saved for a different provider', () => {
    const source = withSavedKeyFallback(
      { providerId: 'glm', model: 'glm-4-flash' },
      { providerId: 'deepseek', keyCipher: 'Q0lQSEVS' },
    )
    expect(source.keyCipher).toBeUndefined()
  })

  it('prefers a freshly typed key over the stored ciphertext', () => {
    const source = withSavedKeyFallback(
      { providerId: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-new' },
      { providerId: 'deepseek', keyCipher: 'Q0lQSEVS' },
    )
    expect(source.keyCipher).toBeUndefined()
    expect(source.apiKey).toBe('sk-new')
  })
})

describe('adapterFor', () => {
  it('returns the Anthropic adapter for the anthropic protocol', () => {
    expect(adapterFor('anthropic').id).toBe('anthropic')
  })

  it('returns an OpenAI-compatible adapter carrying the preset capabilities', () => {
    const adapter = adapterFor('deepseek')
    expect(adapter.id).toBe('deepseek')
    expect(adapter.capabilities()).toEqual(presetById('deepseek')?.capabilities)
  })

  it('throws a readable error for an unknown provider', () => {
    expect(() => adapterFor('nope')).toThrow('未知的模型厂商：nope')
  })
})
