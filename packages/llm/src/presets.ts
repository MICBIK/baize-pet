// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderCapabilities } from './types'

export type ProviderId = 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'ollama' | 'anthropic'

export interface ProviderPreset {
  id: ProviderId
  label: string
  protocol: 'openai-compatible' | 'anthropic'
  baseUrl: string
  defaultModel: string
  /** Official page where the user obtains an API key (null for local runtimes). */
  keyUrl: string | null
  needsKey: boolean
  capabilities: ProviderCapabilities
}

/**
 * Curated OpenAI-compatible endpoints (docs/07 M4) plus the Anthropic adapter.
 * The user can always override baseUrl and model in the wizard.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: false },
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: false },
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: false },
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    needsKey: true,
    capabilities: { streaming: true, tools: false, images: false },
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    keyUrl: null,
    needsKey: false,
    capabilities: { streaming: true, tools: false, images: false },
  },
  {
    id: 'anthropic',
    label: 'Claude（Anthropic）',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: true },
  },
]

export function presetById(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null
}
