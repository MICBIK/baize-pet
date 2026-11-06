// SPDX-License-Identifier: AGPL-3.0-only
// Dump per-part affine poses from packages/rig's own solver (the runtime
// source of truth) for a batch of parameter sets. qa_pack.py composites the
// EXPORTED pack from this JSON — Python never re-implements parallax or
// rotation formulas (round-6 gate requirement: gates must use runtime
// transforms).
//
// Usage:
//   node tools/rig-pipeline/pose_dump.mjs \
//     --rig characters/baize-b3/rig/rig.json \
//     --poses poses.json --out poses-dump.json
//
// poses.json: [{ "name": "rest", "params": { "head.tilt": 12 } }, ...]
// Output: { "master": {...}, "anchor": {...}, "poses": [ { name, parts: [
//   { id, image, restX, restY, dx, dy, pivot, scalePivot, rotDeg,
//     scaleX, scaleY, opacity, blend, z, mirrored } ] } ] }

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

const rigPath = arg('--rig') ?? path.join(ROOT, 'characters/baize-b3/rig/rig.json')
const posesPath = arg('--poses')
const outPath = arg('--out') ?? 'poses-dump.json'
if (!posesPath) {
  console.error('pose_dump.mjs: --poses <file.json> is required')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const rig = require(path.resolve(ROOT, rigPath))
const { solve, createDefaultParams, clampParams } = require(
  path.join(ROOT, 'packages/rig/dist/index.js'),
)

const poses = JSON.parse(fs.readFileSync(path.resolve(ROOT, posesPath), 'utf-8'))
const out = { master: rig.master, anchor: rig.anchor, poses: [] }
for (const pose of poses) {
  const params = clampParams({ ...createDefaultParams(), ...(pose.params ?? {}) })
  const solved = solve(rig, params)
  out.poses.push({
    name: pose.name,
    parts: solved.map((p) => ({
      id: p.id,
      image: p.image,
      restX: p.restX,
      restY: p.restY,
      dx: p.dx,
      dy: p.dy,
      pivot: p.pivot,
      scalePivot: p.scalePivot,
      rotDeg: p.rotDeg,
      scaleX: p.scaleX,
      scaleY: p.scaleY,
      opacity: p.opacity,
      blend: p.blend,
      z: p.z,
      mirrored: p.mirrored,
      clipImage: p.clipImage ?? null,
      clipRestX: p.clipRestX ?? null,
      clipRestY: p.clipRestY ?? null,
    })),
  })
}
fs.writeFileSync(outPath, JSON.stringify(out))
console.log(`pose_dump: ${out.poses.length} poses -> ${outPath}`)
