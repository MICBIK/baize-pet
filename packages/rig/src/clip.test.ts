// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { ease, evalClip, evalTrack, eventsBetween, isEasing, sortKeyframes } from './clip.js'
import type { Keyframe } from './schema.js'
import { parseClip } from './schema.js'

describe('easing functions', () => {
  it('map 0->0 and 1->1 for all kinds', () => {
    for (const kind of [
      'linear',
      'easeInSine',
      'easeOutSine',
      'easeInOutSine',
      'easeInCubic',
      'easeOutCubic',
      'easeInOutCubic',
      'easeOutBack',
      'easeOutElastic',
      'step',
    ] as const) {
      expect(ease(0, kind)).toBeCloseTo(0, 6)
      expect(ease(1, kind)).toBeCloseTo(1, 6)
    }
  })

  it('easeOutBack overshoots past 1 then settles', () => {
    expect(ease(0.6, 'easeOutBack')).toBeGreaterThan(1)
    expect(ease(1, 'easeOutBack')).toBeCloseTo(1, 6)
  })

  it('step holds 0 until the very end', () => {
    expect(ease(0.99, 'step')).toBe(0)
    expect(ease(1, 'step')).toBe(1)
  })
})

describe('track evaluation', () => {
  const num: Keyframe[] = [
    [0, 0],
    [1000, 10, 'linear'],
  ]

  it('holds first/last values outside the range', () => {
    expect(evalTrack(num, -50)).toBe(0)
    expect(evalTrack(num, 2000)).toBe(10)
  })

  it('interpolates with the segment easing', () => {
    expect(evalTrack(num, 500)).toBeCloseTo(5, 10)
    const eased: Keyframe[] = [
      [0, 0],
      [1000, 10, 'easeOutCubic'],
    ]
    expect(evalTrack(eased, 500)).toBeCloseTo(10 * (1 - 0.5 ** 3), 10)
  })

  it('enum tracks step: hold current until the next keyframe', () => {
    const slots: Keyframe[] = [
      [0, 'wave'],
      [1450, 'down'],
    ]
    expect(evalTrack(slots, 0)).toBe('wave')
    expect(evalTrack(slots, 1449)).toBe('wave')
    expect(evalTrack(slots, 1450)).toBe('down')
  })

  it('step easing holds the from-value until segment end', () => {
    const kfs: Keyframe[] = [
      [0, 1],
      [1000, 2, 'step'],
    ]
    expect(evalTrack(kfs, 999)).toBe(1)
    expect(evalTrack(kfs, 1000)).toBe(2)
  })

  it('sorts unordered keyframes before evaluating', () => {
    const shuffled: Keyframe[] = [
      [1000, 10],
      [0, 0],
    ]
    expect(evalTrack(shuffled, 250)).toBeCloseTo(2.5, 10)
    expect(sortKeyframes(shuffled)[0]?.[0]).toBe(0)
  })
})

describe('clip evaluation', () => {
  const wave = parseClip({
    name: 'wave',
    duration: 1000,
    loop: false,
    tracks: {
      'arm.R.rot': [
        [0, 0],
        [500, 18, 'linear'],
        [1000, 0, 'linear'],
      ],
      'arm.R.slot': [
        [0, 'wave'],
        [900, 'down'],
      ],
    },
  })

  it('clamps one-shot clips at their duration', () => {
    expect(evalClip(wave, 500)['arm.R.rot']).toBe(18)
    expect(evalClip(wave, 5000)['arm.R.rot']).toBe(0)
    expect(evalClip(wave, 500)['arm.R.slot']).toBe('wave')
    expect(evalClip(wave, 950)['arm.R.slot']).toBe('down')
  })

  it('wraps looping clips by modulo', () => {
    const loop = parseClip({
      name: 'sway',
      duration: 400,
      loop: true,
      tracks: {
        'body.x': [
          [0, 0],
          [200, 5],
          [400, 0],
        ],
      },
    })
    expect(evalClip(loop, 200)['body.x']).toBe(5)
    expect(evalClip(loop, 600)['body.x']).toBeCloseTo(5, 10)
    expect(evalClip(loop, 700)['body.x']).toBeCloseTo(2.5, 10)
  })

  it('drops unknown track keys; NaN keyframes fail schema parse', () => {
    const weird = parseClip({
      name: 'weird',
      duration: 100,
      loop: false,
      tracks: { notAParam: [[0, 5]] },
    })
    const out = evalClip(weird, 50)
    expect(out.notAParam).toBeUndefined()
    expect(() =>
      parseClip({ name: 'x', duration: 100, loop: false, tracks: { 'body.x': [[0, Number.NaN]] } }),
    ).toThrow()
  })
})

describe('events', () => {
  const clip = parseClip({
    name: 'e',
    duration: 1000,
    loop: false,
    tracks: {},
    events: [
      [0, 'say:hi'],
      [500, 'say:mid'],
    ],
  })

  it('fires events inside (from, to]', () => {
    expect(eventsBetween(clip, 0, 100)).toEqual(['say:hi'])
    expect(eventsBetween(clip, 400, 600)).toEqual(['say:mid'])
    expect(eventsBetween(clip, 600, 2000)).toEqual([])
  })

  it('is loop-aware across wraps', () => {
    const loop = parseClip({
      name: 'le',
      duration: 1000,
      loop: true,
      tracks: {},
      events: [
        [0, 'top'],
        [800, 'late'],
      ],
    })
    expect(eventsBetween(loop, 900, 1100)).toEqual(['top'])
    expect(eventsBetween(loop, 700, 850)).toEqual(['late'])
  })

  it('isEasing guards easing names', () => {
    expect(isEasing('easeOutBack')).toBe(true)
    expect(isEasing('bounce')).toBe(false)
  })
})
