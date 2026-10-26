// SPDX-License-Identifier: AGPL-3.0-only
import type { EmotionVector } from './emotion'

/**
 * Line delivery is behind an interface so the preset pool can be replaced by an
 * LLM-backed pool in a later milestone without touching the behavior system.
 */
export interface LineProvider {
  /** Returns a line for the scene (and current emotion), or null when none is available. */
  line(sceneId: string, emotion: EmotionVector): string | null
}

/**
 * Preset line pool from the character pack manifest: one array of lines per
 * scene, drawn uniformly at random. Empty or missing scenes yield null.
 */
export class PresetLinePool implements LineProvider {
  constructor(
    private readonly pool: Record<string, string[]>,
    private readonly random: () => number = Math.random,
  ) {}

  line(sceneId: string, _emotion: EmotionVector): string | null {
    const lines = this.pool[sceneId]
    if (!lines || lines.length === 0) return null
    const index = Math.floor(this.random() * lines.length)
    return lines[index] ?? null
  }
}
