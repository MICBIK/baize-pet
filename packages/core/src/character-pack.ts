// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { EmotionParams } from './emotion'

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

export const CharacterManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must be lowercase kebab-case'),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, 'must be semver'),
  description: z.string().optional(),
  animations: z
    .record(z.string().min(1), z.string().min(1))
    .refine((animations) => 'idle' in animations, { message: 'the "idle" animation is required' }),
  emotion: EmotionParamsSchema.optional(),
  behavior: BehaviorParamsSchema.optional(),
  lines: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
})

export type CharacterManifest = z.infer<typeof CharacterManifestSchema>

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

  const files = listAnimationFiles(packDir)
  for (const [action, file] of Object.entries(parsed.data.animations)) {
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

  const personaPath = join(packDir, 'persona', 'persona.md')
  const persona = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : null

  return { dir: packDir, manifest: parsed.data, persona }
}

/** Extracts @baize/core emotion parameters from a validated manifest. */
export function emotionParamsOf(manifest: CharacterManifest): EmotionParams | null {
  return manifest.emotion ?? null
}
