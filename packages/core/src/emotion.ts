// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Emotion state: a four-dimensional vector (happy / bored / angry / miss) that
 * decays over time and accumulates through interactions. All rates come from
 * the character pack manifest, so personalities can differ per pack.
 */
export interface EmotionVector {
  happy: number
  bored: number
  angry: number
  miss: number
}

/**
 * Per-hour rates. `happy` decays toward 0 when idle; `bored`, `angry` and `miss`
 * grow toward 1 during long idle periods. All values are clamped to [0, 1].
 */
export interface EmotionRates {
  happy: number
  bored: number
  angry: number
  miss: number
}

export type InteractionType = 'click' | 'drag' | 'chat'

/** Interaction gains as configured by the character pack. */
export interface InteractionGains {
  click: Partial<EmotionVector>
  drag: Partial<EmotionVector>
  chat: Partial<EmotionVector>
}

export interface EmotionParams {
  rates: EmotionRates
  gains: InteractionGains
}

export const DEFAULT_EMOTION_PARAMS: EmotionParams = {
  rates: { happy: 0.08, bored: 0.04, angry: 0.01, miss: 0.02 },
  gains: {
    click: { happy: 0.08, bored: -0.15 },
    drag: { happy: 0.12, bored: -0.25, angry: -0.05 },
    chat: { happy: 0.15, bored: -0.3, miss: -0.4 },
  },
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

export class EmotionState {
  private vector: EmotionVector

  constructor(initial?: Partial<EmotionVector>) {
    this.vector = {
      happy: clamp01(initial?.happy ?? 0.6),
      bored: clamp01(initial?.bored ?? 0.1),
      angry: clamp01(initial?.angry ?? 0),
      miss: clamp01(initial?.miss ?? 0.1),
    }
  }

  get value(): EmotionVector {
    return { ...this.vector }
  }

  /** Applies idle decay for the elapsed duration (ms). */
  decay(elapsedMs: number, params: EmotionParams): void {
    const hours = Math.max(0, elapsedMs) / 3_600_000
    this.vector.happy = clamp01(this.vector.happy - params.rates.happy * hours)
    this.vector.bored = clamp01(this.vector.bored + params.rates.bored * hours)
    this.vector.angry = clamp01(this.vector.angry + params.rates.angry * hours)
    this.vector.miss = clamp01(this.vector.miss + params.rates.miss * hours)
  }

  /** Applies an interaction's gains (negative gains reduce the dimension). */
  apply(interaction: InteractionType, params: EmotionParams): void {
    const gains = params.gains[interaction] ?? {}
    for (const key of ['happy', 'bored', 'angry', 'miss'] as const) {
      const gain = gains[key]
      if (gain !== undefined) {
        this.vector[key] = clamp01(this.vector[key] + gain)
      }
    }
  }
}
