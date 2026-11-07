// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { clampParams, createDefaultParams } from './params.js'
import { parseRigManifest } from './schema.js'
import { eyeSlot, mouthSlot, partClass, solve, thirdEyeSlot } from './solver.js'

const mini = parseRigManifest({
  version: 1,
  master: { width: 690, height: 1024, scale: 0.5 },
  anchor: { hoodWidth: 184, groundY: 1013, centerX: 345 },
  parts: [
    {
      id: 'hood',
      image: 'parts/hood.png',
      x: 100,
      y: 50,
      z: 50,
      parent: 'head',
      pivot: [345, 560],
    },
    {
      id: 'eye-L',
      z: 70,
      parent: 'head',
      pivot: [300, 350],
      slots: {
        open: { image: 'parts/eye-L.open.png', x: 280, y: 330 },
        half: { image: 'parts/eye-L.half.png', x: 280, y: 335 },
        closed: { image: 'parts/eye-L.closed.png', x: 280, y: 340 },
      },
    },
    {
      id: 'eye-R',
      z: 70,
      parent: 'head',
      pivot: [390, 350],
      slots: { open: { image: 'parts/eye-R.open.png', x: 370, y: 330 } },
    },
    {
      id: 'iris-L',
      image: 'parts/iris-L.png',
      x: 300,
      y: 345,
      z: 71,
      parent: 'head',
      pivot: [310, 355],
    },
    {
      id: 'mouth',
      z: 72,
      parent: 'head',
      pivot: [345, 430],
      slots: {
        smile: { image: 'parts/mouth.smile.png', x: 330, y: 420 },
        wide: { image: 'parts/mouth.wide.png', x: 325, y: 415 },
      },
    },
    {
      id: 'arm-L',
      z: 40,
      parent: 'torso',
      pivot: [220, 470],
      slots: {
        down: { image: 'parts/arm-R.down.png', x: 200, y: 455 },
        wave: { image: 'parts/arm-R.wave.png', x: 190, y: 210 },
      },
    },
    {
      id: 'blush',
      image: 'parts/blush.png',
      x: 300,
      y: 400,
      z: 73,
      parent: 'head',
      pivot: [345, 410],
      opacityParam: 'blush',
    },
    {
      id: 'fx-zzz',
      image: 'parts/fx-zzz.png',
      x: 480,
      y: 240,
      z: 90,
      parent: 'body',
      pivot: [480, 240],
    },
  ],
  groups: { body: { pivot: [345, 1013] }, head: { parent: 'body', pivot: [345, 560] } },
})

describe('slot selection', () => {
  it('eye thresholds: >=0.75 open, >=0.35 half, else closed', () => {
    const p = clampParams({ 'eye.L.open': 0.8 })
    expect(eyeSlot(p, 'L')).toBe('open')
    expect(eyeSlot(clampParams({ 'eye.L.open': 0.5 }), 'L')).toBe('half')
    expect(eyeSlot(clampParams({ 'eye.L.open': 0.2 }), 'L')).toBe('closed')
    expect(eyeSlot(clampParams({ 'eye.shape': 'star' }), 'L')).toBe('star')
  })

  it('mouth.open overrides explicit shape by threshold', () => {
    expect(mouthSlot(createDefaultParams())).toBe('smile')
    expect(mouthSlot(clampParams({ 'mouth.open': 0.3 }))).toBe('small')
    expect(mouthSlot(clampParams({ 'mouth.open': 0.6 }))).toBe('mid')
    expect(mouthSlot(clampParams({ 'mouth.open': 0.9 }))).toBe('wide')
    expect(mouthSlot(clampParams({ 'mouth.shape': 'cat', 'mouth.open': 0 }))).toBe('cat')
  })

  it('third eye thresholds 0.33/0.75', () => {
    expect(thirdEyeSlot(clampParams({ thirdEye: 0.2 }))).toBe('closed')
    expect(thirdEyeSlot(clampParams({ thirdEye: 0.5 }))).toBe('half')
    expect(thirdEyeSlot(clampParams({ thirdEye: 0.9 }))).toBe('open')
  })

  it('partClass covers all rig part families', () => {
    expect(partClass('eye-L')).toBe('eye')
    expect(partClass('third-eye.open')).toBe('thirdeye')
    expect(partClass('horn-L')).toBe('horn')
    expect(partClass('arm-R')).toBe('arm')
    expect(partClass('fx-zzz')).toBe('fx')
  })
})

describe('solve()', () => {
  const p = createDefaultParams()

  it('emits parts in z order with slot images', () => {
    const out = solve(mini, p)
    const ids = out.map((s) => s.id)
    expect(ids.indexOf('arm-L')).toBeLessThan(ids.indexOf('hood'))
    expect(ids.indexOf('hood')).toBeLessThan(ids.indexOf('eye-L'))
    const eyeL = out.find((s) => s.id === 'eye-L')
    expect(eyeL?.image).toBe('parts/eye-L.open.png')
  })

  it('arm slot switch changes image; viewer-left arm is mirrored', () => {
    const waving = solve(mini, clampParams({ 'arm.L.slot': 'wave' }))
    const arm = waving.find((s) => s.id === 'arm-L')
    expect(arm?.image).toBe('parts/arm-R.wave.png')
    expect(arm?.mirrored).toBe(true)
    // R7-1: a raised arm renders above the hood-front shell (85) and the
    // horns/third-eye sewn onto it (86/87) — z 89.
    expect(arm?.z).toBe(89)
  })

  it('does not mirror a viewer-left arm that ships its own image', () => {
    const own: typeof mini = {
      ...mini,
      parts: mini.parts.map((part) =>
        part.id === 'arm-L'
          ? { ...part, slots: { down: { image: 'parts/arm-L.png', x: 200, y: 455 } } }
          : part,
      ),
    }
    const arm = solve(own, p).find((s) => s.id === 'arm-L')
    expect(arm?.image).toBe('parts/arm-L.png')
    expect(arm?.mirrored).toBe(false)
  })

  it('falls back to a default slot when the requested one is missing', () => {
    const out = solve(mini, clampParams({ 'eye.R.open': 0.2 })) // closed missing on eye-R
    const eyeR = out.find((s) => s.id === 'eye-R')
    expect(eyeR?.image).toBe('parts/eye-R.open.png') // falls back to open
  })

  it('head turn parallax moves eyes more than hood', () => {
    const turned = solve(mini, clampParams({ 'head.turnX': 1 }))
    const eye = turned.find((s) => s.id === 'eye-L')
    const hood = turned.find((s) => s.id === 'hood')
    const base = solve(mini, p)
    const xOf = (s?: { restX: number; dx: number }): number => (s ? s.restX + s.dx : 0)
    const eyeDx = xOf(eye) - xOf(base.find((s) => s.id === 'eye-L'))
    const hoodDx = xOf(hood) - xOf(base.find((s) => s.id === 'hood'))
    expect(Math.abs(eyeDx)).toBeGreaterThan(Math.abs(hoodDx))
  })

  it('squash scales the body group around the feet', () => {
    const sq = solve(mini, clampParams({ 'body.squash': 0.5 }))
    const hood = sq.find((s) => s.id === 'hood')
    expect(hood?.scaleY).toBeCloseTo(1 + 0.14 * 0.5, 6)
    expect(hood?.scaleX).toBeCloseTo(1 - 0.09 * 0.5, 6)
  })

  it('opacity params gate parts; fx strength gates fx parts', () => {
    const noBlush = solve(mini, p)
    expect(noBlush.find((s) => s.id === 'blush')).toBeUndefined()
    const withBlush = solve(mini, clampParams({ blush: 0.8 }))
    expect(withBlush.find((s) => s.id === 'blush')?.opacity).toBeCloseTo(0.8, 6)
    expect(noBlush.find((s) => s.id === 'fx-zzz')).toBeUndefined()
    const withZzz = solve(mini, clampParams({ 'fx.zzz': 0.5 }))
    expect(withZzz.find((s) => s.id === 'fx-zzz')?.opacity).toBeCloseTo(0.5, 6)
  })

  it('iris shifts with look and only when the open slot is shown', () => {
    // Production passes full param maps (defaults merged by the mixer).
    const looking = solve(mini, { ...createDefaultParams(), 'eye.lookX': 1 })
    const iris = looking.find((s) => s.id === 'iris-L')
    expect(iris?.irisShift?.dx).toBeGreaterThan(0)
    expect(iris?.clipImage).toBe('parts/eye-L.open.png')
    const closed = solve(mini, { ...createDefaultParams(), 'eye.L.open': 0.1 })
    expect(closed.find((s) => s.id === 'iris-L')).toBeUndefined()
  })
})
