// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, presetById } from './presets'
import { DailyTokenBudget, estimateTokens, todayKey, type UsageRecord } from './usage'

describe('PROVIDER_PRESETS', () => {
  it('covers the providers required by docs/07 M4', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual(
      expect.arrayContaining(['deepseek', 'glm', 'kimi', 'minimax', 'ollama', 'anthropic']),
    )
  })

  it('uses only https endpoints except the local Ollama runtime', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'ollama') {
        expect(preset.baseUrl).toMatch(/^http:\/\/localhost:\d+/)
      } else {
        expect(preset.baseUrl.startsWith('https://')).toBe(true)
      }
      if (preset.needsKey) {
        expect(preset.keyUrl?.startsWith('https://')).toBe(true)
      } else {
        expect(preset.keyUrl).toBeNull()
      }
    }
  })

  it('looks up presets by id', () => {
    expect(presetById('deepseek')?.defaultModel).toBe('deepseek-chat')
    expect(presetById('nope')).toBeNull()
  })
})

describe('DailyTokenBudget', () => {
  it('allows unlimited usage when no limit is configured', () => {
    let stored: UsageRecord | null = { date: todayKey(), used: 100_000 }
    const budget = new DailyTokenBudget(
      () => null,
      (usage) => {
        stored = usage
      },
      () => stored,
    )
    expect(budget.status().allowed).toBe(true)
  })

  it('blocks calls once the daily limit is reached and rolls over by date', () => {
    let stored: UsageRecord | null = { date: todayKey(), used: 950 }
    const budget = new DailyTokenBudget(
      () => 1000,
      (usage) => {
        stored = usage
      },
      () => stored,
    )
    expect(budget.status().allowed).toBe(true)
    expect(budget.status().used).toBe(950)

    budget.add(100)
    expect(budget.status().allowed).toBe(false)
    expect(budget.status().used).toBe(1050)

    // Next day: usage resets.
    stored = { date: '2020-01-01', used: 999_999 }
    expect(budget.status().allowed).toBe(true)
    expect(budget.status().used).toBe(0)
  })

  it('estimates tokens conservatively for CJK text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcdefgh')).toBe(4)
    expect(estimateTokens('你好世界，主人！')).toBe(4)
  })
})
