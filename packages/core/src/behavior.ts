// SPDX-License-Identifier: AGPL-3.0-only
import type { EmotionVector, InteractionType } from './emotion'
import type { PetEvent } from './event-bus'

/**
 * Spontaneous-action selection: scene rules narrow the candidate list, each
 * candidate is scored (utility = base weight × emotion affinity × repetition
 * penalty) and one is drawn with a softmax over the scores. The temperature
 * comes from configuration so a personality's randomness is tunable.
 *
 * Interrupt priority (user drag > chat > spontaneous) is a pure function here.
 */
export type InterruptSource = 'drag' | 'chat' | 'spontaneous'

/** Higher wins; an incoming source may interrupt a current one of lower rank. */
export const INTERRUPT_PRIORITY: Record<InterruptSource, number> = {
  drag: 3,
  chat: 2,
  spontaneous: 1,
}

export function canInterrupt(current: InterruptSource, incoming: InterruptSource): boolean {
  return INTERRUPT_PRIORITY[incoming] > INTERRUPT_PRIORITY[current]
}

export interface SceneContext {
  now: Date
  emotion: EmotionVector
  /** Recently published events, newest first. */
  recentEvents: PetEvent[]
  /** Action chosen last time (null on startup). */
  lastAction: string | null
  /** Epoch ms of the last spontaneous action (undefined on startup). */
  lastActionAt: number | undefined
  /** How many times in a row the last action has been picked. */
  consecutiveCount: number
  /** How often each action ran inside the recency window. */
  recentActionCounts: Map<string, number>
  /** The interaction currently in progress, if any. */
  activeInteraction: InteractionType | null
}

export interface CandidateAction {
  action: string
  /** Static attractiveness of the action within the scene. */
  baseWeight: number
  /** Emotion affinity per dimension; negative values reduce the score. */
  emotionAffinity?: Partial<EmotionVector>
  /** Inclusive hour-of-day range [start, end] (may wrap midnight, e.g. [22, 6]). */
  hourRange?: [number, number]
}

export interface SceneRule {
  id: string
  match(context: SceneContext): boolean
  candidates(context: SceneContext): CandidateAction[]
}

export interface BehaviorConfig {
  /** Softmax temperature: higher = more random, lower = more utility-driven. */
  temperature: number
  /** Minimum gap between two spontaneous actions. */
  cooldownMs: number
  /** How many times the same action may repeat back-to-back. */
  maxConsecutive: number
  /** Multiplier applied per recent run of the same action (e.g. 0.5 halves each repeat). */
  repeatPenalty: number
  /** Window (ms) considered for the repetition penalty. */
  recencyWindowMs: number
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  temperature: 1,
  cooldownMs: 45_000,
  maxConsecutive: 2,
  repeatPenalty: 0.5,
  recencyWindowMs: 10 * 60_000,
}

export interface BehaviorPick {
  action: string
  sceneId: string
  utility: number
}

function softmaxDraw(
  scores: Map<string, number>,
  temperature: number,
  random: () => number,
): string | null {
  if (scores.size === 0) return null
  const max = Math.max(...scores.values())
  // Stable form: subtracting the max keeps exp() in a safe range.
  const weights = new Map<string, number>()
  let total = 0
  for (const [action, score] of scores) {
    const w = Math.exp((score - max) / temperature)
    weights.set(action, w)
    total += w
  }
  let threshold = random() * total
  for (const [action, w] of weights) {
    threshold -= w
    if (threshold <= 0) return action
  }
  // Numerical fallback: return the last entry.
  return [...weights.keys()].at(-1) ?? null
}

export class BehaviorSelector {
  constructor(
    private readonly rules: SceneRule[],
    private readonly config: BehaviorConfig = DEFAULT_BEHAVIOR_CONFIG,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Evaluates all rules and draws one action; null when cooling down or nothing matches. */
  pick(context: SceneContext): BehaviorPick | null {
    if (context.activeInteraction && context.activeInteraction !== 'chat') {
      // Ongoing drag blocks spontaneous behavior entirely (interrupt priority).
      return null
    }
    if (
      context.lastActionAt !== undefined &&
      this.now() - context.lastActionAt < this.config.cooldownMs
    ) {
      return null
    }
    const matched = this.rules.filter((rule) => rule.match(context))
    if (matched.length === 0) return null

    const scores = new Map<string, number>()
    for (const rule of matched) {
      for (const candidate of rule.candidates(context)) {
        if (candidate.hourRange) {
          const [start, end] = candidate.hourRange
          const hour = context.now.getHours()
          const inRange = start <= end ? hour >= start && hour <= end : hour >= start || hour <= end
          if (!inRange) continue
        }
        if (
          context.lastAction === candidate.action &&
          context.consecutiveCount >= this.config.maxConsecutive
        ) {
          continue
        }
        const recent = context.recentActionCounts.get(candidate.action) ?? 0
        const penalty = this.config.repeatPenalty ** recent
        const affinity = candidate.emotionAffinity ?? {}
        const emotionFactor =
          1 +
          (Object.keys(affinity) as (keyof EmotionVector)[]).reduce(
            (sum, key) => sum + (affinity[key] ?? 0) * context.emotion[key],
            0,
          )
        const utility = candidate.baseWeight * emotionFactor * penalty
        scores.set(candidate.action, Math.max(scores.get(candidate.action) ?? 0, utility))
      }
    }

    const action = softmaxDraw(scores, this.config.temperature, this.random)
    if (!action) return null
    return { action, sceneId: matched[0]?.id ?? '', utility: scores.get(action) ?? 0 }
  }
}

/** Tracks repetition bookkeeping between picks (consecutive counts + recency window). */
export class BehaviorHistory {
  private lastAction: string | null = null
  private consecutiveCount = 0
  private lastActionAt: number | undefined
  private readonly recent: { action: string; at: number }[] = []

  record(action: string, at: number): void {
    this.consecutiveCount = action === this.lastAction ? this.consecutiveCount + 1 : 1
    this.lastAction = action
    this.lastActionAt = at
    this.recent.push({ action, at })
  }

  snapshot(
    recencyWindowMs: number,
    now: number,
  ): Pick<SceneContext, 'lastAction' | 'consecutiveCount' | 'lastActionAt' | 'recentActionCounts'> {
    const cutoff = now - recencyWindowMs
    while (this.recent.length > 0 && (this.recent[0]?.at ?? 0) < cutoff) {
      this.recent.shift()
    }
    const counts = new Map<string, number>()
    for (const entry of this.recent) {
      counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1)
    }
    return {
      lastAction: this.lastAction,
      consecutiveCount: this.consecutiveCount,
      lastActionAt: this.lastActionAt,
      recentActionCounts: counts,
    }
  }
}

/** Deterministic PRNG (mulberry32) for reproducible tests and seeded personalities. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
