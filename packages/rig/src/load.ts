// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pack resource loader shared by the desktop RigPlayer and tools/rig-viewer.
 * Takes a pack base URL (any scheme: baize-character:// in the app, http(s)
 * from the Vite dev server in the viewer) and loads rig.json + clips +
 * expressions + every referenced image, plus the optional sprite-sheet layer.
 */

import type { RigParams } from './params.js'
import {
  type Clip,
  parseClip,
  parseExpressions,
  parseRigManifest,
  type RigManifest,
} from './schema.js'

export interface SpriteSheetMeta {
  cell: number
  ground: number
  states: Record<string, { frames: number; durations: number[]; loop: boolean }>
}

export interface RigPackResources {
  manifest: RigManifest
  clips: Map<string, Clip>
  expressions: Map<string, RigParams>
  images: Map<string, HTMLImageElement>
  spriteMeta: SpriteSheetMeta | null
  spriteImages: Map<string, HTMLImageElement>
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.json()
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image load failed: ${url}`))
    img.src = url
  })
}

/** Collect every image path referenced by the manifest (parts/slots/fx). */
function collectImagePaths(manifest: RigManifest): string[] {
  const paths = new Set<string>()
  for (const part of manifest.parts) {
    if (part.image) paths.add(part.image)
    for (const slot of Object.values(part.slots ?? {})) paths.add(slot.image)
  }
  for (const fx of Object.values(manifest.fx ?? {})) paths.add(fx.image)
  return [...paths]
}

export interface LoadRigPackOptions {
  /** Pack-relative path of rig.json (default "rig/rig.json"). */
  rigPath?: string
  /** manifest.animations values, used to find the sprite sheets to preload. */
  animations?: Record<string, string>
}

/**
 * Load everything a rig pack needs to render. `baseUrl` must address the
 * pack root and ends up joined as `${baseUrl}${path}` for every file.
 */
export async function loadRigPack(
  baseUrl: string,
  opts: LoadRigPackOptions = {},
): Promise<RigPackResources> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const rigPath = opts.rigPath ?? 'rig/rig.json'
  const sep = rigPath.lastIndexOf('/')
  const dir = sep >= 0 ? rigPath.slice(0, sep) : ''
  const underRig = (p: string): string => (dir ? `${dir}/${p}` : p)

  const manifest = parseRigManifest(await fetchJson(`${base}${rigPath}`))
  const clips = new Map<string, Clip>()
  for (const clipPath of manifest.clips ?? []) {
    const clip = parseClip(await fetchJson(`${base}${underRig(clipPath)}`))
    clips.set(clip.name, clip)
  }
  const expressions = new Map<string, RigParams>()
  if (manifest.expressions) {
    const file = parseExpressions(await fetchJson(`${base}${underRig(manifest.expressions)}`))
    for (const e of file.expressions) expressions.set(e.name, e.params)
  }

  const images = new Map<string, HTMLImageElement>()
  await Promise.all(
    collectImagePaths(manifest).map(async (p) => {
      images.set(p, await loadImage(`${base}${underRig(p)}`))
    }),
  )

  let spriteMeta: SpriteSheetMeta | null = null
  const spriteImages = new Map<string, HTMLImageElement>()
  try {
    spriteMeta = (await fetchJson(`${base}sprites/sprites.json`)) as SpriteSheetMeta
    const sheets = new Set<string>()
    for (const file of Object.values(opts.animations ?? {})) {
      if (file.startsWith('sprite:')) sheets.add(file.slice(7))
    }
    await Promise.all(
      [...sheets].map(async (sheet) => {
        spriteImages.set(sheet, await loadImage(`${base}sprites/${sheet}.png`))
      }),
    )
  } catch {
    spriteMeta = null // sprite layer is optional
  }

  return { manifest, clips, expressions, images, spriteMeta, spriteImages }
}
