// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyframe clip evaluation (task book B3): easing functions, per-track
 * interpolation (numeric eased, enum stepped), loop wrap and event windows.
 */

import { clampParams, type ParamValue, type RigParams } from './params.js'
import { type Clip, EASINGS, type Easing, type Keyframe } from './schema.js'

/** Normalised easing curve functions; input and output are both 0..1. */
export function ease(u: number, kind: Easing): number {
  const t = Math.min(1, Math.max(0, u))
  switch (kind) {
    case 'linear':
      return t
    case 'easeInSine':
      return 1 - Math.cos((t * Math.PI) / 2)
    case 'easeOutSine':
      return Math.sin((t * Math.PI) / 2)
    case 'easeInOutSine': {
      return -(Math.cos(Math.PI * t) - 1) / 2
    }
    case 'easeInCubic':
      return t * t * t
    case 'easeOutCubic':
      return 1 - (1 - t) ** 3
    case 'easeInOutCubic':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 2 / 2
    case 'easeOutBack': {
      const c1 = 1.70158
      const c3 = c1 + 1
      return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
    }
    case 'easeOutElastic': {
      if (t === 0 || t === 1) return t
      const c4 = (2 * Math.PI) / 3
      return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
    }
    case 'step':
      return t >= 1 ? 1 : 0
  }
}

/** Sort keyframes by time; stable for already-sorted input. */
export function sortKeyframes(track: Keyframe[]): Keyframe[] {
  return [...track].sort((a, b) => a[0] - b[0])
}

/**
 * Evaluate one track at timeMs. Numeric segments interpolate with the
 * segment easing; string (enum) values step: the track holds the value of
 * the last keyframe at or before timeMs. Returns undefined for empty tracks.
 */
export function evalTrack(track: Keyframe[], timeMs: number): ParamValue | undefined {
  if (track.length === 0) return undefined
  const kfs = sortKeyframes(track)
  const first = kfs[0]
  if (!first) return undefined
  if (timeMs <= first[0]) return first[1]
  const last = kfs[kfs.length - 1]
  if (!last) return undefined
  if (timeMs >= last[0]) return last[1]

  let i = 0
  for (let j = 0; j < kfs.length - 1; j++) {
    const k = kfs[j]
    if (k && timeMs >= k[0]) i = j
  }
  const k0 = kfs[i]
  const k1 = kfs[i + 1]
  if (!k0 || !k1) return k0?.[1]

  const v0 = k0[1]
  const v1 = k1[1]
  if (typeof v0 === 'string' || typeof v1 === 'string') return v0 // enum: hold until next keyframe

  const span = k1[0] - k0[0]
  if (span <= 0) return v1
  const u = (timeMs - k0[0]) / span
  const e = ease(u, k1[2] ?? 'linear')
  if ((k1[2] ?? '') === 'step') return v0
  return v0 + (v1 - v0) * e
}

/**
 * Evaluate a whole clip into a clamped parameter map. Looping clips wrap by
 * modulo duration; unknown track keys are dropped by clampParams.
 */
export function evalClip(clip: Clip, timeMs: number): RigParams {
  const t = clip.loop
    ? ((timeMs % clip.duration) + clip.duration) % clip.duration
    : Math.min(timeMs, clip.duration)
  const out: RigParams = {}
  for (const [key, track] of Object.entries(clip.tracks)) {
    const v = evalTrack(track, t)
    if (v !== undefined) out[key] = v
  }
  return clampParams(out)
}

/** Events with time in [fromMs, toMs); loop-aware when the clip loops. */
export function eventsBetween(clip: Clip, fromMs: number, toMs: number): string[] {
  if (!clip.events || clip.events.length === 0) return []
  const fired: string[] = []
  const dur = clip.duration
  if (!clip.loop) {
    for (const [at, name] of clip.events) {
      if (at >= fromMs && at < toMs) fired.push(name)
    }
    return fired
  }
  // Loop-aware: a poll window that crosses a wrap fires both the tail from
  // fromMs and the head below toMs (state machine polls with small dt).
  const fromMod = ((fromMs % dur) + dur) % dur
  const toMod = ((toMs % dur) + dur) % dur
  const wrapped = Math.floor(toMs / dur) > Math.floor(fromMs / dur)
  for (const [at, name] of clip.events) {
    if (wrapped ? at >= fromMod || at < toMod : at >= fromMod && at < toMod) {
      fired.push(name)
    }
  }
  return fired
}

/** True when the position is a legal easing name (also exported via schema). */
export function isEasing(v: string): v is Easing {
  return (EASINGS as readonly string[]).includes(v)
}
