// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  BehaviorHistory,
  BehaviorSelector,
  type CandidateAction,
  canInterrupt,
  DEFAULT_BEHAVIOR_CONFIG,
  INTERRUPT_PRIORITY,
  mulberry32,
  type SceneContext,
  type SceneRule,
} from './behavior'
import { DEFAULT_EMOTION_PARAMS, EmotionState, type EmotionVector } from './emotion'

const emotionOf = (partial: Partial<EmotionVector>): EmotionVector => ({
  happy: 0.5,
  bored: 0.2,
  angry: 0,
  miss: 0.1,
  ...partial,
})

const baseContext = (): SceneContext => ({
  now: new Date('2026-10-26T14:00:00'),
  emotion: emotionOf({}),
  recentEvents: [],
  lastAction: null,
  lastActionAt: undefined,
  consecutiveCount: 0,
  recentActionCounts: new Map(),
  activeInteraction: null,
})

const twoCandidateRule: SceneRule = {
  id: 'test-scene',
  match: () => true,
  candidates: (): CandidateAction[] => [
    { action: 'rare', baseWeight: 1 },
    { action: 'common', baseWeight: 3 },
  ],
}

describe('canInterrupt', () => {
  it('follows the documented priority: drag > chat > spontaneous', () => {
    expect(INTERRUPT_PRIORITY).toEqual({ drag: 3, chat: 2, spontaneous: 1 })
    expect(canInterrupt('spontaneous', 'chat')).toBe(true)
    expect(canInterrupt('spontaneous', 'drag')).toBe(true)
    expect(canInterrupt('chat', 'drag')).toBe(true)
    expect(canInterrupt('chat', 'spontaneous')).toBe(false)
    expect(canInterrupt('drag', 'chat')).toBe(false)
    expect(canInterrupt('drag', 'drag')).toBe(false)
  })
})

describe('BehaviorSelector', () => {
  it('is deterministic for a seeded random source', () => {
    const run = (seed: number): string | null => {
      const selector = new BehaviorSelector(
        [twoCandidateRule],
        DEFAULT_BEHAVIOR_CONFIG,
        mulberry32(seed),
      )
      const pick = selector.pick(baseContext())
      return pick?.action ?? null
    }
    expect(run(42)).toBe(run(42))
  })

  it('draws according to utility weights across 100 runs (soft-max, temperature 1)', () => {
    const selector = new BehaviorSelector(
      [twoCandidateRule],
      { ...DEFAULT_BEHAVIOR_CONFIG, temperature: 1, cooldownMs: 0 },
      mulberry32(7),
    )
    const counts = { rare: 0, common: 0 }
    for (let i = 0; i < 100; i++) {
      const pick = selector.pick(baseContext())
      expect(pick).not.toBeNull()
      counts[pick?.action === 'common' ? 'common' : 'rare']++
    }
    // p(common) = e^3 / (e^1 + e^3) ≈ 0.953 — allow generous CI bounds for randomness.
    expect(counts.common).toBeGreaterThanOrEqual(85)
    expect(counts.rare).toBeGreaterThanOrEqual(1)
  })

  it('flattens the distribution at a high temperature', () => {
    const selector = new BehaviorSelector(
      [twoCandidateRule],
      { ...DEFAULT_BEHAVIOR_CONFIG, temperature: 50, cooldownMs: 0 },
      mulberry32(7),
    )
    const counts = { rare: 0, common: 0 }
    for (let i = 0; i < 100; i++) {
      counts[selector.pick(baseContext())?.action === 'common' ? 'common' : 'rare']++
    }
    // Weight ratio e^(3/50) ≈ 1.06 — nearly even, the weaker action must appear often.
    expect(counts.rare).toBeGreaterThanOrEqual(30)
  })

  it('never exceeds maxConsecutive back-to-back runs of one action in 100 picks', () => {
    const config = { ...DEFAULT_BEHAVIOR_CONFIG, cooldownMs: 0, maxConsecutive: 2 }
    const selector = new BehaviorSelector([twoCandidateRule], config, mulberry32(123))
    const history = new BehaviorHistory()
    let consecutive = 0
    let maxConsecutiveSeen = 0
    for (let i = 0; i < 100; i++) {
      const pick = selector.pick({
        ...baseContext(),
        ...history.snapshot(config.recencyWindowMs, i * 1000),
      })
      expect(pick).not.toBeNull()
      consecutive = pick?.action === history.snapshot(0, i * 1000).lastAction ? consecutive + 1 : 1
      maxConsecutiveSeen = Math.max(maxConsecutiveSeen, consecutive)
      history.record(pick?.action ?? '', i * 1000)
    }
    expect(maxConsecutiveSeen).toBeLessThanOrEqual(2)
  })

  it('still picks an action when every candidate is excluded by maxConsecutive', () => {
    // A single-candidate pack used to deadlock: after maxConsecutive repeats the
    // candidate was excluded forever, pick() returned null and history froze.
    const napOnly: SceneRule = {
      id: 'nap',
      match: () => true,
      candidates: () => [{ action: 'idle_nap', baseWeight: 1 }],
    }
    const config = { ...DEFAULT_BEHAVIOR_CONFIG, cooldownMs: 0, maxConsecutive: 2 }
    const selector = new BehaviorSelector([napOnly], config, mulberry32(5))
    const history = new BehaviorHistory()
    for (let i = 0; i < 5; i++) {
      const pick = selector.pick({
        ...baseContext(),
        ...history.snapshot(config.recencyWindowMs, i * 1000),
      })
      expect(pick).not.toBeNull()
      expect(pick?.action).toBe('idle_nap')
      history.record(pick?.action ?? '', i * 1000)
    }
    expect(history.snapshot(config.recencyWindowMs, 10_000).consecutiveCount).toBe(5)
  })

  it('respects the cooldown between spontaneous picks', () => {
    let clock = 10_000
    const selector = new BehaviorSelector(
      [twoCandidateRule],
      { ...DEFAULT_BEHAVIOR_CONFIG, cooldownMs: 60_000 },
      mulberry32(1),
      () => clock,
    )
    const context = { ...baseContext(), lastActionAt: 10_000 }
    expect(selector.pick(context)).toBeNull()
    clock = 70_000
    expect(selector.pick({ ...context, lastActionAt: 10_000 })).not.toBeNull()
  })

  it('blocks spontaneous picks during a drag (interrupt priority)', () => {
    const selector = new BehaviorSelector(
      [twoCandidateRule],
      DEFAULT_BEHAVIOR_CONFIG,
      mulberry32(1),
    )
    const context = { ...baseContext(), activeInteraction: 'drag' as const }
    expect(selector.pick(context)).toBeNull()
  })

  it('honors hour ranges including midnight wrap', () => {
    const nightRule: SceneRule = {
      id: 'night',
      match: () => true,
      candidates: () => [{ action: 'sleep_pose', baseWeight: 5, hourRange: [22, 6] }],
    }
    const selector = new BehaviorSelector(
      [nightRule],
      { ...DEFAULT_BEHAVIOR_CONFIG, cooldownMs: 0 },
      mulberry32(1),
    )
    const at = (hour: number) => ({ ...baseContext(), now: new Date(2026, 9, 26, hour, 0, 0) })
    expect(selector.pick(at(23))?.action).toBe('sleep_pose')
    expect(selector.pick(at(2))?.action).toBe('sleep_pose')
    expect(selector.pick(at(14))).toBeNull()
  })

  it('scales utility with emotion affinity', () => {
    const mischievous: SceneRule = {
      id: 'mood',
      match: () => true,
      candidates: () => [{ action: 'mischief', baseWeight: 1, emotionAffinity: { happy: 4 } }],
    }
    const selector = new BehaviorSelector(
      [mischievous],
      { ...DEFAULT_BEHAVIOR_CONFIG, temperature: 0.5, cooldownMs: 0 },
      mulberry32(1),
    )
    // affinity 4 × happy 1 → utility 5, far above temperature → always picked.
    expect(selector.pick({ ...baseContext(), emotion: emotionOf({ happy: 1 }) })?.action).toBe(
      'mischief',
    )
  })

  it('returns null when no rule matches', () => {
    const never: SceneRule = { id: 'never', match: () => false, candidates: () => [] }
    const selector = new BehaviorSelector([never], DEFAULT_BEHAVIOR_CONFIG, mulberry32(1))
    expect(selector.pick(baseContext())).toBeNull()
  })
})

describe('BehaviorHistory', () => {
  it('counts consecutive runs and recent window occurrences', () => {
    const history = new BehaviorHistory()
    history.record('a', 0)
    history.record('a', 1000)
    history.record('b', 2000)
    const snap = history.snapshot(10_000, 2000)
    expect(snap.lastAction).toBe('b')
    expect(snap.consecutiveCount).toBe(1)
    expect(snap.recentActionCounts.get('a')).toBe(2)
    expect(snap.recentActionCounts.get('b')).toBe(1)
  })

  it('drops entries outside the recency window', () => {
    const history = new BehaviorHistory()
    history.record('a', 0)
    history.record('b', 60_000)
    const snap = history.snapshot(30_000, 60_000)
    expect(snap.recentActionCounts.has('a')).toBe(false)
    expect(snap.recentActionCounts.get('b')).toBe(1)
  })
})

describe('EmotionState', () => {
  it('decays happy and grows boredom/anger/miss over idle time', () => {
    const state = new EmotionState({ happy: 0.8, bored: 0.2, angry: 0, miss: 0.1 })
    state.decay(3_600_000, DEFAULT_EMOTION_PARAMS)
    const v = state.value
    expect(v.happy).toBeCloseTo(0.8 - DEFAULT_EMOTION_PARAMS.rates.happy, 5)
    expect(v.bored).toBeCloseTo(0.2 + DEFAULT_EMOTION_PARAMS.rates.bored, 5)
    expect(v.angry).toBeCloseTo(DEFAULT_EMOTION_PARAMS.rates.angry, 5)
    expect(v.miss).toBeCloseTo(0.1 + DEFAULT_EMOTION_PARAMS.rates.miss, 5)
  })

  it('clamps values to [0, 1]', () => {
    const state = new EmotionState({ happy: 1 })
    state.decay(10_000 * 3_600_000, DEFAULT_EMOTION_PARAMS)
    expect(state.value.happy).toBe(0)
    state.apply('drag', DEFAULT_EMOTION_PARAMS)
    const v = state.value
    for (const value of Object.values(v)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(v.happy).toBe(DEFAULT_EMOTION_PARAMS.gains.drag.happy)
  })

  it('accumulates interaction gains per interaction type', () => {
    const state = new EmotionState({ happy: 0.5, bored: 0.5, miss: 0.5 })
    state.apply('chat', DEFAULT_EMOTION_PARAMS)
    const v = state.value
    expect(v.happy).toBeCloseTo(0.65, 5)
    expect(v.bored).toBeCloseTo(0.2, 5)
    expect(v.miss).toBeCloseTo(0.1, 5)
    // No angry gain configured for chat.
    expect(v.angry).toBe(0)
  })

  it('applies custom parameters from a character pack', () => {
    const state = new EmotionState({ happy: 0.4 })
    state.apply('click', {
      rates: DEFAULT_EMOTION_PARAMS.rates,
      gains: { click: { happy: 0.5 }, drag: {}, chat: {} },
    })
    expect(state.value.happy).toBeCloseTo(0.9, 5)
  })
})

describe('PresetLinePool', () => {
  it('draws lines per scene and returns null for empty scenes', async () => {
    const { PresetLinePool } = await import('./lines')
    const pool = new PresetLinePool({ click: ['哎哟！', '别戳啦～'], drag: [] }, mulberry32(3))
    const emotion = new EmotionState().value
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const line = pool.line('click', emotion)
      expect(line).not.toBeNull()
      seen.add(line ?? '')
    }
    expect(seen.size).toBe(2)
    expect(pool.line('drag', emotion)).toBeNull()
    expect(pool.line('unknown-scene', emotion)).toBeNull()
  })
})
