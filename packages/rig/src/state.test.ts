// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import type { Clip } from './schema.js'
import { buildLipFrames, RigStateMachine } from './state.js'

const clip = (over: Partial<Clip> & { name: string }): Clip => ({
  duration: 1000,
  loop: false,
  layer: 'action',
  tracks: {
    'body.y': [
      [0, 0],
      [500, -10],
      [1000, 0],
    ],
  },
  ...over,
})

const idle: Clip = clip({ name: 'idle', loop: true, duration: 3200, tracks: {} })

function machine(extra: Clip[] = []): RigStateMachine {
  return new RigStateMachine([idle, ...extra], {
    baseIdle: 'idle',
    emotionIdle: { happy: 'idle-happy' },
  })
}

describe('action requests', () => {
  it('plays a one-shot then returns to the idle', () => {
    const sm = machine([clip({ name: 'wave' })])
    sm.request('wave', 0)
    expect(sm.currentActionName).toBe('wave')
    const mid = sm.update(500, 16, new Map())
    expect(mid.params['body.y']).toBeCloseTo(-10, 6)
    const after = sm.update(1600, 16, new Map())
    expect(sm.currentActionName).toBe('idle')
    void after
  })

  it('ignores re-requesting the same action within 3 s', () => {
    // Asymmetric tail so "kept original run" and "restarted" differ at t=900.
    const sm = machine([
      clip({
        name: 'hold',
        tracks: {
          'body.y': [
            [0, 0],
            [500, -10],
            [1000, -10],
          ],
        },
      }),
    ])
    sm.request('hold', 0)
    sm.update(500, 16, new Map())
    sm.request('hold', 800) // same action within 3 s: no restart
    const t = sm.update(900, 16, new Map())
    // 900 ms into the ORIGINAL run (a restart would give local t=100 -> -2).
    expect(t.params['body.y']).toBeCloseTo(-10, 0)
  })

  it('chains into next when the clip declares it', () => {
    const sm = machine([
      clip({ name: 'yawn', duration: 500, next: 'fall-asleep' }),
      clip({ name: 'fall-asleep', duration: 400 }),
    ])
    sm.request('yawn', 0)
    sm.update(600, 16, new Map())
    expect(sm.currentActionName).toBe('fall-asleep')
    sm.update(1100, 16, new Map())
    expect(sm.currentActionName).toBe('idle')
  })

  it('switching emotion switches the idle and drops the action', () => {
    const sm = machine([clip({ name: 'idle-happy', loop: true, duration: 1600, tracks: {} })])
    sm.request('idle-happy', 0)
    sm.setEmotion('happy')
    expect(sm.idleName).toBe('idle-happy')
    expect(sm.isBusy).toBe(false)
  })
})

describe('expressions and say', () => {
  it('forces the clip expression while playing and fades back after', () => {
    const sm = machine([clip({ name: 'happy', duration: 300, expression: 'happy' })])
    const exprs = new Map([['happy', { blush: 1 }]])
    sm.request('happy', 0)
    const r1 = sm.update(200, 120, exprs)
    expect(r1.params.blush).toBeGreaterThan(0.5)
    const r2 = sm.update(2000, 120, exprs)
    expect(r2.params.blush).toBe(0)
  })

  it('builds CJK/latin/punctuation lip frames with the right timing', () => {
    const frames = buildLipFrames('你好，hi!')
    // 你/好 = 2 x 110, ，= 200, hi = 160, ! = 200
    const end = frames[frames.length - 1]?.tMs ?? 0
    expect(end).toBeGreaterThanOrEqual(2 * 110 + 200 + 160 + 200 - 1)
    expect(frames.every((f) => f.open >= 0 && f.open <= 1)).toBe(true)
  })

  it('caps the line at 4 s', () => {
    const frames = buildLipFrames('哈'.repeat(100))
    const end = frames[frames.length - 1]?.tMs ?? 0
    expect(end).toBeLessThanOrEqual(4200)
  })

  it('say() starts talk when the clip exists and ends the sequence', () => {
    const talk: Clip = clip({ name: 'talk', loop: true, duration: 800, tracks: {} })
    const sm = machine([talk])
    sm.say('你好', 0)
    expect(sm.currentActionName).toBe('talk')
    // Long after the line ended the say flag clears; mouth returns to smile.
    const r = sm.update(5000, 16, new Map())
    expect(Number(r.params['mouth.open'])).toBe(0)
  })
})
