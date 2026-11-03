// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas and graph validation for rig.json, clips/<name>.json and
 * expressions.json (task book B2/B3/B4). Pure data validation — no DOM,
 * no file IO; the app layer owns reading files from the character pack.
 */

import { z } from 'zod';

export const EASINGS = [
  'linear',
  'easeInSine',
  'easeOutSine',
  'easeInOutSine',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeOutBack',
  'easeOutElastic',
  'step',
] as const;
export type Easing = (typeof EASINGS)[number];

export const RigPointSchema = z.tuple([z.number(), z.number()]);
export type RigPoint = [number, number];

const SlotImageSchema = z.object({ image: z.string().min(1), x: z.number(), y: z.number() });

export const RigPartSchema = z.object({
  id: z.string().min(1),
  image: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().int(),
  parent: z.string().optional(),
  pivot: RigPointSchema,
  slots: z.record(z.string(), SlotImageSchema).optional(),
  /** Param controlling this part's alpha, e.g. "blush" or "thirdEye.glow". */
  opacityParam: z.string().optional(),
  /** Blend mode; "lighter" for additive glows. */
  blend: z.enum(['normal', 'lighter']).optional(),
});
export type RigPart = z.infer<typeof RigPartSchema>;

export const RigGroupSchema = z.object({
  parent: z.string().optional(),
  pivot: RigPointSchema,
});
export type RigGroup = z.infer<typeof RigGroupSchema>;

export const RigFxSchema = z.object({ image: z.string().min(1), anchor: RigPointSchema });

export const RigManifestSchema = z.object({
  version: z.literal(1),
  master: z.object({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }),
  anchor: z.object({ hoodWidth: z.number().positive(), groundY: z.number().positive(), centerX: z.number() }),
  parts: z.array(RigPartSchema),
  groups: z.record(z.string(), RigGroupSchema),
  fx: z.record(z.string(), RigFxSchema).optional(),
  clips: z.array(z.string().min(1)).optional(),
  expressions: z.string().optional(),
});
export type RigManifest = z.infer<typeof RigManifestSchema>;

/** One keyframe: [timeMs, value, easing?]. Enum values switch by step. */
export const KeyframeSchema = z.tuple([
  z.number().nonnegative(),
  z.union([z.number(), z.string()]),
  z.enum(EASINGS).optional(),
]);
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const ClipLayerSchema = z.enum(['base', 'action']);
export type ClipLayer = z.infer<typeof ClipLayerSchema>;

export const ClipSchema = z.object({
  name: z.string().min(1),
  duration: z.number().positive(),
  loop: z.boolean(),
  layer: ClipLayerSchema.default('action'),
  /** Expression preset forced while this clip plays. */
  expression: z.string().optional(),
  tracks: z.record(z.string(), z.array(KeyframeSchema)),
  /** [timeMs, "say:<key>" | future event kinds]. */
  events: z.array(z.tuple([z.number(), z.string()])).optional(),
  next: z.string().nullable().optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

export const ExpressionPresetSchema = z.object({
  name: z.string().min(1),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type ExpressionPreset = z.infer<typeof ExpressionPresetSchema>;

export const ExpressionsFileSchema = z.object({
  expressions: z.array(ExpressionPresetSchema),
});
export type ExpressionsFile = z.infer<typeof ExpressionsFileSchema>;

/** Parse a rig.json payload; throws a descriptive error when invalid. */
export function parseRigManifest(data: unknown): RigManifest {
  return RigManifestSchema.parse(data);
}

export function parseClip(data: unknown): Clip {
  return ClipSchema.parse(data);
}

export function parseExpressions(data: unknown): ExpressionsFile {
  return ExpressionsFileSchema.parse(data);
}

/**
 * Check that part/group parent references form a forest rooted at "body"
 * and contain no cycles. Returns a list of human-readable problems.
 */
export function validateRigGraph(rig: RigManifest): string[] {
  const problems: string[] = [];
  const nodeIds = new Set<string>(['body', ...rig.groups ? Object.keys(rig.groups) : [], ...rig.parts.map((p) => p.id)]);

  const parentOf = new Map<string, string>();
  for (const [id, g] of Object.entries(rig.groups)) {
    if (g.parent) parentOf.set(id, g.parent);
  }
  for (const p of rig.parts) {
    if (p.parent) parentOf.set(p.id, p.parent);
  }

  for (const [id, parent] of parentOf) {
    if (!nodeIds.has(parent)) {
      problems.push(`"${id}" references missing parent "${parent}"`);
    }
  }

  for (const id of nodeIds) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id);
    while (cur !== undefined) {
      if (seen.has(cur)) {
        problems.push(`cycle detected at "${id}"`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return problems;
}

/**
 * Pack-relative image paths must stay inside the pack: no "..", no absolute
 * or scheme paths. The app layer additionally checks existence on disk.
 */
export function isSafePackRelPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false;
  if (p.split('/').includes('..')) return false;
  return true;
}
