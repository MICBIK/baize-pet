// SPDX-License-Identifier: AGPL-3.0-only
import { accessSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CharacterInfo, PetActionName } from '@baize/shared'
import { app } from 'electron'

/**
 * Locates the built-in character packs. In development this is the repository's
 * characters/ directory; in a packaged build they live under process.resourcesPath
 * (see electron-builder.yml extraResources).
 */
export function charactersRoot(): string {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, 'characters')
  }
  return resolve(app.getAppPath(), '../../characters')
}

function assertWithinPack(packDir: string, filePath: string): void {
  const normalized = resolve(filePath)
  if (!normalized.startsWith(resolve(packDir))) {
    throw new Error(`Path escapes character pack directory: ${filePath}`)
  }
}

/**
 * Minimal manifest reader for M1. The full zod-based validation (persona params,
 * emotion config, line pools, LICENSE check) lands in M2 on top of @baize/core.
 */
export function loadCharacter(packId: string): CharacterInfo {
  const packDir = join(charactersRoot(), packId)
  const manifestPath = join(packDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`Character pack not found: ${packId}`)
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    id?: unknown
    animations?: unknown
  }
  if (typeof raw.id !== 'string' || typeof raw.animations !== 'object' || raw.animations === null) {
    throw new Error(`Invalid character manifest: ${manifestPath}`)
  }
  const animations: Partial<Record<PetActionName, string>> = {}
  for (const [action, file] of Object.entries(raw.animations as Record<string, unknown>)) {
    if (typeof file !== 'string') continue
    const filePath = join(packDir, file)
    assertWithinPack(packDir, filePath)
    try {
      accessSync(filePath)
      animations[action as PetActionName] = file
    } catch {
      // Missing animation files are tolerated; the renderer falls back to idle.
    }
  }
  return { id: raw.id, animations: animations as Record<PetActionName, string> }
}
