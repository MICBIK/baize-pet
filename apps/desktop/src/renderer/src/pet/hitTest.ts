// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-pixel alpha hit test shared by all pet renderers. Returns true when
 * the point has alpha > 32 (task book A1/C); on any pixel-readback failure
 * the caller falls back to the drawn bounding box.
 */

export const HIT_ALPHA_THRESHOLD = 32

export interface HitRect {
  left: number
  top: number
  workW: number
  workH: number
}

/**
 * Read the alpha value at a client point against a drawn source. draw() must
 * paint the source at its natural pixel size onto the scratch canvas.
 */
export function alphaAt(
  scratch: HTMLCanvasElement,
  draw: (ctx: CanvasRenderingContext2D) => void,
  rect: HitRect,
  clientX: number,
  clientY: number,
): number {
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 2d context unavailable')
  const scale = scratch.width / Math.max(1, rect.workW)
  const x = Math.floor((clientX - rect.left) * scale)
  const y = Math.floor((clientY - rect.top) * scale)
  ctx.clearRect(0, 0, scratch.width, scratch.height)
  draw(ctx)
  const d = ctx.getImageData(x, y, 1, 1).data
  return d[3] ?? 0
}

/** Build the shared scratch canvas used by hit testing. */
export function makeScratchCanvas(w: 256 | number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = w
  return c
}
