// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the p2l renderer (ADR 0008): manifest value parsing, gaze
// mapping and a lip-sync envelope. DOM- and WebGL-free so they unit-test.

/** What a "p2l:<clip>[@<expression>]" animation value asks the player to do. */
export interface P2lCue {
  clip: string | null
  expression: string | null
}

const P2L_VALUE = /^p2l:([A-Za-z0-9._-]*)(?:@([A-Za-z0-9._-]+))?$/

/** Parses a manifest animation value; null for other forms or malformed input. */
export function parseP2lAnimation(value: string | undefined): P2lCue | null {
  if (!value) return null
  const m = P2L_VALUE.exec(value)
  if (!m) return null
  const clip = m[1] ? m[1] : null
  const expression = m[2] ?? null
  if (!clip && !expression) return null
  return { clip, expression }
}

/**
 * Resolves the cue for an action against what the model actually contains:
 * unknown clip/expression names are dropped, and an action without a usable
 * cue falls back to the idle action's cue.
 */
export function resolveCue(
  animations: Record<string, string>,
  action: string,
  available: { clips: readonly string[]; expressions: readonly string[] },
): P2lCue {
  const pick = (value: string | undefined): P2lCue | null => {
    const cue = parseP2lAnimation(value)
    if (!cue) return null
    const clip = cue.clip && available.clips.includes(cue.clip) ? cue.clip : null
    const expression =
      cue.expression && available.expressions.includes(cue.expression) ? cue.expression : null
    return clip || expression ? { clip, expression } : null
  }
  return pick(animations[action]) ?? pick(animations.idle) ?? { clip: null, expression: null }
}

/**
 * Cursor (window CSS px) to the player's gaze target, each axis -1..1 with
 * y up. `reach` is how far (px) from the head the gaze saturates.
 */
export function gazeFromCursor(
  cursor: { x: number; y: number },
  box: { width: number; height: number },
  headY = 0.35,
  reach = 160,
): { x: number; y: number } {
  const clamp = (v: number) => Math.min(1, Math.max(-1, v))
  return {
    x: clamp((cursor.x - box.width / 2) / reach),
    y: clamp(-(cursor.y - box.height * headY) / reach),
  }
}

/** Speaking time for a line: ~70 ms per character, 0.6 s minimum, 6 s cap. */
export function lipSyncDurationMs(line: string): number {
  return Math.min(6000, Math.max(600, [...line].length * 70))
}

/**
 * Mouth opening 0..1 at `t` ms into a line lasting `duration` ms: a syllable
 * wobble under an attack/release envelope; 0 outside the line.
 */
export function lipSyncLevel(t: number, duration: number): number {
  if (t < 0 || t >= duration) return 0
  const envelope = Math.min(1, t / 80, (duration - t) / 120)
  const syllable = 0.5 + 0.5 * Math.sin((t / 1000) * 2 * Math.PI * 4.5)
  const variation = 0.75 + 0.25 * Math.sin((t / 1000) * 2 * Math.PI * 1.3)
  return Math.max(0, Math.min(1, envelope * syllable * variation))
}
