// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Procedural life (task book C): breathing, blinking, gaze (saccades +
 * mouse follow), ear twitches, tail sway and head micro-motion. All
 * randomness comes from a seeded PRNG so runs are reproducible in tests.
 */

import type { RigParams } from './params.js'

/** Deterministic 32-bit PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface LookTarget {
  /** -1..1 in pet-window space; positive x = viewer's right. */
  x: number
  y: number
}

export interface ProceduralInput {
  /** Animation clock in ms (monotonic, not wall time). */
  tMs: number
  /** Time since last tick in ms. */
  dtMs: number
  /** Sleeping pose: slower breathing, no saccades/follow. */
  sleeping?: boolean
  /** Mouse-follow target when the mouse is active. */
  look?: LookTarget
}

export interface ProceduralOutput {
  /** Params to merge through the procedural mixer layer. */
  params: RigParams
  /** Ear twitch impulse for the spring system, if one fired this tick. */
  earImpulse?: { side: 'L' | 'R'; velocity: number }
}

const BLINK_CLOSE_MS = 60
const BLINK_HOLD_MS = 50
const BLINK_OPEN_MS = 90
const BLINK_TOTAL_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS
const BREATH_PERIOD_MS = 3200
const BREATH_PERIOD_SLEEP_MS = 4600

function clamp01(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

/** Head micro-motion: two slow sines with prime-period ratios. */
function headNoise(tMs: number): number {
  return 0.9 * Math.sin((tMs / 5000) * Math.PI * 2) + 0.6 * Math.sin((tMs / 2713) * Math.PI * 2)
}

interface BlinkPlan {
  startMs: number
  double: boolean
  second: boolean
}

export class ProceduralEngine {
  private readonly rng: () => number
  private nextBlinkAt: number
  private blink: BlinkPlan | null = null
  private nextSaccadeAt: number
  private saccade: LookTarget = { x: 0, y: 0 }
  private saccadeFrom: LookTarget = { x: 0, y: 0 }
  private saccadeStart = -Infinity
  private nextEarAt: number
  private lastFollowAt = -Infinity
  private followTarget: LookTarget = { x: 0, y: 0 }
  private lookSmooth: LookTarget = { x: 0, y: 0 }
  private readonly lookTauMs = 180

  constructor(seed = 20261103) {
    this.rng = makeRng(seed)
    this.nextBlinkAt = 1500 + this.rng() * 4500
    this.nextSaccadeAt = 1500 + this.rng() * 2500
    this.nextEarAt = 6000 + this.rng() * 8000
  }

  tick(input: ProceduralInput): ProceduralOutput {
    const { tMs, dtMs, sleeping = false } = input
    void dtMs // kept for interface stability; smoothing lives in applyGaze
    const params: RigParams = {}

    // Breathing: 0..1 sine, slower while sleeping.
    const period = sleeping ? BREATH_PERIOD_SLEEP_MS : BREATH_PERIOD_MS
    const phase = ((tMs % period) / period) * Math.PI * 2
    const breath = 0.5 - 0.5 * Math.cos(phase)
    params['body.breath'] = breath
    params['head.y'] = -1.2 * breath

    // Blinking: close 60ms -> hold 50ms -> open 90ms; 15% double blinks.
    let openCap = 1
    if (this.blink) {
      const e = tMs - this.blink.startMs
      if (e < BLINK_CLOSE_MS) {
        openCap = 1 - e / BLINK_CLOSE_MS
      } else if (e < BLINK_CLOSE_MS + BLINK_HOLD_MS) {
        openCap = 0
      } else if (e < BLINK_TOTAL_MS) {
        openCap = (e - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS
      } else if (this.blink.double && !this.blink.second) {
        this.blink = { startMs: tMs, double: true, second: true }
      } else {
        this.blink = null
        this.nextBlinkAt = tMs + 2500 + this.rng() * 3500
      }
    }
    if (!this.blink && tMs >= this.nextBlinkAt) {
      this.blink = { startMs: tMs, double: this.rng() < 0.15, second: false }
    }
    params['eye.L.open'] = openCap
    params['eye.R.open'] = openCap

    this.applyGaze(params, input)
    // Head micro-motion ±~1.5°, additive (mixer adds non-face keys).
    params['head.tilt'] = headNoise(tMs)
    return { params, earImpulse: this.maybeEarTwitch(tMs) }
  }

  /** Saccades when idle; exponential smoothing toward the mouse when active. */
  private applyGaze(params: RigParams, input: ProceduralInput): void {
    const { tMs, dtMs, sleeping = false } = input
    if (input.look) {
      this.lastFollowAt = tMs
      this.followTarget = input.look
    }
    let tx: number
    let ty: number
    if (input.look || tMs - this.lastFollowAt < 4000) {
      const alpha = 1 - Math.exp(-dtMs / this.lookTauMs)
      this.lookSmooth.x += (this.followTarget.x - this.lookSmooth.x) * alpha
      this.lookSmooth.y += (this.followTarget.y - this.lookSmooth.y) * alpha
      tx = this.lookSmooth.x
      ty = this.lookSmooth.y
    } else if (!sleeping && tMs >= this.nextSaccadeAt) {
      this.saccade = { x: (this.rng() - 0.5) * 0.5, y: (this.rng() - 0.5) * 0.3 }
      this.saccadeFrom = { ...this.lookSmooth }
      this.saccadeStart = tMs
      this.nextSaccadeAt = tMs + 1500 + this.rng() * 2500
      tx = this.lookSmooth.x
      ty = this.lookSmooth.y
    } else {
      const u = Math.min(1, Math.max(0, (tMs - this.saccadeStart) / 80))
      tx = this.saccadeFrom.x + (this.saccade.x - this.saccadeFrom.x) * u
      ty = this.saccadeFrom.y + (this.saccade.y - this.saccadeFrom.y) * u
      this.lookSmooth = { x: tx, y: ty }
    }
    params['eye.lookX'] = clamp01(tx)
    params['eye.lookY'] = clamp01(ty)
    // Head follows the gaze at 0.45x (task book C).
    params['head.turnX'] = clamp01(tx * 0.45)
    params['head.turnY'] = clamp01(ty * 0.45)
  }

  /** Random single-ear twitch every 6-14 s; the spring does the rebound. */
  private maybeEarTwitch(tMs: number): ProceduralOutput['earImpulse'] {
    if (tMs < this.nextEarAt) return undefined
    this.nextEarAt = tMs + 6000 + this.rng() * 8000
    const side = this.rng() < 0.5 ? 'L' : 'R'
    // Spring velocity units: ~-360 deg/s swings the ear preset ~12 degrees.
    return { side, velocity: -360 }
  }
}
