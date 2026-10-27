// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import {
  type ChatMessage,
  DailyTokenBudget,
  estimateTokens,
  LlmError,
  type ProviderPreset,
  presetById,
} from '@baize/llm'
import type { SqliteMemoryEngine } from '@baize/memory'
import { type BrowserWindow, safeStorage } from 'electron'
import type { ConfigStore } from './config'
import { extractFacts } from './extract'
import { adapterFor, optionsFor, withSavedKeyFallback } from './llm-options'

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
    if (draft.baseUrl && !/^https?:\/\//i.test(draft.baseUrl.trim())) {
      throw new LlmError('服务地址必须以 http:// 或 https:// 开头。')
    }
    if (preset.id === 'custom') {
      if (!draft.baseUrl || draft.baseUrl.trim().length === 0) {
        throw new LlmError('请填写自定义服务的地址（Base URL）。')
      }
      if (!draft.model || draft.model.trim().length === 0) {
        throw new LlmError('请填写自定义服务的模型名。')
      }
    }
    // Re-entering the wizard and changing only the model keeps the stored key:
    // the draft carries no plaintext, so the ciphertext is reused when the
    // provider is unchanged.
    const keyCipher =
      draft.apiKey && draft.apiKey.length > 0
        ? this.encryptKey(draft.apiKey)
        : withSavedKeyFallback(draft, this.config.get().modelConfig).keyCipher
    if (preset.needsKey && !keyCipher) {
      throw new LlmError('该厂商需要 API key。')
    }
    const model = draft.model?.trim() || preset.defaultModel
    if (!model) throw new LlmError('请填写模型名。')
    this.config.set({
      modelConfig: {
        providerId: draft.providerId,
        model,
        baseUrl: draft.baseUrl?.trim() || preset.baseUrl,
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
      // A re-run of the wizard may not retype the key: fall back to the stored
      // one when the provider is unchanged (the draft never carries ciphertext).
      const source = withSavedKeyFallback(draft, this.config.get().modelConfig)
      const adapter = adapterFor(draft.providerId)
      const messages: ChatMessage[] = [
        { role: 'system', content: '连接测试。请回复"连接成功"四个字。' },
        { role: 'user', content: 'ping' },
      ]
      let reply = ''
      for await (const delta of adapter.chat(
        messages,
        optionsFor(source, (cipher) => this.decryptKey(cipher)),
      )) {
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
      const adapter = adapterFor(modelConfig.providerId)
      let reportedTokens: number | undefined
      for await (const delta of adapter.chat(
        messages,
        optionsFor(modelConfig, (cipher) => this.decryptKey(cipher)),
      )) {
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

  private async buildSystemPrompt(): Promise<string> {
    // Once the user has named the pet, the intro must use that name, not the
    // pack's default "BaiZe".
    const petName = (await this.engine.findSemanticBySource('pet_name'))?.content
    const intro = petName
      ? `你是${petName}（主人给你起的名字），一只住在主人桌面上的宠物。说话简短（一两句话以内）、口语化、可爱，偶尔调皮，但从不越界。`
      : '你是 BaiZe（白泽），一只住在主人桌面上的宠物。说话简短（一两句话以内）、口语化、可爱，偶尔调皮，但从不越界。'
    const parts: string[] = [intro]
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
    }
    for (const preference of facts.preferences) {
      await this.engine.recordSemanticFact(`主人的偏好：${preference}`, 'preference', 6)
    }

    if (naming) {
      // The ceremony completes only when BOTH names are on record — the two
      // halves may arrive in separate turns. Until then no episodic "起名"
      // entry is written; once both exist this branch never re-runs (the
      // conversation is no longer naming-pending), so it records exactly once.
      const userNameFact = await this.engine.findSemanticBySource('user_name')
      const petNameFact = await this.engine.findSemanticBySource('pet_name')
      if (userNameFact && petNameFact) {
        await this.engine.record({
          eventType: '起名',
          content: `主人告诉了自己的名字（${userNameFact.content}），并给我起了名字（${petNameFact.content}）。`,
          emotionTags: ['开心'],
          topicTags: ['家人'],
          participants: ['主人', petNameFact.content],
          importance: 10,
          pinned: true,
        })
        this.onNamingComplete()
      }
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
