// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pose solver (task book B2/C): turn mixed parameters into per-part
 * 2D affine transforms, slot choices, opacities and parallax offsets in
 * master-pixel coordinates. Pure and DOM-free; the Canvas renderer applies
 * the matrices.
 */

import { getEnum, getNum, type RigParams } from './params.js'
import type { RigManifest, RigPart, RigPoint } from './schema.js'

export interface SolvedPart {
  id: string
  /** Pack-relative image path after slot resolution. */
  image: string
  /** Rest-pose top-left of the part image in master px. */
  restX: number
  restY: number
  /** Translation applied by groups/parallax/breath/lift. */
  dx: number
  dy: number
  /** Rotation pivot in master px (part pivot, moved by body translation). */
  pivot: RigPoint
  /** Body squash scales around this point (the feet). */
  scalePivot: RigPoint
  /** Rotation around `pivot`, degrees (group lean/tilt + part rotation). */
  rotDeg: number
  scaleX: number
  scaleY: number
  /** Viewer-left parts reuse the R image mirrored horizontally. */
  mirrored: boolean
  opacity: number
  blend: 'normal' | 'lighter'
  z: number
  /** Iris horizontal/vertical shift in px (open-eye slots only). */
  irisShift?: { dx: number; dy: number }
  /** Eye-white mask image that clips the iris (open-eye slots only). */
  clipImage?: string
  clipRestX?: number
  clipRestY?: number
}

const DEG = Math.PI / 180

function rotatePoint(px: number, py: number, deg: number): RigPoint {
  const a = deg * DEG
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return [px * cos - py * sin, px * sin + py * cos]
}

/** Compose parent-chain translation, rotation and scale for one part. */
function composeTransforms(
  part: RigPart,
  manifest: RigManifest,
  params: RigParams,
): { dx: number; dy: number; rotDeg: number; scaleX: number; scaleY: number } {
  // body group: translate + lean + squash (pivot at the feet)
  const anchor = manifest.anchor
  const _feet: RigPoint = [anchor.centerX, anchor.groundY]
  const bodyX = getNum(params, 'body.x')
  const bodyY = getNum(params, 'body.y')
  const lean = getNum(params, 'body.lean')
  const squash = getNum(params, 'body.squash')
  const breath = getNum(params, 'body.breath')

  // Head-group extras.
  const tilt = getNum(params, 'head.tilt')
  const turnX = getNum(params, 'head.turnX')
  const turnY = getNum(params, 'head.turnY')

  // Per-part-class parallax factors (task book B1 head.turnX/Y).
  const cls = partClass(part.id)
  const headW = 368 // hood outer width in master px (anchor-derived at A8)
  const headH = 300 // hood height estimate; refined when rig.json lands
  const kx = headW * 0.06
  const ky = headH * 0.04

  // Parallax factor per class.
  const FAC: Record<string, number> = {
    hood: -0.35,
    ear: -0.45,
    face: 0.4,
    eye: 1.0,
    mouth: 1.0,
    bangs: 1.0,
    thirdeye: 0.6,
  }
  const fx = FAC[cls] ?? 0

  let dx = bodyX
  let dy = bodyY
  let rot = lean
  const sx = 1 - 0.09 * squash
  let sy = 1 + 0.14 * squash

  if (cls === 'torso') {
    sy *= 1 + 0.016 * breath
  }
  const breathLift = 2.2 * breath
  if (
    cls === 'head' ||
    cls === 'ear' ||
    cls === 'face' ||
    cls === 'eye' ||
    cls === 'mouth' ||
    cls === 'bangs' ||
    cls === 'thirdeye'
  ) {
    dy -= breathLift
  }

  // Head tilt: rotate head parts around the neck pivot.
  const neck = headPivot(manifest)
  if (cls !== 'body' && cls !== 'torso' && tilt !== 0) {
    const rel = rotatePoint(part.pivot[0] - neck[0], part.pivot[1] - neck[1], tilt)
    const movedX = neck[0] + rel[0]
    const movedY = neck[1] + rel[1]
    dx += movedX - part.pivot[0]
    dy += movedY - part.pivot[1]
    if (cls !== 'body') rot += tilt
  }

  // Head turn parallax (translate per class).
  dx += kx * fx * turnX
  dy += ky * fx * turnY

  return { dx, dy, rotDeg: rot, scaleX: sx, scaleY: sy }
}

/** Classify a part id for parallax and hierarchy behaviour. */
export function partClass(id: string): string {
  if (id.startsWith('arm')) return 'arm'
  if (id.startsWith('ear')) return 'ear'
  if (id.startsWith('eye')) return 'eye'
  if (id.startsWith('iris')) return 'eye'
  if (id.startsWith('mouth')) return 'mouth'
  if (id.startsWith('bangs')) return 'bangs'
  if (id.startsWith('third-eye')) return 'thirdeye'
  if (id.startsWith('face')) return 'face'
  if (id.startsWith('hood')) return 'hood'
  if (id.startsWith('torso')) return 'torso'
  if (id.startsWith('string')) return 'string'
  if (id.startsWith('leg')) return 'leg'
  if (id === 'tail' || id.startsWith('tail-')) return 'tail'
  if (id.startsWith('blush')) return 'face'
  if (id.startsWith('fx') || id.startsWith('prop')) return 'fx'
  return 'body'
}

/** Neck pivot from the head group (fallback: mid-height). */
function headPivot(manifest: RigManifest): RigPoint {
  const g = manifest.groups.head
  if (g) return g.pivot
  return [manifest.anchor.centerX, manifest.anchor.groundY * 0.55]
}

/** Eye slot chosen from open amount unless eye.shape overrides (auto). */
export function eyeSlot(params: RigParams, side: 'L' | 'R'): string {
  const shape = getEnum(params, 'eye.shape')
  if (shape && shape !== 'auto') return shape
  const open = getNum(params, `eye.${side}.open`)
  if (open >= 0.75) return 'open'
  if (open >= 0.35) return 'half'
  return 'closed'
}

/** Mouth slot from mouth.open unless the shape is explicit. */
export function mouthSlot(params: RigParams): string {
  const shape = getEnum(params, 'mouth.shape')
  const open = getNum(params, 'mouth.open')
  if (open <= 0) return shape || 'smile'
  if (open < 0.25) return 'smile'
  if (open < 0.5) return 'small'
  if (open < 0.8) return 'mid'
  return 'wide'
}

/** Third-eye slot from the 0..1 param. */
export function thirdEyeSlot(params: RigParams): 'closed' | 'half' | 'open' {
  const v = getNum(params, 'thirdEye')
  if (v < 0.33) return 'closed'
  if (v < 0.75) return 'half'
  return 'open'
}

/**
 * Solve one frame: every manifest part in z order with its slot image,
 * transform, opacity and (for open eyes) iris shift.
 */
export function solve(manifest: RigManifest, params: RigParams): SolvedPart[] {
  const out: SolvedPart[] = []
  const parts = [...manifest.parts].sort((a, b) => a.z - b.z)
  const anchor = manifest.anchor
  const feet: RigPoint = [anchor.centerX, anchor.groundY]
  const bodyX = getNum(params, 'body.x')
  const bodyY = getNum(params, 'body.y')

  for (const part of parts) {
    const cls = partClass(part.id)
    const tr = composeTransforms(part, manifest, params)

    let image = part.image
    let px = part.x ?? part.pivot[0]
    let py = part.y ?? part.pivot[1]
    const mirrored = part.id.endsWith('-L') && cls === 'arm'
    let opacity = 1
    const blend: SolvedPart['blend'] = part.blend ?? 'normal'

    // Slot resolution.
    const slots = part.slots
    if (slots) {
      let slotName: string | undefined
      if (part.id === 'arm-L') slotName = getEnum(params, 'arm.L.slot')
      else if (part.id === 'arm-R') slotName = getEnum(params, 'arm.R.slot')
      else if (part.id === 'eye-L') slotName = eyeSlot(params, 'L')
      else if (part.id === 'eye-R') slotName = eyeSlot(params, 'R')
      else if (part.id === 'mouth') slotName = mouthSlot(params)
      else if (part.id.startsWith('third-eye')) slotName = thirdEyeSlot(params)
      if (slotName) {
        const slot = slots[slotName] ?? slots.down ?? slots.open ?? slots.smile ?? slots.closed
        if (!slot) continue // part absent for this slot
        image = slot.image
        px = slot.x
        py = slot.y
      }
    }

    // Missing image on a non-slot part: skip (e.g. optional bangs).
    if (!image) continue

    // Per-part rotation overrides from params.
    let extraRot = 0
    if (part.id === 'arm-L') extraRot = getNum(params, 'arm.L.rot')
    if (part.id === 'arm-R') extraRot = getNum(params, 'arm.R.rot')
    if (part.id === 'ear-L') extraRot = getNum(params, 'ear.L.rot')
    if (part.id === 'ear-R') extraRot = getNum(params, 'ear.R.rot')
    if (part.id === 'leg-L') extraRot = getNum(params, 'leg.L.rot')
    if (part.id === 'leg-R') extraRot = getNum(params, 'leg.R.rot')
    if (part.id === 'tail') extraRot = getNum(params, 'tail.rot')
    if (part.id === 'tail-tip') extraRot = getNum(params, 'tail.rot') * 0.6
    if (part.id === 'string-L') extraRot = getNum(params, 'string.L.rot')
    if (part.id === 'string-R') extraRot = getNum(params, 'string.R.rot')
    if (part.id === 'leg-L') extraRot += 0
    const lift =
      part.id === 'leg-L'
        ? getNum(params, 'leg.L.lift')
        : part.id === 'leg-R'
          ? getNum(params, 'leg.R.lift')
          : 0
    tr.dy -= lift

    // Opacity-driven params (blush, glow, fx).
    if (part.opacityParam) {
      opacity = Math.min(1, Math.max(0, getNum(params, part.opacityParam)))
      if (opacity <= 0) continue
    }
    if (part.id.startsWith('fx-')) {
      const strength = getNum(params, `fx.${part.id.slice(3)}`)
      if (strength <= 0) continue
      opacity = strength
    }

    // Iris shift (open eyes only) at 18% of eye-white width.
    let irisShift: SolvedPart['irisShift']
    let clipImage: string | undefined
    let clipRestX: number | undefined
    let clipRestY: number | undefined
    if (part.id === 'iris-L' || part.id === 'iris-R') {
      const side = part.id === 'iris-L' ? 'L' : 'R'
      const eye = manifest.parts.find((p) => p.id === `eye-${side}`)
      const openSlot = eye?.slots?.open
      if (eyeSlot(params, side) === 'open' && openSlot) {
        const eyeW = 90 // eye-white width estimate in master px, refined at A8
        irisShift = {
          dx: getNum(params, 'eye.lookX') * eyeW * 0.18,
          dy: getNum(params, 'eye.lookY') * eyeW * 0.12,
        }
        clipImage = openSlot.image
        clipRestX = openSlot.x
        clipRestY = openSlot.y
      } else {
        continue // iris hidden when the open slot is not shown
      }
    }

    out.push({
      id: part.id,
      image,
      restX: px,
      restY: py,
      dx: tr.dx,
      dy: tr.dy,
      pivot: [part.pivot[0] + bodyX, part.pivot[1] + bodyY],
      scalePivot: feet,
      rotDeg: tr.rotDeg + extraRot,
      scaleX: tr.scaleX,
      scaleY: tr.scaleY,
      mirrored,
      opacity,
      blend,
      z: part.z,
      irisShift,
      clipImage,
      clipRestX,
      clipRestY,
    })
  }
  return out
}
