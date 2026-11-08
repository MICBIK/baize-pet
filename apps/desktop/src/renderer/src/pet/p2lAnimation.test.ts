// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  gazeFromCursor,
  lipSyncDurationMs,
  lipSyncLevel,
  parseP2lAnimation,
  resolveCue,
} from './p2lAnimation'

describe('parseP2lAnimation', () => {
  it('parses clip, clip@expression and @expression', () => {
    expect(parseP2lAnimation('p2l:Wave')).toEqual({ clip: 'Wave', expression: null })
    expect(parseP2lAnimation('p2l:Happy@Smile')).toEqual({ clip: 'Happy', expression: 'Smile' })
    expect(parseP2lAnimation('p2l:@Shy')).toEqual({ clip: null, expression: 'Shy' })
  })

  it('rejects other forms and malformed values', () => {
    for (const v of [undefined, '', 'rig:idle', 'sprite:dance', 'p2l:', 'p2l:@', 'p2l:a b']) {
      expect(parseP2lAnimation(v)).toBeNull()
    }
  })
})

describe('resolveCue', () => {
  const available = { clips: ['Idle', 'Wave'], expressions: ['Smile'] }
  const animations = {
    idle: 'p2l:Idle',
    wave: 'p2l:Wave@Smile',
    happy: 'p2l:Happy@Smile',
    dance: 'sprite:dance',
    ghost: 'p2l:Nope@Nope',
  }

  it('keeps names the model has', () => {
    expect(resolveCue(animations, 'wave', available)).toEqual({ clip: 'Wave', expression: 'Smile' })
  })

  it('drops unknown parts and falls back to idle', () => {
    expect(resolveCue(animations, 'happy', available)).toEqual({ clip: null, expression: 'Smile' })
    expect(resolveCue(animations, 'ghost', available)).toEqual({ clip: 'Idle', expression: null })
    expect(resolveCue(animations, 'dance', available)).toEqual({ clip: 'Idle', expression: null })
    expect(resolveCue(animations, 'missing', available)).toEqual({ clip: 'Idle', expression: null })
    expect(resolveCue({}, 'idle', available)).toEqual({ clip: null, expression: null })
  })
})

describe('gazeFromCursor', () => {
  const box = { width: 400, height: 400 }
  it('is centred on the head and y points up', () => {
    expect(gazeFromCursor({ x: 200, y: 140 }, box)).toEqual({ x: 0, y: -0 })
    const up = gazeFromCursor({ x: 280, y: 60 }, box)
    expect(up.x).toBeCloseTo(0.5)
    expect(up.y).toBeCloseTo(0.5)
  })
  it('saturates at ±1', () => {
    expect(gazeFromCursor({ x: -5000, y: 5000 }, box)).toEqual({ x: -1, y: -1 })
  })
})

describe('lip sync', () => {
  it('scales duration with the line and clamps it', () => {
    expect(lipSyncDurationMs('')).toBe(600)
    expect(lipSyncDurationMs('你好呀，今天想做点什么？')).toBe(840)
    expect(lipSyncDurationMs('长'.repeat(500))).toBe(6000)
  })
  it('stays in 0..1 and is closed outside the line', () => {
    const d = 1000
    expect(lipSyncLevel(-1, d)).toBe(0)
    expect(lipSyncLevel(d, d)).toBe(0)
    let peak = 0
    for (let t = 0; t < d; t += 5) {
      const v = lipSyncLevel(t, d)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      peak = Math.max(peak, v)
    }
    expect(peak).toBeGreaterThan(0.5)
  })
})
