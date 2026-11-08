// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isSafePackRelPath } from '@baize/rig'
import { z } from 'zod'
import type { EmotionParams } from './emotion'

/** Light structural view of rig.json used for pack validation. */
interface RigManifestData {
  clips?: unknown
  parts?: unknown
}

/** Zod schema for a character pack manifest (see docs/03 §3.1). */
export const EmotionRatesSchema = z.object({
  happy: z.number().min(0).max(1),
  bored: z.number().min(0).max(1),
  angry: z.number().min(0).max(1),
  miss: z.number().min(0).max(1),
})

export const InteractionGainsSchema = z.object({
  click: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  drag: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  chat: z.record(z.string(), z.number().min(-1).max(1)).default({}),
})

export const EmotionParamsSchema = z.object({
  rates: EmotionRatesSchema,
  gains: InteractionGainsSchema,
})

export const BehaviorParamsSchema = z.object({
  temperature: z.number().positive(),
  cooldownMs: z.number().int().nonnegative(),
  maxConsecutive: z.number().int().positive(),
  repeatPenalty: z.number().min(0).max(1),
})

/** One candidate action inside a manifest scene (mirrors @baize/core CandidateAction). */
export const SceneCandidateSchema = z.object({
  action: z.string().min(1),
  baseWeight: z.number().positive(),
  emotionAffinity: z
    .object({
      happy: z.number().min(-5).max(5),
      bored: z.number().min(-5).max(5),
      angry: z.number().min(-5).max(5),
      miss: z.number().min(-5).max(5),
    })
    .partial()
    .optional(),
  /** Inclusive hour-of-day range [start, end]; may wrap midnight (e.g. [22, 6]). */
  hourRange: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).optional(),
})

/** A declarative scene: id + candidate actions (see docs/03 §3.3). */
export const SceneSchema = z.object({
  id: z.string().min(1),
  candidates: z.array(SceneCandidateSchema).min(1),
})

export const CharacterManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must be lowercase kebab-case'),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, 'must be semver'),
  description: z.string().optional(),
  /**
   * Renderer kind: "video" (webm, default), "rig" (layered parts) or "p2l"
   * (PSD2Live mesh model played by the vendored MIT web player, ADR 0008).
   */
  renderer: z.enum(['video', 'rig', 'p2l']).default('video'),
  /** rig.json path relative to the pack root; required when renderer is "rig". */
  rig: z.string().optional(),
  /** .p2lrt model path relative to the pack root; required when renderer is "p2l". */
  model: z.string().optional(),
  /**
   * Action name -> animation. Value forms: "rig:<clip>" (rig clip),
   * "sprite:<sheet>" (atlas sheet in sprites/sprites.json),
   * "p2l:<clip>[@<expression>]" (p2l model clip and/or expression; either
   * may be empty but not both) or a plain pack-relative file path (video).
   */
  animations: z
    .record(z.string().min(1), z.string().min(1))
    .refine((animations) => 'idle' in animations, { message: 'the "idle" animation is required' }),
  emotion: EmotionParamsSchema.optional(),
  behavior: BehaviorParamsSchema.optional(),
  /** Optional declarative scenes for spontaneous behavior; packs may omit it. */
  scenes: z.array(SceneSchema).optional(),
  lines: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
})

export type CharacterManifest = z.infer<typeof CharacterManifestSchema>

/** "p2l:<clip>[@<expression>]" with at least one of the two names present. */
const P2L_ANIMATION = /^p2l:(?:[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?|@[A-Za-z0-9._-]+)$/

/** Raised with a human-readable summary of what is wrong with a pack. */
export class CharacterPackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterPackError'
  }
}

export interface LoadedCharacterPack {
  dir: string
  manifest: CharacterManifest
  /** Contents of persona/persona.md, or null when the pack has none. */
  persona: string | null
}

function listAnimationFiles(dir: string): Set<string> {
  const files = new Set<string>()
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        files.add(path)
      }
    }
  }
  walk(dir)
  return files
}

/**
 * Loads and validates a character pack directory:
 * manifest.json must parse against the schema, referenced animation files must
 * exist, and a LICENSE.txt (asset authorization statement) must be present.
 */
export function loadCharacterPack(dir: string): LoadedCharacterPack {
  const packDir = resolve(dir)
  if (!statSync(packDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CharacterPackError(`Character pack directory not found: ${packDir}`)
  }

  const manifestPath = join(packDir, 'manifest.json')
  let rawJson: unknown
  try {
    rawJson = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new CharacterPackError(
      `manifest.json is missing or not valid JSON (${manifestPath}): ${(error as Error).message}`,
    )
  }

  const parsed = CharacterManifestSchema.safeParse(rawJson)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new CharacterPackError(`Invalid character manifest: ${issues}`)
  }

  if (!existsSync(join(packDir, 'LICENSE.txt'))) {
    throw new CharacterPackError(
      `Character pack is missing LICENSE.txt (asset authorization statement): ${packDir}`,
    )
  }

  // Rig packs: rig.json must exist and referenced assets must stay inside.
  let rigData: RigManifestData | null = null
  if (parsed.data.renderer === 'rig') {
    if (!parsed.data.rig) {
      throw new CharacterPackError(`Rig pack is missing the "rig" field: ${packDir}`)
    }
    if (!isSafePackRelPath(parsed.data.rig)) {
      throw new CharacterPackError(`rig path is unsafe: ${parsed.data.rig}`)
    }
    const rigPath = resolve(packDir, parsed.data.rig)
    if (!rigPath.startsWith(packDir)) {
      throw new CharacterPackError(`rig path escapes the pack directory: ${parsed.data.rig}`)
    }
    try {
      rigData = JSON.parse(readFileSync(rigPath, 'utf8')) as RigManifestData
    } catch {
      throw new CharacterPackError(`rig.json is missing or not valid JSON: ${rigPath}`)
    }
  }

  if (parsed.data.renderer === 'p2l') {
    const model = parsed.data.model
    if (!model) {
      throw new CharacterPackError(`p2l pack is missing the "model" field: ${packDir}`)
    }
    if (!isSafePackRelPath(model) || !model.endsWith('.p2lrt')) {
      throw new CharacterPackError(`p2l model path is unsafe or not a .p2lrt file: ${model}`)
    }
    const modelPath = resolve(packDir, model)
    if (!modelPath.startsWith(packDir) || !existsSync(modelPath)) {
      throw new CharacterPackError(`p2l model does not exist inside the pack: ${model}`)
    }
  }

  const files = listAnimationFiles(packDir)
  const spritesJsonPath = join(packDir, 'sprites', 'sprites.json')
  let spriteStates: { states?: Record<string, unknown> } | null = null
  const readSpriteStates = (): { states?: Record<string, unknown> } => {
    if (spriteStates) return spriteStates
    if (!existsSync(spritesJsonPath)) {
      throw new CharacterPackError(`sprite: animation requires sprites/sprites.json: ${packDir}`)
    }
    spriteStates = JSON.parse(readFileSync(spritesJsonPath, 'utf8')) as {
      states?: Record<string, unknown>
    }
    return spriteStates
  }

  for (const [action, file] of Object.entries(parsed.data.animations)) {
    if (file.startsWith('rig:')) {
      if (parsed.data.renderer !== 'rig') {
        throw new CharacterPackError(`rig: animation for "${action}" requires renderer "rig"`)
      }
      const clipName = file.slice(4)
      if (!/^[A-Za-z0-9._-]+$/.test(clipName)) {
        throw new CharacterPackError(`rig: clip name for "${action}" is unsafe: ${file}`)
      }
      continue // existence checked below against rigData.clips
    }
    if (file.startsWith('p2l:')) {
      if (parsed.data.renderer !== 'p2l') {
        throw new CharacterPackError(`p2l: animation for "${action}" requires renderer "p2l"`)
      }
      if (!P2L_ANIMATION.test(file)) {
        throw new CharacterPackError(`p2l: animation for "${action}" is malformed: ${file}`)
      }
      continue
    }
    if (file.startsWith('sprite:')) {
      const sheet = file.slice(7)
      const states = readSpriteStates().states ?? {}
      if (!(sheet in states)) {
        throw new CharacterPackError(
          `sprite: sheet "${sheet}" (action "${action}") is not in sprites.json`,
        )
      }
      continue
    }
    const animationPath = resolve(packDir, file)
    if (!animationPath.startsWith(packDir)) {
      throw new CharacterPackError(
        `Animation path for "${action}" escapes the pack directory: ${file}`,
      )
    }
    if (!files.has(animationPath)) {
      throw new CharacterPackError(`Animation file for "${action}" does not exist: ${file}`)
    }
  }

  // Rig asset checks: clips exist, images exist, no path escapes.
  if (rigData) {
    const rigDir = resolve(packDir, parsed.data.rig ? dirname(parsed.data.rig) : '.')
    const declaredClips = new Set(
      Array.isArray(rigData.clips) ? rigData.clips.map((c) => basename(String(c))) : [],
    )
    for (const [action, file] of Object.entries(parsed.data.animations)) {
      if (!file.startsWith('rig:')) continue
      const clipName = file.slice(4)
      if (!declaredClips.has(`${clipName}.json`)) {
        throw new CharacterPackError(
          `rig: clip "${clipName}" (action "${action}") is not declared in rig.json`,
        )
      }
    }
    const images: string[] = []
    for (const part of Array.isArray(rigData.parts) ? rigData.parts : []) {
      const p = part as { image?: unknown; slots?: Record<string, { image?: unknown }> }
      if (typeof p.image === 'string') images.push(p.image)
      for (const slot of Object.values(p.slots ?? {})) {
        if (typeof slot?.image === 'string') images.push(slot.image)
      }
    }
    for (const image of images) {
      if (!isSafePackRelPath(image)) {
        throw new CharacterPackError(`rig part image path is unsafe: ${image}`)
      }
      const imagePath = resolve(rigDir, image)
      if (!imagePath.startsWith(packDir)) {
        throw new CharacterPackError(`rig part image escapes the pack directory: ${image}`)
      }
      if (!files.has(imagePath)) {
        throw new CharacterPackError(`rig part image does not exist: ${image}`)
      }
    }
  }

  const personaPath = join(packDir, 'persona', 'persona.md')
  const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : null

  return { dir: packDir, manifest: parsed.data, persona }
}

/** Extracts @baize/core emotion parameters from a validated manifest. */
export function emotionParamsOf(manifest: CharacterManifest): EmotionParams | null {
  return manifest.emotion ?? null
}
