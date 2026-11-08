// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Canvas2D renderer: one source of truth used by the desktop
 * RigPlayer and the tools/rig-viewer debug page, so contact-sheet QA on the
 * viewer is meaningful for the app. Contains the anchor mapping (hood width
 * -> 92/256 of the window, feet on ground 246/256), part draw order with
 * squash/rotate composition, and the iris-in-eye-white clip. The offscreen
 * scratch canvas for the iris clip is allocated once and reused (task book
 * F9: no per-frame canvas allocation).
 */

import type { RigManifest, RigPoint } from './schema.js'
import type { SolvedPart } from './solver.js'

export type RigPaintable = HTMLImageElement

export interface RigRenderOptions {
  /** Debug overlay: pivot crosshairs, parent links, ground/hood guides. */
  showPivots?: boolean
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
  const scale = ((92 / 256) * sizeCss) / a.hoodWidth
  const offsetX = sizeCss / 2 - a.centerX * scale
  const offsetY = (246 / 256) * sizeCss - a.groundY * scale
  return { scale, offsetX, offsetY }
}

/**
 * Draw solved parts in master coordinates under the anchor transform.
 * `images` maps pack-relative image paths (sp.image / sp.clipImage) to
 * loaded elements.
 */
export function drawRigFrame(
  ctx: CanvasRenderingContext2D,
  manifest: RigManifest,
  images: ReadonlyMap<string, RigPaintable>,
  parts: SolvedPart[],
  dpr: number,
  sizeCss: number,
  opts: RigRenderOptions = {},
): void {
  const { scale, offsetX, offsetY } = anchorTransform(manifest, sizeCss)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  // Part PNGs are exported at master.scale (0.5x) while rig.json coordinates
  // are master px: draw each image scaled back up into master space.
  const k = 1 / (manifest.master.scale > 0 ? manifest.master.scale : 1)

  for (const sp of parts) {
    const img = images.get(sp.image)
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

    const w = img.naturalWidth * k
    const h = img.naturalHeight * k
    // Iris: shifted inside the eye-white mask, drawn under the part's own
    // transform so it follows head tilt / parallax / breath like the eye.
    const irisMask = sp.irisShift && sp.clipImage ? images.get(sp.clipImage) : undefined
    if (irisMask) {
      drawIrisClipped(ctx, img, irisMask, sp, k)
    } else if (sp.mirrored) {
      ctx.translate(sp.restX + w / 2, sp.restY + h / 2)
      ctx.scale(-1, 1)
      ctx.drawImage(img, -w / 2, -h / 2, w, h)
    } else {
      ctx.drawImage(img, sp.restX, sp.restY, w, h)
    }
    ctx.restore()
  }

  if (opts.showPivots) drawPivotOverlay(ctx, manifest, parts, dpr, sizeCss)
}

/**
 * One-frame iris composite: the iris shifted by irisShift, clipped to the
 * eye-white mask that stays put. Draws in the caller's current transform
 * (the iris part's pose), so the result moves with the head.
 */
function drawIrisClipped(
  ctx: CanvasRenderingContext2D,
  iris: RigPaintable,
  mask: RigPaintable,
  sp: SolvedPart,
  k: number,
): void {
  const scratch = irisScratch(iris.naturalWidth, iris.naturalHeight)
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  const shiftX = sp.irisShift?.dx ?? 0
  const shiftY = sp.irisShift?.dy ?? 0
  sctx.clearRect(0, 0, scratch.width, scratch.height)
  sctx.drawImage(iris, 0, 0)
  // Keep the iris only where the eye white is. The mask is fixed in master
  // space while the iris moves, so offset it by the shift (pack px).
  sctx.globalCompositeOperation = 'destination-in'
  const maskX = ((sp.clipRestX ?? sp.restX) - (sp.restX + shiftX)) / k
  const maskY = ((sp.clipRestY ?? sp.restY) - (sp.restY + shiftY)) / k
  sctx.drawImage(eyeOpening(mask), maskX, maskY)
  sctx.globalCompositeOperation = 'source-over'
  const w = iris.naturalWidth * k
  const h = iris.naturalHeight * k
  ctx.drawImage(
    scratch,
    0,
    0,
    iris.naturalWidth,
    iris.naturalHeight,
    sp.restX + shiftX,
    sp.restY + shiftY,
    w,
    h,
  )
}

const OPENINGS = new WeakMap<RigPaintable, CanvasImageSource>()

/**
 * The eye-white image has a transparent hole where the iris sits (the iris
 * is its own part). Clip with the whole eye opening instead: the white's
 * alpha with every enclosed hole filled. Cached per image; falls back to the
 * raw white when pixels cannot be read.
 */
function eyeOpening(mask: RigPaintable): CanvasImageSource {
  const hit = OPENINGS.get(mask)
  if (hit) return hit
  let out: CanvasImageSource = mask
  try {
    const w = mask.naturalWidth
    const h = mask.naturalHeight
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const cx = c.getContext('2d')
    if (cx && w > 0 && h > 0) {
      cx.drawImage(mask, 0, 0)
      const data = cx.getImageData(0, 0, w, h)
      const px = data.data
      // Flood the outside (transparent pixels reachable from the border).
      const outside = new Uint8Array(w * h)
      const stack: number[] = []
      const push = (i: number) => {
        if (!outside[i] && (px[i * 4 + 3] ?? 0) < 128) {
          outside[i] = 1
          stack.push(i)
        }
      }
      for (let x = 0; x < w; x++) {
        push(x)
        push((h - 1) * w + x)
      }
      for (let y = 0; y < h; y++) {
        push(y * w)
        push(y * w + w - 1)
      }
      while (stack.length > 0) {
        const i = stack.pop() as number
        const x = i % w
        if (x > 0) push(i - 1)
        if (x < w - 1) push(i + 1)
        if (i >= w) push(i - w)
        if (i < w * (h - 1)) push(i + w)
      }
      for (let i = 0; i < w * h; i++) {
        if (!outside[i]) px[i * 4 + 3] = 255
      }
      cx.putImageData(data, 0, 0)
      out = c
    }
  } catch {
    out = mask
  }
  OPENINGS.set(mask, out)
  return out
}

let SCRATCH: HTMLCanvasElement | null = null

/** Reusable scratch canvas, resized only when the iris image grows. */
function irisScratch(w: number, h: number): HTMLCanvasElement {
  if (!SCRATCH) SCRATCH = document.createElement('canvas')
  if (SCRATCH.width < w || SCRATCH.height < h) {
    SCRATCH.width = Math.max(SCRATCH.width, w)
    SCRATCH.height = Math.max(SCRATCH.height, h)
  }
  return SCRATCH
}

/**
 * Debug overlay in CSS-px space: a crosshair at every part's effective
 * rotation pivot (pivot + dx/dy, the point the part rotates around), a thin
 * link to its parent's pivot, and the ground/hood guides the anchor contract
 * guarantees.
 */
function drawPivotOverlay(
  ctx: CanvasRenderingContext2D,
  manifest: RigManifest,
  parts: SolvedPart[],
  dpr: number,
  sizeCss: number,
): void {
  const { scale, offsetX, offsetY } = anchorTransform(manifest, sizeCss)
  const toCss = (p: RigPoint): [number, number] => [offsetX + p[0] * scale, offsetY + p[1] * scale]

  // Ground line (y = 246/256) and hood-width ticks (92/256 centered).
  const groundY = (246 / 256) * sizeCss
  const hoodHalf = ((92 / 256) * sizeCss) / 2
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.strokeStyle = 'rgba(30,160,255,0.75)'
  ctx.fillStyle = 'rgba(30,160,255,0.9)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(0, groundY)
  ctx.lineTo(sizeCss, groundY)
  ctx.stroke()
  ctx.setLineDash([])
  for (const x of [sizeCss / 2 - hoodHalf, sizeCss / 2 + hoodHalf]) {
    ctx.beginPath()
    ctx.moveTo(x, groundY - 6)
    ctx.lineTo(x, groundY + 6)
    ctx.stroke()
  }
  ctx.font = '9px ui-monospace, SFMono-Regular, monospace'
  ctx.fillText('ground 246 · hood 92', 4, groundY - 4)

  // Pivot crosshairs + parent links. Parts are an array; groups a record.
  const parentOf = new Map<string, string>()
  for (const [gid, g] of Object.entries(manifest.groups)) {
    if (g.parent) parentOf.set(gid, g.parent)
  }
  for (const p of manifest.parts) if (p.parent) parentOf.set(p.id, p.parent)
  const groupPivots = new Map<string, RigPoint>(
    Object.entries(manifest.groups).map(([id, g]) => [id, g.pivot]),
  )
  const pivots = new Map<string, RigPoint>()
  for (const sp of parts) pivots.set(sp.id, [sp.pivot[0] + sp.dx, sp.pivot[1] + sp.dy])

  ctx.strokeStyle = 'rgba(255,70,70,0.85)'
  ctx.fillStyle = 'rgba(255,70,70,0.95)'
  for (const [id, pt] of pivots) {
    const [x, y] = toCss(pt)
    const parent = parentOf.get(id)
    if (parent) {
      const ppt = pivots.get(parent) ?? groupPivots.get(parent)
      if (ppt) {
        const [px, py] = toCss(ppt)
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(px, py)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255,70,70,0.85)'
      }
    }
    ctx.beginPath()
    ctx.moveTo(x - 5, y)
    ctx.lineTo(x + 5, y)
    ctx.moveTo(x, y - 5)
    ctx.lineTo(x, y + 5)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillText(id, x + 7, y - 5)
  }
}
