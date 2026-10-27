// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderCapabilities } from './types'

export type ProviderId = 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'ollama' | 'anthropic' | 'custom'

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
 * Curated OpenAI-compatible endpoints (docs/07 M4) plus the Anthropic adapter
 * and a fully custom OpenAI-compatible option. The user can always override
 * baseUrl and model in the wizard. Default models were re-checked 2026-10 —
 * uncertain exact IDs are tracked in docs/open-questions.md (#5, #9).
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
    defaultModel: 'glm-4.7',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: false },
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-latest',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: false },
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-M2.5',
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
    defaultModel: 'claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    capabilities: { streaming: true, tools: true, images: true },
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    protocol: 'openai-compatible',
    /** Empty by design: the wizard requires the user to enter the endpoint. */
    baseUrl: '',
    defaultModel: '',
    keyUrl: null,
    needsKey: false,
    capabilities: { streaming: true, tools: true, images: false },
  },
]

export function presetById(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null
}
