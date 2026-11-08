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

  it('accepts declarative scenes and passes candidates through', () => {
    const dir = writePack('with-scenes', {
      ...VALID_MANIFEST,
      scenes: [
        {
          id: 'idle_spontaneous',
          candidates: [
            { action: 'idle_nap', baseWeight: 1, emotionAffinity: { happy: -0.4, bored: 0.6 } },
            { action: 'idle_look', baseWeight: 1.2 },
          ],
        },
      ],
    })
    const pack = loadCharacterPack(dir)
    expect(pack.manifest.scenes).toHaveLength(1)
    expect(pack.manifest.scenes?.[0]?.candidates).toHaveLength(2)
    expect(pack.manifest.scenes?.[0]?.candidates[0]?.emotionAffinity?.bored).toBe(0.6)
  })

  it('rejects malformed scenes (empty candidates, bad baseWeight, bad hourRange)', () => {
    const empty = writePack('scenes-empty', {
      ...VALID_MANIFEST,
      scenes: [{ id: 's', candidates: [] }],
    })
    expect(() => loadCharacterPack(empty)).toThrow(/candidates/)
    const weight = writePack('scenes-weight', {
      ...VALID_MANIFEST,
      scenes: [{ id: 's', candidates: [{ action: 'a', baseWeight: 0 }] }],
    })
    expect(() => loadCharacterPack(weight)).toThrow(/baseWeight/)
    const hours = writePack('scenes-hours', {
      ...VALID_MANIFEST,
      scenes: [{ id: 's', candidates: [{ action: 'a', baseWeight: 1, hourRange: [7, 99] }] }],
    })
    expect(() => loadCharacterPack(hours)).toThrow(/hourRange/)
  })

  it('round-trips the repository placeholder pack', () => {
    const pack = loadCharacterPack(join(__dirname, '../../../characters/placeholder'))
    expect(pack.manifest.id).toBe('placeholder')
    expect(Object.keys(pack.manifest.animations)).toContain('idle')
    expect(pack.manifest.lines?.click?.length).toBeGreaterThan(0)
    expect(pack.manifest.scenes?.[0]?.candidates.length).toBeGreaterThanOrEqual(3)
    expect(pack.persona).toContain('白泽')
  })

  it('round-trips the repository baize-b3 rig pack', () => {
    const pack = loadCharacterPack(join(__dirname, '../../../characters/baize-b3'))
    expect(pack.manifest.id).toBe('baize-b3')
    expect(pack.manifest.renderer).toBe('rig')
    expect(pack.manifest.animations.idle).toBe('rig:idle')
    expect(pack.manifest.animations.dance).toBe('sprite:dance')
    expect(Object.keys(pack.manifest.animations).length).toBeGreaterThanOrEqual(39)
    expect(pack.manifest.lines?.click?.length).toBeGreaterThan(0)
  })

  it('defaults renderer to video for legacy packs', () => {
    const dir = writePack('default-renderer', VALID_MANIFEST)
    expect(loadCharacterPack(dir).manifest.renderer).toBe('video')
  })
})

describe('rig packs', () => {
  const RIG_JSON = {
    version: 1,
    master: { width: 690, height: 1024, scale: 0.5 },
    anchor: { hoodWidth: 184, groundY: 1013, centerX: 345 },
    parts: [
      { id: 'tail', image: 'parts/tail.png', x: 1, y: 2, z: 0, parent: 'body', pivot: [3, 4] },
      {
        id: 'arm-R',
        z: 40,
        parent: 'body',
        pivot: [5, 6],
        slots: { down: { image: 'parts/arm-R.down.png', x: 7, y: 8 } },
      },
    ],
    groups: { body: { pivot: [345, 1013] } },
    clips: ['clips/idle.json', 'clips/wave.json'],
  }

  function writeRigPack(
    name: string,
    manifest: Record<string, unknown>,
    options?: { rigJson?: Record<string, unknown>; skipParts?: boolean; skipClips?: boolean },
  ): string {
    const dir = writePack(name, manifest)
    const rigDir = join(dir, 'rig')
    mkdirSync(rigDir, { recursive: true })
    writeFileSync(join(rigDir, 'rig.json'), JSON.stringify(options?.rigJson ?? RIG_JSON))
    if (!options?.skipParts) {
      mkdirSync(join(rigDir, 'parts'), { recursive: true })
      writeFileSync(join(rigDir, 'parts', 'tail.png'), 'png')
      writeFileSync(join(rigDir, 'parts', 'arm-R.down.png'), 'png')
    }
    if (!options?.skipClips) {
      mkdirSync(join(rigDir, 'clips'), { recursive: true })
      writeFileSync(join(rigDir, 'clips', 'idle.json'), '{}')
      writeFileSync(join(rigDir, 'clips', 'wave.json'), '{}')
    }
    return dir
  }

  const RIG_MANIFEST = {
    id: 'rig-pack',
    name: 'Rig 测试',
    version: '1.0.0',
    renderer: 'rig',
    rig: 'rig/rig.json',
    animations: { idle: 'rig:idle', wave: 'rig:wave', dance: 'sprite:dance' },
  }

  it('loads a legal rig pack with prefixed animations', () => {
    const dir = writeRigPack('rig-ok', RIG_MANIFEST)
    mkdirSync(join(dir, 'sprites'), { recursive: true })
    writeFileSync(
      join(dir, 'sprites', 'sprites.json'),
      JSON.stringify({ states: { dance: { frames: 8 } } }),
    )
    const pack = loadCharacterPack(dir)
    expect(pack.manifest.renderer).toBe('rig')
    expect(pack.manifest.animations.wave).toBe('rig:wave')
  })

  it('rejects renderer rig without the rig field', () => {
    const dir = writeRigPack('rig-nofield', { ...RIG_MANIFEST, rig: undefined })
    expect(() => loadCharacterPack(dir)).toThrow(/"rig" field/)
  })

  it('rejects a rig clip not declared in rig.json', () => {
    const dir = writeRigPack('rig-badclip', { ...RIG_MANIFEST, animations: { idle: 'rig:nope' } })
    expect(() => loadCharacterPack(dir)).toThrow(/not declared/)
  })

  it('rejects a sprite sheet missing from sprites.json', () => {
    const dir = writeRigPack('rig-badsprite', RIG_MANIFEST)
    mkdirSync(join(dir, 'sprites'), { recursive: true })
    writeFileSync(join(dir, 'sprites', 'sprites.json'), JSON.stringify({ states: { other: {} } }))
    expect(() => loadCharacterPack(dir)).toThrow(/not in sprites.json/)
  })

  it('rejects rig part images that are missing or escape the pack', () => {
    const noSprite = { ...RIG_MANIFEST, animations: { idle: 'rig:idle', wave: 'rig:wave' } }
    const dir = writeRigPack('rig-missing-part', noSprite, { skipParts: true })
    expect(() => loadCharacterPack(dir)).toThrow(/does not exist/)
    const escapeJson = {
      ...RIG_JSON,
      parts: [{ id: 'x', image: '../evil.png', z: 1, pivot: [0, 0] }],
    }
    const dir2 = writeRigPack('rig-escape-part', noSprite, { rigJson: escapeJson })
    expect(() => loadCharacterPack(dir2)).toThrow(/escapes|unsafe/)
  })

  it('rejects rig: animations on video packs', () => {
    const dir = writePack('rig-on-video', {
      id: 'mixed',
      name: '混合',
      version: '1.0.0',
      animations: { idle: 'rig:idle' },
    })
    mkdirSync(join(dir, 'rig', 'clips'), { recursive: true })
    writeFileSync(join(dir, 'rig', 'rig.json'), '{}')
    writeFileSync(join(dir, 'rig', 'clips', 'idle.json'), '{}')
    expect(() => loadCharacterPack(dir)).toThrow(/requires renderer/)
  })
})

describe('p2l packs', () => {
  const P2L_MANIFEST = {
    id: 'p2l-pack',
    name: '网格角色',
    version: '1.0.0',
    renderer: 'p2l',
    model: 'p2l/model.p2lrt',
    animations: { idle: 'p2l:Idle', happy: 'p2l:Happy@Smile', shy: 'p2l:@Shy' },
  }

  function writeP2lPack(name: string, manifest: unknown, withModel = true): string {
    const dir = writePack(name, manifest, { skipAnimations: true })
    if (withModel) {
      mkdirSync(join(dir, 'p2l'), { recursive: true })
      writeFileSync(join(dir, 'p2l', 'model.p2lrt'), 'P2L')
    }
    return dir
  }

  it('accepts a p2l pack with clip and expression forms', () => {
    const pack = loadCharacterPack(writeP2lPack('p2l-ok', P2L_MANIFEST))
    expect(pack.manifest.renderer).toBe('p2l')
    expect(pack.manifest.model).toBe('p2l/model.p2lrt')
    expect(pack.manifest.animations.happy).toBe('p2l:Happy@Smile')
  })

  it('requires an existing .p2lrt model inside the pack', () => {
    expect(() =>
      loadCharacterPack(writeP2lPack('p2l-nofield', { ...P2L_MANIFEST, model: undefined })),
    ).toThrow(/"model" field/)
    expect(() => loadCharacterPack(writeP2lPack('p2l-missing', P2L_MANIFEST, false))).toThrow(
      /does not exist/,
    )
    expect(() =>
      loadCharacterPack(writeP2lPack('p2l-escape', { ...P2L_MANIFEST, model: '../x.p2lrt' })),
    ).toThrow(/unsafe/)
    expect(() =>
      loadCharacterPack(writeP2lPack('p2l-ext', { ...P2L_MANIFEST, model: 'p2l/model.json' })),
    ).toThrow(/unsafe|\.p2lrt/)
  })

  it('rejects malformed p2l: values and p2l: on other renderers', () => {
    expect(() =>
      loadCharacterPack(
        writeP2lPack('p2l-bad', { ...P2L_MANIFEST, animations: { idle: 'p2l:@' } }),
      ),
    ).toThrow(/malformed/)
    expect(() =>
      loadCharacterPack(
        writeP2lPack('p2l-bad2', { ...P2L_MANIFEST, animations: { idle: 'p2l:a b' } }),
      ),
    ).toThrow(/malformed/)
    const dir = writePack('p2l-on-video', {
      ...VALID_MANIFEST,
      animations: { ...VALID_MANIFEST.animations, wave: 'p2l:Wave' },
    })
    expect(() => loadCharacterPack(dir)).toThrow(/requires renderer "p2l"/)
  })
})
