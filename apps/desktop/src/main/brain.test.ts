// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PetBrain } from './brain'

// The repository placeholder pack: spontaneous scenes come from its manifest.
const PLACEHOLDER_PACK = new URL('../../../../characters/placeholder', import.meta.url).pathname

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'baize-brain-test-'))
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/** Minimal pack without a scenes field — exercises the fallback rule. */
function writeScenelessPack(): string {
  const dir = join(tempRoot, 'sceneless')
  mkdirSync(join(dir, 'animations'), { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'sceneless',
      name: '无场景测试包',
      version: '0.1.0',
      animations: { idle: 'animations/idle.webm' },
    }),
  )
  writeFileSync(join(dir, 'animations', 'idle.webm'), '')
  writeFileSync(join(dir, 'LICENSE.txt'), 'test license')
  return dir
}

describe('PetBrain', () => {
  it('drives spontaneous picks from the manifest scenes', () => {
    const brain = new PetBrain(PLACEHOLDER_PACK)
    const scene = brain.manifest.scenes?.[0]
    const allowedActions = new Set(scene?.candidates.map((candidate) => candidate.action))
    expect(allowedActions.size).toBeGreaterThanOrEqual(3)
    const t0 = Date.now()
    const first = brain.tick(t0)
    expect(first && allowedActions.has(first.action)).toBe(true)
    // Within the pack cooldown no further spontaneous action is produced.
    expect(brain.tick(t0 + 5_000)).toBeNull()
    expect(brain.tick(t0 + 60_000)).not.toBeNull()
  })

  it('falls back to a single idle candidate for packs without scenes', () => {
    const brain = new PetBrain(writeScenelessPack())
    expect(brain.manifest.scenes).toBeUndefined()
    // The single-candidate fallback must never deadlock (maxConsecutive relaxed).
    for (let i = 0; i < 3; i++) {
      const pick = brain.tick(Date.now() + i * 10 * 60_000)
      expect(pick?.action).toBe('idle_nap')
    }
  })

  it('decays emotion over elapsed idle time before applying interaction gains', () => {
    const brain = new PetBrain(PLACEHOLDER_PACK)
    const t0 = 10_000_000
    brain.tick(t0)
    // One hour of idle decay (happy -0.08) before the click gain (+0.08) nets 0.6;
    // without the decay-first fix this would be 0.68.
    brain.onInteraction('click', t0 + 3_600_000)
    expect(brain.emotionVector.happy).toBeCloseTo(0.6, 5)
    expect(brain.emotionVector.happy).toBeLessThan(0.68)
  })
})
