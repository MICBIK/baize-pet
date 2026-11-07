// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Damped springs for secondary motion (task book C): ears, tail, hood
 * drawstrings, drag sway. Integrated with a fixed 8 ms substep so large
 * frame gaps never diverge.
 */

export interface SpringConfig {
  /** Stiffness (rad/s² per unit). */
  k: number
  /** Damping coefficient. */
  c: number
}

export const SPRING_PRESETS = {
  ear: { k: 900, c: 18 },
  tail: { k: 500, c: 12 },
  string: { k: 600, c: 10 },
  leg: { k: 400, c: 14 },
  lean: { k: 120, c: 12 },
} as const

export type SpringPresetName = keyof typeof SPRING_PRESETS

const SUBSTEP_MS = 8

/** One damped harmonic spring. Position, velocity, acceleration per unit. */
export class Spring {
  x: number
  v: number
  target: number
  private readonly k: number
  private readonly c: number

  constructor(preset: SpringPresetName, x = 0) {
    const cfg = SPRING_PRESETS[preset]
    this.k = cfg.k
    this.c = cfg.c
    this.x = x
    this.v = 0
    this.target = 0
  }

  /** Instantaneous velocity kick (impulse from procedural twitches, drag). */
  kick(velocity: number): void {
    this.v += velocity
  }

  /** Advance by dtMs with fixed 8 ms substeps (semi-implicit Euler). */
  step(dtMs: number): number {
    const steps = Math.min(200, Math.max(1, Math.ceil(dtMs / SUBSTEP_MS)))
    const h = dtMs / steps / 1000 // seconds
    for (let i = 0; i < steps; i++) {
      const a = this.k * (this.target - this.x) - this.c * this.v
      this.v += a * h
      this.x += this.v * h
    }
    return this.x
  }

  /** Settle instantly (e.g. after teleport/reset). */
  reset(x = 0): void {
    this.x = x
    this.v = 0
  }
}
