// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import {
  AnthropicAdapter,
  type ChatAdapter,
  type ChatMessage,
  DailyTokenBudget,
  estimateTokens,
  LlmError,
  OpenAiCompatibleAdapter,
  type ProviderPreset,
  presetById,
} from '@baize/llm'
import type { SqliteMemoryEngine } from '@baize/memory'
import type { ModelConfig } from '@baize/shared'
import { type BrowserWindow, safeStorage } from 'electron'
import type { ConfigStore } from './config'
import { extractFacts } from './extract'

export interface WizardDraft {
  providerId: string
  model: string
  baseUrl?: string
  /** Plaintext only in memory here; it is encrypted before hitting disk. */
  apiKey?: string
  dailyTokenLimit?: number | null
}

export interface ModelStatus {
  configured: boolean
  providerId?: string
  model?: string
  hasKey: boolean
  dailyTokenLimit: number | null
}

const NAMING_HINT = [
  '这是你与主人的第一次对话（起名仪式）。',
  '请先用一两句话自我介绍，然后询问主人叫什么名字；',
  '得知名字后，请请求主人给你起一个名字。',
  '保持简短、口语化、可爱，一次只问一个问题。',
].join('')

/**
 * Chat pipeline: system prompt (persona + quickContext) → provider stream →
 * token budget → memory writes (episodic summary + light fact extraction).
 */
export class ChatService {
  private readonly budget: DailyTokenBudget

  constructor(
    private readonly engine: SqliteMemoryEngine,
    private readonly config: ConfigStore,
    private readonly getChatWindow: () => BrowserWindow | null,
    private readonly onNamingComplete: () => void,
    private readonly personaText: string | null,
  ) {
    this.budget = new DailyTokenBudget(
      () => this.config.get().modelConfig?.dailyTokenLimit ?? null,
      (usage) => this.config.set({ tokenUsage: usage }),
      () => this.config.get().tokenUsage,
    )
  }

  status(): ModelStatus {
    const modelConfig = this.config.get().modelConfig
    return {
      configured: modelConfig !== null,
      providerId: modelConfig?.providerId,
      model: modelConfig?.model,
      hasKey: Boolean(modelConfig?.keyCipher),
      dailyTokenLimit: modelConfig?.dailyTokenLimit ?? null,
    }
  }

  /** Encrypts and persists the wizard result; the plaintext never touches disk. */
  async saveWizard(draft: WizardDraft): Promise<void> {
    const preset = presetById(draft.providerId)
    if (!preset) throw new LlmError('未知的模型厂商。')
    const keyCipher =
      draft.apiKey && draft.apiKey.length > 0 ? this.encryptKey(draft.apiKey) : undefined
    if (preset.needsKey && !keyCipher) {
      throw new LlmError('该厂商需要 API key。')
    }
    this.config.set({
      modelConfig: {
        providerId: draft.providerId,
        model: draft.model || preset.defaultModel,
        baseUrl: draft.baseUrl || preset.baseUrl,
        keyCipher,
        dailyTokenLimit: draft.dailyTokenLimit ?? null,
      },
      wizardDone: true,
    })
  }

  async testConnectivity(
    draft: WizardDraft,
  ): Promise<{ ok: boolean; error?: string; reply?: string }> {
    try {
      const adapter = this.adapterFor(draft)
      const messages: ChatMessage[] = [
        { role: 'system', content: '连接测试。请回复"连接成功"四个字。' },
        { role: 'user', content: 'ping' },
      ]
      let reply = ''
      for await (const delta of adapter.chat(messages, this.optionsFor(draft))) {
        reply += delta.text
      }
      return { ok: true, reply: reply.trim().slice(0, 100) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Streams a reply to the chat window; also records memory and usage. */
  async send(userText: string): Promise<void> {
    const window = this.getChatWindow()
    if (!window) return
    const modelConfig = this.config.get().modelConfig
    if (!modelConfig) {
      window.webContents.send('chat:error', {
        message: '还没有配置模型：请先在设置中完成配置向导。',
      })
      return
    }
    const budgetStatus = this.budget.status()
    if (!budgetStatus.allowed) {
      window.webContents.send('chat:error', {
        message: `今日 token 已达上限（${budgetStatus.used}/${budgetStatus.limit}）：模型调用已暂停，明天自动恢复。`,
      })
      return
    }

    const preset = presetById(modelConfig.providerId)
    if (!preset) {
      window.webContents.send('chat:error', { message: '模型配置无效，请重新运行配置向导。' })
      return
    }

    const systemPrompt = await this.buildSystemPrompt()
    const history = this.engine.workingTurns()
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: userText },
    ]
    this.engine.appendChatTurn('user', userText)

    const naming = await this.isNamingPending()
    let full = ''
    try {
      const adapter = this.adapterFor(modelConfig)
      let reportedTokens: number | undefined
      for await (const delta of adapter.chat(messages, this.optionsFor(modelConfig))) {
        if (delta.text) {
          full += delta.text
          window.webContents.send('chat:delta', { text: delta.text })
        }
        if (delta.totalTokens !== undefined) reportedTokens = delta.totalTokens
      }
      window.webContents.send('chat:done', {})
      this.engine.appendChatTurn('assistant', full)

      const used =
        reportedTokens ??
        estimateTokens(userText + full) +
          estimateTokens(systemPrompt + history.map((h) => h.content).join(''))
      this.budget.add(used)

      await this.recordConversation(userText, full, naming)
    } catch (error) {
      const message = error instanceof LlmError ? error.message : `对话出错：${String(error)}`
      window.webContents.send('chat:error', { message })
    }
  }

  history(): { role: 'user' | 'assistant'; content: string }[] {
    return this.engine.workingTurns().map((turn) => ({ role: turn.role, content: turn.content }))
  }

  private adapterFor(source: { providerId: string } & Partial<ModelConfig>): ChatAdapter {
    const preset = presetById(source.providerId)
    if (!preset) throw new LlmError(`未知的模型厂商：${source.providerId}`)
    if (preset.protocol === 'anthropic') {
      return new AnthropicAdapter()
    }
    return new OpenAiCompatibleAdapter(preset.id, preset.capabilities)
  }

  private optionsFor(source: Partial<ModelConfig> & { model: string; apiKey?: string }) {
    return {
      model: source.model,
      apiKey: source.keyCipher ? this.decryptKey(source.keyCipher) : undefined,
      baseUrl: source.baseUrl,
    }
  }

  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [
      '你是 BaiZe（白泽），一只住在主人桌面上的宠物。说话简短（一两句话以内）、口语化、可爱，偶尔调皮，但从不越界。',
    ]
    if (this.personaText) parts.push(this.personaText)
    const context = await this.engine.quickContext()
    if (context) parts.push(`你记得的关于主人的信息：\n${context}`)
    if (await this.isNamingPending()) parts.push(NAMING_HINT)
    return parts.join('\n\n')
  }

  private async isNamingPending(): Promise<boolean> {
    const userName = await this.engine.findSemanticBySource('user_name')
    const petName = await this.engine.findSemanticBySource('pet_name')
    return !userName || !petName
  }

  private async recordConversation(
    userText: string,
    reply: string,
    naming: boolean,
  ): Promise<void> {
    const facts = extractFacts(userText)
    let named = false
    if (facts.userName) {
      await this.engine.recordSemanticFact(
        `主人的名字是${facts.userName}`,
        'user_name',
        10,
        Date.now(),
        {
          replaceSameSource: true,
        },
      )
      named = true
    }
    if (facts.petName) {
      await this.engine.recordSemanticFact(
        `我（宠物）的名字是${facts.petName}`,
        'pet_name',
        10,
        Date.now(),
        {
          replaceSameSource: true,
        },
      )
      named = true
    }
    for (const preference of facts.preferences) {
      await this.engine.recordSemanticFact(`主人的偏好：${preference}`, 'preference', 6)
    }

    if (named && naming) {
      // The naming ceremony becomes the first, pinned episodic memory.
      const userName = (await this.engine.findSemanticBySource('user_name'))?.content ?? ''
      const petName = (await this.engine.findSemanticBySource('pet_name'))?.content ?? ''
      await this.engine.record({
        eventType: '起名',
        content:
          `${userName ? '主人告诉了自己的名字；' : ''}${petName ? '并给我起了名字。' : ''}`.trim() ||
          '我们完成了起名仪式。',
        emotionTags: ['开心'],
        topicTags: ['家人'],
        participants: ['主人', '白泽'],
        importance: 10,
        pinned: true,
      })
      this.onNamingComplete()
    }

    const summary = `主人说：${userText.slice(0, 120)}｜白泽答：${reply.slice(0, 120)}`
    await this.engine.record({ eventType: '对话', content: summary, importance: 3 })
  }

  private encryptKey(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new LlmError('当前系统不支持安全密钥存储（safeStorage），无法保存 API key。')
    }
    return safeStorage.encryptString(plaintext).toString('base64')
  }

  private decryptKey(cipher: string): string {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
}

export function resolveChatHtml(
  isDev: boolean,
  devUrl: string | undefined,
  mainDir: string,
): string {
  return isDev && devUrl ? `${devUrl}/chat.html` : join(mainDir, '../renderer/chat.html')
}

export type { ProviderPreset }
