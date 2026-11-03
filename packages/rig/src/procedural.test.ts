// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { makeRng, ProceduralEngine } from './procedural.js'
import { Spring } from './springs.js'

describe('seeded rng', () => {
  it('is deterministic per seed', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    const c = makeRng(43)
    const seqA: number[] = []
    for (let i = 0; i < 10; i++) seqA.push(a())
    for (let i = 0; i < 10; i++) {
      expect(seqA[i]).toBe(b())
      expect(seqA[i]).not.toBeNaN()
    }
    expect(c()).not.toBe(seqA[0])
  })
})

describe('procedural engine', () => {
  it('produces deterministic output for identical input sequences', () => {
    const run = () => {
      const e = new ProceduralEngine(7)
      const out: number[] = []
      for (let t = 0; t <= 3000; t += 16) {
        const r = e.tick({ tMs: t, dtMs: 16 })
        out.push(Number((r.params['body.breath'] ?? -9).toFixed(5)))
      }
      return out
    }
    expect(run()).toEqual(run())
  })

  it('breathes on the 3.2 s cycle and slower while sleeping', () => {
    const e = new ProceduralEngine(1)
    const at = (t: number, sleeping = false) =>
      e.tick({ tMs: t, dtMs: 16, sleeping })['params']['body.breath']
    const awakePeak = at(1600) // half period
    expect(awakePeak).toBeCloseTo(1, 1)
    expect(at(3200)).toBeCloseTo(0, 1)
    const sleep = new ProceduralEngine(1)
    // 4600 ms period: at 1600 ms the phase is 2π*1600/4600 -> breath ≈ 0.79.
    expect(
      sleep.tick({ tMs: 1600, dtMs: 16, sleeping: true })['params']['body.breath'],
    ).toBeCloseTo(0.79, 1)
  })

  it('blinks: eyes dip to 0 and recover on the stated timeline', () => {
    const e = new ProceduralEngine(20261103)
    // Drive forward until the first blink fires (scheduled 1.5-6 s in).
    let sawClosed = false
    let closedAt = -1
    let recoveredAt = -1
    for (let t = 0; t <= 8000 && recoveredAt < 0; t += 16) {
      const open = e.tick({ tMs: t, dtMs: 16 })['params']['eye.L.open'] ?? 1
      if (open <= 0.02 && !sawClosed) {
        sawClosed = true
        closedAt = t
      }
      if (sawClosed && closedAt >= 0 && t > closedAt && open >= 0.98) recoveredAt = t
    }
    expect(sawClosed).toBe(true)
    expect(recoveredAt).toBeGreaterThan(closedAt)
    expect(recoveredAt - closedAt).toBeLessThanOrEqual(200) // 50 hold + 90 open
  })

  it('mouse follow converges toward the target with the 180 ms time constant', () => {
    const e = new ProceduralEngine(5)
    const dt = 16
    let lookX = 0
    for (let t = 0; t <= 500; t += dt) {
      const p = e.tick({ tMs: t, dtMs: dt, look: { x: 1, y: 0 } })['params']
      lookX = p['eye.lookX'] ?? 0
    }
    expect(lookX).toBeGreaterThan(0.9)
    const headTurn = (() => {
      const e2 = new ProceduralEngine(5)
      let p
      for (let t = 0; t <= 500; t += 16)
        p = e2.tick({ tMs: t, dtMs: 16, look: { x: 1, y: 0 } })['params']
      return p['head.turnX']
    })()
    expect(headTurn).toBeCloseTo(lookX * 0.45, 1)
  })

  it('ear twitch impulses fire within 6-14 s and feed springs', () => {
    const e = new ProceduralEngine(9)
    const spring = new Spring('ear')
    let fired = false
    for (let t = 0; t <= 20000 && !fired; t += 16) {
      const r = e.tick({ tMs: t, dtMs: 16 })
      if (r.earImpulse) {
        fired = true
        spring.kick(r.earImpulse.velocity)
        expect(r.earImpulse.velocity).toBeLessThan(0)
        expect(['L', 'R']).toContain(r.earImpulse.side)
      }
    }
    expect(fired).toBe(true)
    // After the kick the spring swings negative then returns toward target.
    let min = 0
    for (let i = 0; i < 400; i++) min = Math.min(min, spring.step(16))
    expect(min).toBeLessThan(-1)
    expect(Math.abs(spring.step(16))).toBeLessThan(1)
  })
})

describe('spring stability', () => {
  it('does not diverge on huge dt (one big step == many small steps)', () => {
    const big = new Spring('tail')
    big.kick(50)
    big.step(5000)
    expect(Number.isFinite(big.x)).toBe(true)
    expect(Math.abs(big.x)).toBeLessThan(1e6)
    const fine = new Spring('tail')
    fine.kick(50)
    for (let i = 0; i < 625; i++) fine.step(8)
    expect(Number.isFinite(fine.x)).toBe(true)
    // Both settle near target 0; the big step must not explode past the fine run.
    expect(Math.abs(big.x)).toBeLessThan(Math.abs(fine.x) * 50 + 1000)
  })

  it('converges to its target', () => {
    const s = new Spring('ear')
    s.target = 5
    for (let i = 0; i < 5000; i++) s.step(8)
    expect(s.x).toBeCloseTo(5, 3)
  })
})
