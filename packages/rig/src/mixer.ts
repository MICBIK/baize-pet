// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer mixing (task book B3): base idle → action (numeric params lerp by
 * fade weight, enums snap at weight > 0.5) → expression preset (overrides
 * eyes/mouth/blush/third-eye with its own weight) → procedural life
 * (specific merge semantics) → physics springs (additive, clamped last).
 */

import { clampParams, createDefaultParams, getNum, type RigParams } from './params.js'

/** Parameter keys the expression layer is allowed to override. */
export const EXPRESSION_KEYS = [
  'eye.L.open',
  'eye.R.open',
  'eye.shape',
  'eye.lookX',
  'eye.lookY',
  'mouth.shape',
  'mouth.open',
  'blush',
  'thirdEye',
  'thirdEye.glow',
] as const

const EXPRESSION_KEY_SET = new Set<string>(EXPRESSION_KEYS)

/** Keys the procedural layer caps (min) instead of adding. */
const PROC_OPEN_KEYS = new Set(['eye.L.open', 'eye.R.open'])
/** Keys the procedural layer replaces outright. */
const PROC_REPLACE_KEYS = new Set(['eye.lookX', 'eye.lookY', 'body.breath', 'mouth.open'])

export interface ActionLayer {
  params: RigParams
  /** 0..1 fade weight; the 150 ms fade timing lives with the caller. */
  weight: number
}

export interface ExpressionLayer {
  params: RigParams
  /** 0..1 transition weight; the 120 ms timing lives with the caller. */
  weight: number
}

export interface MixerInput {
  /** Output of the looping idle clip (base layer). */
  base: RigParams
  /** Current one-shot or looping action, fading in/out. */
  action?: ActionLayer
  /** Active expression preset, transitioning. */
  expression?: ExpressionLayer
  /** Procedural-life output for this frame. */
  procedural?: RigParams
  /** Spring offsets for this frame. */
  physics?: RigParams
}

/**
 * Blend all layers into one clamped parameter map for the frame.
 * Pure function; deterministic given its inputs.
 */
export function mixLayers(input: MixerInput): RigParams {
  const out: RigParams = { ...createDefaultParams(), ...input.base }

  if (input.action && input.action.weight > 0) {
    const w = Math.min(1, Math.max(0, input.action.weight))
    const a = input.action.params
    for (const [key, value] of Object.entries(a)) {
      const prev = out[key]
      if (typeof value === 'number') {
        const baseNum = typeof prev === 'number' ? prev : 0
        out[key] = baseNum + (value - baseNum) * w
      } else if (w > 0.5) {
        out[key] = value
      }
      // enum at w <= 0.5: keep base value
    }
  }

  if (input.expression && input.expression.weight > 0) {
    const w = Math.min(1, Math.max(0, input.expression.weight))
    const e = input.expression.params
    for (const [key, value] of Object.entries(e)) {
      if (!EXPRESSION_KEY_SET.has(key)) continue
      if (typeof value === 'number') {
        const prev = typeof out[key] === 'number' ? getNum(out, key) : 0
        out[key] = prev + (value - prev) * w
      } else if (w > 0.5) {
        out[key] = value
      }
    }
  }

  if (input.procedural) {
    for (const [key, value] of Object.entries(input.procedural)) {
      if (typeof value !== 'number') continue
      if (PROC_OPEN_KEYS.has(key)) {
        const prev = typeof out[key] === 'number' ? getNum(out, key) : 1
        out[key] = Math.min(prev, value)
      } else if (PROC_REPLACE_KEYS.has(key)) {
        out[key] = value
      } else {
        const prev = typeof out[key] === 'number' ? getNum(out, key) : 0
        out[key] = prev + value
      }
      // enums are not procedurally driven
    }
  }

  if (input.physics) {
    for (const [key, value] of Object.entries(input.physics)) {
      if (typeof value !== 'number') continue
      const prev = typeof out[key] === 'number' ? getNum(out, key) : 0
      out[key] = prev + value
    }
  }

  return clampParams(out)
}
