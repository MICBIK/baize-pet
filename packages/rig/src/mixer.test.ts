// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { mixLayers } from './mixer.js'
import { clampParams, createDefaultParams } from './params.js'

describe('mixLayers', () => {
  const base = clampParams({
    'body.x': 0,
    'arm.R.rot': 0,
    'eye.shape': 'auto',
    'mouth.shape': 'smile',
  })

  it('returns base params untouched when only base is present', () => {
    const out = mixLayers({ base })
    expect(out['body.x']).toBe(0)
    expect(out['eye.shape']).toBe('auto')
  })

  it('action layer lerps numerics and snaps enums at weight > 0.5', () => {
    const action = { params: clampParams({ 'body.x': 10, 'arm.R.slot': 'wave' }), weight: 0.5 }
    const half = mixLayers({ base, action })
    expect(half['body.x']).toBeCloseTo(5, 10)
    expect(half['arm.R.slot']).toBe('down') // not yet snapped

    const full = mixLayers({ base, action: { ...action, weight: 0.6 } })
    expect(full['body.x']).toBeCloseTo(6, 10)
    expect(full['arm.R.slot']).toBe('wave')
  })

  it('expression layer only overrides its own keys', () => {
    const expr = {
      params: clampParams({ 'eye.shape': 'star', blush: 1, 'body.x': 99 }),
      weight: 1,
    }
    const out = mixLayers({ base, expression: expr })
    expect(out['eye.shape']).toBe('star')
    expect(out['blush']).toBe(1)
    expect(out['body.x']).toBe(0) // untouched by expression
  })

  it('expression numerics lerp with its weight', () => {
    const expr = { params: clampParams({ blush: 1 }), weight: 0.25 }
    const out = mixLayers({ base, expression: expr })
    expect(out['blush']).toBeCloseTo(0.25, 10)
  })

  it('procedural blink caps eye open, replaces look and breath', () => {
    const proc = {
      'eye.L.open': 0.2,
      'eye.R.open': 0.2,
      'eye.lookX': 0.4,
      'body.breath': 0.5,
      'head.y': -1.2,
    }
    const out = mixLayers({ base, procedural: proc })
    expect(out['eye.L.open']).toBeCloseTo(0.2, 10)
    expect(out['eye.lookX']).toBe(0.4)
    expect(out['body.breath']).toBe(0.5)
    expect(out['head.y']).toBe(-1.2) // additive onto default 0
  })

  it('procedural cannot open eyes wider than the base layer', () => {
    const halfClosedBase = clampParams({ 'eye.L.open': 0.5 })
    const out = mixLayers({ base: halfClosedBase, procedural: { 'eye.L.open': 1 } })
    expect(out['eye.L.open']).toBeCloseTo(0.5, 10)
  })

  it('physics offsets are additive and clamped last', () => {
    const out = mixLayers({
      base,
      physics: { 'ear.L.rot': -12, 'tail.rot': 100 }, // 100 clamps to 30
    })
    expect(out['ear.L.rot']).toBe(-12)
    expect(out['tail.rot']).toBe(30)
  })

  it('layer priority: expression overrides action for expression keys', () => {
    const action = { params: clampParams({ 'mouth.shape': 'wide', 'arm.R.slot': 'up' }), weight: 1 }
    const expr = { params: clampParams({ 'mouth.shape': 'o' }), weight: 1 }
    const out = mixLayers({ base, action, expression: expr })
    expect(out['mouth.shape']).toBe('o')
    expect(out['arm.R.slot']).toBe('up') // action-only key survives
  })
})
