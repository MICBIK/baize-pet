// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rig renderer (task book C): Canvas2D at devicePixelRatio, driven by
 * requestAnimationFrame. Loads rig.json + clips + expressions + part images
 * through the CORS-enabled baize-character:// protocol, runs the state
 * machine + procedural life + springs, and draws solved parts in z order.
 */

import {
  type Clip,
  mixLayers,
  ProceduralEngine,
  parseClip,
  parseExpressions,
  parseRigManifest,
  type RigManifest,
  type RigParams,
  RigStateMachine,
  type SolvedPart,
  Spring,
  solve,
} from '@baize/rig'
import type { CharacterInfo } from '@baize/shared'
import { useEffect, useRef } from 'react'
import { packUrl } from './VideoPlayer'

interface RigResources {
  manifest: RigManifest
  clips: Map<string, Clip>
  expressions: Map<string, RigParams>
  images: Map<string, HTMLImageElement>
  spriteMeta: SpriteMetaAlias | null
  spriteImages: Map<string, HTMLImageElement>
}

type SpriteMetaAlias = {
  cell: number
  ground: number
  states: Record<string, { frames: number; durations: number[]; loop: boolean }>
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

/** rig/ directory (the folder holding rig.json), pack-relative. */
function rigDirOf(info: CharacterInfo): string {
  const rig = info.rig ?? 'rig/rig.json'
  const idx = rig.lastIndexOf('/')
  return idx >= 0 ? rig.slice(0, idx) : ''
}

async function loadResources(info: CharacterInfo): Promise<RigResources> {
  const dir = rigDirOf(info)
  const underRig = (p: string): string => (dir ? `${dir}/${p}` : p)

  const manifest = parseRigManifest(await fetchJson(packUrl(info, info.rig ?? 'rig/rig.json')))
  const clips = new Map<string, Clip>()
  for (const clipPath of manifest.clips ?? []) {
    const clip = parseClip(await fetchJson(packUrl(info, underRig(clipPath))))
    clips.set(clip.name, clip)
  }
  const expressions = new Map<string, RigParams>()
  if (manifest.expressions) {
    const file = parseExpressions(await fetchJson(packUrl(info, underRig(manifest.expressions))))
    for (const e of file.expressions) expressions.set(e.name, e.params)
  }

  const images = new Map<string, HTMLImageElement>()
  await Promise.all(
    collectImagePaths(manifest).map(async (p) => {
      images.set(p, await loadImage(packUrl(info, underRig(p))))
    }),
  )

  let spriteMeta: SpriteMetaAlias | null = null
  const spriteImages = new Map<string, HTMLImageElement>()
  try {
    spriteMeta = (await fetchJson(packUrl(info, 'sprites/sprites.json'))) as SpriteMetaAlias
    const sheets = new Set<string>()
    for (const [_action, file] of Object.entries(info.animations)) {
      if (file.startsWith('sprite:')) sheets.add(file.slice(7))
    }
    await Promise.all(
      [...sheets].map(async (sheet) => {
        spriteImages.set(sheet, await loadImage(packUrl(info, `sprites/${sheet}.png`)))
      }),
    )
  } catch {
    spriteMeta = null // sprite layer is optional
  }

  return { manifest, clips, expressions, images, spriteMeta, spriteImages }
}

export interface RigPlayerProps {
  info: CharacterInfo
  /** Current requested action (PetLayer state). */
  action: string
  /** Say line + sequence counter; a new counter restarts lip sync. */
  say: { line: string; seq: number } | null
  /** Cursor position in window coords (from onCursor), or null. */
  cursor: { x: number; y: number } | null
  onLoaded?: () => void
}

export function RigPlayer(props: RigPlayerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const resourcesRef = useRef<RigResources | null>(null)
  const stateRef = useRef<RigStateMachine | null>(null)
  const actionRef = useRef(props.action)
  const sayRef = useRef(props.say)
  const cursorRef = useRef(props.cursor)
  actionRef.current = props.action
  sayRef.current = props.say
  cursorRef.current = props.cursor

  useEffect(() => {
    let cancelled = false
    loadResources(props.info)
      .then((res) => {
        if (cancelled) return
        resourcesRef.current = res
        stateRef.current = new RigStateMachine([...res.clips.values()], {
          baseIdle: 'idle',
          emotionIdle: {},
        })
        props.onLoaded?.()
      })
      .catch((error: unknown) => console.error('rig load failed:', error))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.info.id, props.info, props.onLoaded])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const engine = new ProceduralEngine()
    const springs = {
      earL: new Spring('ear'),
      earR: new Spring('ear'),
      tail: new Spring('tail'),
      stringL: new Spring('string'),
      stringR: new Spring('string'),
    }
    let clock = 0
    let lastFrame = performance.now()
    let raf = 0
    let lastSeq = -1
    let requestedAction = props.action

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const res = resourcesRef.current
      if (!res) return
      const dt = Math.min(100, now - lastFrame)
      lastFrame = now
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (document.hidden || dt <= 0) return // freeze instead of animating hidden

      clock += dt
      const dpr = window.devicePixelRatio || 1
      const size = canvas.width / Math.max(1, dpr)
      if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
        canvas.width = Math.round(canvas.clientWidth * dpr)
        canvas.height = Math.round(canvas.clientHeight * dpr)
      }

      // --- request pending action / say -------------------------------------
      const state = stateRef.current
      if (!state) return
      if (sayRef.current && sayRef.current.seq !== lastSeq) {
        state.say(sayRef.current.line, clock)
        lastSeq = sayRef.current.seq
      }
      if (actionRef.current !== requestedAction) {
        state.request(actionRef.current, clock)
        requestedAction = actionRef.current
      }

      // --- state machine + procedural + springs ------------------------------
      const cursor = cursorRef.current
      const look = cursor
        ? {
            x: clampLook((cursor.x - size / 2) / 160),
            y: clampLook((cursor.y - size * 0.45) / 160),
          }
        : undefined
      const proc = engine.tick({ tMs: clock, dtMs: dt, look: reduceMotion ? undefined : look })
      if (proc.earImpulse) {
        ;(proc.earImpulse.side === 'L' ? springs.earL : springs.earR).kick(proc.earImpulse.velocity)
      }
      const physics: RigParams = {
        'ear.L.rot': springs.earL.step(dt),
        'ear.R.rot': springs.earR.step(dt),
        'tail.rot': springs.tail.step(dt),
        'string.L.rot': springs.stringL.step(dt),
        'string.R.rot': springs.stringR.step(dt),
      }

      const out = state.update(clock, dt, res.expressions)
      // The state machine already mixed base/action/expression; stack the
      // procedural life and spring physics on top.
      const params = mixLayers({ base: out.params, procedural: proc.params, physics })
      const parts = solve(res.manifest, params)
      drawParts(ctx, res, parts, dpr, size)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.action])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

function clampLook(v: number): number {
  return Math.min(1, Math.max(-1, v))
}

/**
 * Anchor mapping (task book 四): hood width -> 92/256 of the window, feet on
 * ground 246/256. Returns the master-px -> display-px scale and offsets.
 */
export function anchorTransform(
  manifest: RigManifest,
  sizeCss: number,
): { scale: number; offsetX: number; offsetY: number } {
  const a = manifest.anchor
  const masterW = manifest.master.width
  const hoodMaster = (a.hoodWidth / masterW) * manifest.master.width // sanity alias
  void hoodMaster
  const scale = ((92 / 256) * sizeCss) / a.hoodWidth
  const offsetX = sizeCss / 2 - a.centerX * scale
  const offsetY = (246 / 256) * sizeCss - a.groundY * scale
  return { scale, offsetX, offsetY }
}

/** Draw solved parts in master coordinates under the anchor transform. */
function drawParts(
  ctx: CanvasRenderingContext2D,
  res: RigResources,
  parts: SolvedPart[],
  dpr: number,
  sizeCss: number,
): void {
  const { scale, offsetX, offsetY } = anchorTransform(res.manifest, sizeCss)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  for (const sp of parts) {
    const img = res.images.get(sp.image)
    if (!img) continue
    ctx.save()
    ctx.globalAlpha = sp.opacity
    if (sp.blend === 'lighter') ctx.globalCompositeOperation = 'lighter'

    // Squash around the feet, then rotate around the (moved) pivot.
    ctx.translate(sp.scalePivot[0], sp.scalePivot[1])
    ctx.scale(sp.scaleX, sp.scaleY)
    ctx.translate(-sp.scalePivot[0], -sp.scalePivot[1])
    ctx.translate(sp.pivot[0] + sp.dx, sp.pivot[1] + sp.dy)
    ctx.rotate((sp.rotDeg * Math.PI) / 180)
    ctx.translate(-sp.pivot[0], -sp.pivot[1])

    const w = img.naturalWidth
    const h = img.naturalHeight
    if (sp.mirrored) {
      ctx.translate(sp.restX + w / 2, sp.restY + h / 2)
      ctx.scale(-1, 1)
      ctx.drawImage(img, -w / 2, -h / 2)
    } else {
      ctx.drawImage(img, sp.restX, sp.restY)
    }

    // Iris: shift inside the eye-white mask (source-in clip via scratch).
    if (sp.irisShift && sp.clipImage) {
      const mask = res.images.get(sp.clipImage)
      if (mask) {
        ctx.restore()
        ctx.save()
        drawIrisClipped(ctx, img, mask, sp, res)
        ctx.restore()
        continue
      }
    }
    ctx.restore()
  }
}

/** One-frame iris composite: iris shifted, masked by the eye-white alpha. */
function drawIrisClipped(
  ctx: CanvasRenderingContext2D,
  iris: HTMLImageElement,
  mask: HTMLImageElement,
  sp: SolvedPart,
  res: RigResources,
): void {
  void res
  const scratch = document.createElement('canvas')
  scratch.width = iris.naturalWidth
  scratch.height = iris.naturalHeight
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  sctx.drawImage(iris, 0, 0)
  sctx.globalCompositeOperation = 'source-in'
  const maskX = sp.clipRestX ?? 0
  const maskY = sp.clipRestY ?? 0
  sctx.drawImage(mask, -maskX, -maskY)
  ctx.drawImage(scratch, sp.restX + (sp.irisShift?.dx ?? 0), sp.restY + (sp.irisShift?.dy ?? 0))
}
