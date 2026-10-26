// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharacterPackError, loadCharacterPack } from './character-pack'

let tempRoot: string

const VALID_MANIFEST = {
  id: 'fixture-pack',
  name: '测试角色',
  version: '0.1.0',
  animations: {
    idle: 'animations/idle.webm',
    click: 'animations/click.webm',
  },
  emotion: {
    rates: { happy: 0.1, bored: 0.05, angry: 0.01, miss: 0.02 },
    gains: {
      click: { happy: 0.08 },
      drag: { happy: 0.12, bored: -0.25 },
      chat: { happy: 0.15, miss: -0.4 },
    },
  },
  behavior: { temperature: 1.2, cooldownMs: 30_000, maxConsecutive: 2, repeatPenalty: 0.5 },
  lines: { click: ['哎哟！'], drag: ['哇——'] },
}

function writePack(
  name: string,
  manifest: unknown,
  options?: { skipLicense?: boolean; skipAnimations?: boolean },
): string {
  const dir = join(tempRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (!options?.skipLicense) writeFileSync(join(dir, 'LICENSE.txt'), 'test license')
  if (!options?.skipAnimations) {
    mkdirSync(join(dir, 'animations'), { recursive: true })
    writeFileSync(join(dir, 'animations', 'idle.webm'), '')
    writeFileSync(join(dir, 'animations', 'click.webm'), '')
  }
  return dir
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'baize-core-test-'))
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('loadCharacterPack', () => {
  it('loads a valid pack with persona and default params', () => {
    const dir = writePack('valid', VALID_MANIFEST)
    mkdirSync(join(dir, 'persona'), { recursive: true })
    writeFileSync(join(dir, 'persona', 'persona.md'), '# persona')
    const pack = loadCharacterPack(dir)
    expect(pack.manifest.id).toBe('fixture-pack')
    expect(pack.manifest.animations.idle).toBe('animations/idle.webm')
    expect(pack.persona).toBe('# persona')
    expect(pack.manifest.emotion?.rates.happy).toBe(0.1)
  })

  it('returns null persona when persona.md is absent', () => {
    const dir = writePack('no-persona', VALID_MANIFEST)
    expect(loadCharacterPack(dir).persona).toBeNull()
  })

  it('rejects a manifest without the idle animation', () => {
    const dir = writePack('no-idle', {
      ...VALID_MANIFEST,
      animations: { click: 'animations/click.webm' },
    })
    expect(() => loadCharacterPack(dir)).toThrow(CharacterPackError)
    expect(() => loadCharacterPack(dir)).toThrow(/idle/)
  })

  it('rejects a broken semver or bad id', () => {
    const dir = writePack('bad-version', { ...VALID_MANIFEST, version: 'one' })
    expect(() => loadCharacterPack(dir)).toThrow(/semver/)
    const dir2 = writePack('bad-id', { ...VALID_MANIFEST, id: 'Bad Id!' })
    expect(() => loadCharacterPack(dir2)).toThrow(/kebab-case/)
  })

  it('rejects a missing LICENSE.txt (asset authorization is mandatory)', () => {
    const dir = writePack('no-license', VALID_MANIFEST, { skipLicense: true })
    expect(() => loadCharacterPack(dir)).toThrow(/LICENSE/)
  })

  it('rejects missing animation files and paths escaping the pack', () => {
    const dir = writePack('missing-file', VALID_MANIFEST, { skipAnimations: true })
    expect(() => loadCharacterPack(dir)).toThrow(/does not exist/)
    const dir2 = writePack('escape', {
      ...VALID_MANIFEST,
      animations: { idle: '../../secret.webm' },
    })
    expect(() => loadCharacterPack(dir2)).toThrow(/escapes/)
  })

  it('rejects invalid JSON and missing directories with readable errors', () => {
    const dir = join(tempRoot, 'broken-json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), '{ not json')
    expect(() => loadCharacterPack(dir)).toThrow(/not valid JSON/)
    expect(() => loadCharacterPack(join(tempRoot, 'does-not-exist'))).toThrow(/not found/)
  })

  it('round-trips the repository placeholder pack', () => {
    const pack = loadCharacterPack(join(__dirname, '../../../characters/placeholder'))
    expect(pack.manifest.id).toBe('placeholder')
    expect(Object.keys(pack.manifest.animations)).toContain('idle')
    expect(pack.manifest.lines?.click?.length).toBeGreaterThan(0)
    expect(pack.persona).toContain('白泽')
  })
})
