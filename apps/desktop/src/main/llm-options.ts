// SPDX-License-Identifier: AGPL-3.0-only
import {
  AnthropicAdapter,
  type ChatAdapter,
  type ChatOptions,
  LlmError,
  OpenAiCompatibleAdapter,
  presetById,
} from '@baize/llm'

/**
 * Model source: either a wizard draft (plaintext key, optional baseUrl override)
 * or a saved ModelConfig (encrypted key). Kept pure (no Electron imports) so the
 * key/baseUrl resolution is unit-testable.
 */
export interface ModelOptionsSource {
  providerId: string
  model: string
  /** User override of the provider endpoint (wizard "custom service" input). */
  baseUrl?: string
  /** Plaintext key straight from the wizard draft — highest precedence. */
  apiKey?: string
  /** safeStorage ciphertext from a saved config — used when no plaintext key is given. */
  keyCipher?: string
}

export function adapterFor(providerId: string): ChatAdapter {
  const preset = presetById(providerId)
  if (!preset) throw new LlmError(`未知的模型厂商：${providerId}`)
  if (preset.protocol === 'anthropic') {
    return new AnthropicAdapter()
  }
  return new OpenAiCompatibleAdapter(preset.id, preset.capabilities)
}

/**
 * Attaches the stored ciphertext to a wizard draft when the draft carries no
 * plaintext key and the saved config is for the same provider. Without this, a
 * re-run of the wizard that only changes the model would fail test/save.
 */
export function withSavedKeyFallback<D extends { providerId: string; apiKey?: string }>(
  draft: D,
  saved: { providerId: string; keyCipher?: string } | null | undefined,
): D & { keyCipher?: string } {
  if (
    (!draft.apiKey || draft.apiKey.length === 0) &&
    saved &&
    saved.providerId === draft.providerId &&
    saved.keyCipher
  ) {
    return { ...draft, keyCipher: saved.keyCipher }
  }
  return { ...draft }
}

/**
 * Resolves the chat options for a wizard draft or saved config.
 * Key precedence: draft plaintext apiKey → saved ciphertext (decrypted via the
 * callback). Base URL precedence: draft override → provider preset default —
 * without this fallback the OpenAI SDK silently targets api.openai.com.
 */
export function optionsFor(
  source: ModelOptionsSource,
  decryptKey?: (cipher: string) => string,
): ChatOptions {
  const preset = presetById(source.providerId)
  if (!preset) throw new LlmError(`未知的模型厂商：${source.providerId}`)
  const apiKey =
    source.apiKey && source.apiKey.length > 0
      ? source.apiKey
      : source.keyCipher && decryptKey
        ? decryptKey(source.keyCipher)
        : undefined
  const baseUrl = source.baseUrl && source.baseUrl.length > 0 ? source.baseUrl : preset.baseUrl
  return { model: source.model, apiKey, baseUrl }
}
