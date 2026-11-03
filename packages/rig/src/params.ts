// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rig parameter table (task book B1). Every animation — clips, blending,
 * procedural life, expressions — reads and writes this flat parameter map.
 * Numeric params are clamped to their range; enum params snap to a legal
 * value. Angles are degrees; distances are pet-window pixels (256 scale).
 */

export type ParamValue = number | string;

/** Flat parameter map keyed by dotted name, e.g. "body.squash". */
export type RigParams = Record<string, ParamValue>;

export const EYE_SLOTS = [
  'open',
  'half',
  'closed',
  'smile',
  'squeeze',
  'wide',
  'star',
  'heart',
  'swirl',
  'teary',
  'sleepy',
  'focus',
  'look-up',
  'wink',
] as const;
export type EyeSlot = (typeof EYE_SLOTS)[number];

export const MOUTH_SLOTS = [
  'smile',
  'small',
  'mid',
  'wide',
  'o',
  'cat',
  'pout',
  'flat',
  'wobbly',
  'grin',
  'puff',
] as const;
export type MouthSlot = (typeof MOUTH_SLOTS)[number];

export const ARM_SLOTS = ['down', 'wave', 'up', 'chin', 'hold', 'cover', 'rub', 'head', 'out'] as const;
export type ArmSlot = (typeof ARM_SLOTS)[number];

export const PROPS = ['none', 'book', 'bun', 'tablet'] as const;
export type Prop = (typeof PROPS)[number];

export type ParamDef =
  | { key: string; kind: 'number'; min: number; max: number; def: number }
  | { key: string; kind: 'enum'; values: readonly string[]; def: string };

/** The full known parameter table. Unknown "fx.<name>" keys follow the fx rule. */
export const PARAM_DEFS: readonly ParamDef[] = [
  { key: 'body.x', kind: 'number', min: -40, max: 40, def: 0 },
  { key: 'body.y', kind: 'number', min: -40, max: 40, def: 0 },
  { key: 'body.squash', kind: 'number', min: -1, max: 1, def: 0 },
  { key: 'body.lean', kind: 'number', min: -12, max: 12, def: 0 },
  { key: 'body.breath', kind: 'number', min: 0, max: 1, def: 0 },
  { key: 'head.tilt', kind: 'number', min: -18, max: 18, def: 0 },
  { key: 'head.turnX', kind: 'number', min: -1, max: 1, def: 0 },
  { key: 'head.turnY', kind: 'number', min: -1, max: 1, def: 0 },
  { key: 'head.y', kind: 'number', min: -10, max: 10, def: 0 },
  { key: 'eye.L.open', kind: 'number', min: 0, max: 1, def: 1 },
  { key: 'eye.R.open', kind: 'number', min: 0, max: 1, def: 1 },
  { key: 'eye.shape', kind: 'enum', values: EYE_SLOTS, def: 'auto' },
  { key: 'eye.lookX', kind: 'number', min: -1, max: 1, def: 0 },
  { key: 'eye.lookY', kind: 'number', min: -1, max: 1, def: 0 },
  { key: 'mouth.shape', kind: 'enum', values: MOUTH_SLOTS, def: 'smile' },
  { key: 'mouth.open', kind: 'number', min: 0, max: 1, def: 0 },
  { key: 'blush', kind: 'number', min: 0, max: 1, def: 0 },
  { key: 'thirdEye', kind: 'number', min: 0, max: 1, def: 0 },
  { key: 'thirdEye.glow', kind: 'number', min: 0, max: 1, def: 0 },
  { key: 'ear.L.rot', kind: 'number', min: -30, max: 15, def: 0 },
  { key: 'ear.R.rot', kind: 'number', min: -30, max: 15, def: 0 },
  { key: 'tail.rot', kind: 'number', min: -30, max: 30, def: 0 },
  { key: 'arm.L.slot', kind: 'enum', values: ARM_SLOTS, def: 'down' },
  { key: 'arm.R.slot', kind: 'enum', values: ARM_SLOTS, def: 'down' },
  { key: 'arm.L.rot', kind: 'number', min: -40, max: 40, def: 0 },
  { key: 'arm.R.rot', kind: 'number', min: -40, max: 40, def: 0 },
  { key: 'leg.L.rot', kind: 'number', min: -22, max: 22, def: 0 },
  { key: 'leg.R.rot', kind: 'number', min: -22, max: 22, def: 0 },
  { key: 'leg.L.lift', kind: 'number', min: 0, max: 12, def: 0 },
  { key: 'leg.R.lift', kind: 'number', min: 0, max: 12, def: 0 },
  { key: 'string.L.rot', kind: 'number', min: -25, max: 25, def: 0 },
  { key: 'string.R.rot', kind: 'number', min: -25, max: 25, def: 0 },
  { key: 'prop', kind: 'enum', values: PROPS, def: 'none' },
];

const DEFS_BY_KEY: ReadonlyMap<string, ParamDef> = new Map(PARAM_DEFS.map((d) => [d.key, d]));

/** Effect-strength params ("fx.<name>") all live in 0..1 and default to 0. */
export const isFxParam = (key: string): boolean => key.startsWith('fx.');

/** A fresh parameter map with every default value. */
export function createDefaultParams(): RigParams {
  const p: RigParams = {};
  for (const d of PARAM_DEFS) p[d.key] = d.def;
  return p;
}

/**
 * Clamp a map into legal ranges: numeric params are clamped, enum params
 * snap back to their default when the value is not a legal option, "fx.*"
 * numbers clamp to 0..1, unknown keys are dropped.
 */
export function clampParams(input: RigParams): RigParams {
  const out: RigParams = {};
  for (const [key, value] of Object.entries(input)) {
    const def = DEFS_BY_KEY.get(key);
    if (def) {
      if (def.kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        out[key] = Math.min(def.max, Math.max(def.min, value));
      } else if (typeof value === 'string' && (def.values as readonly string[]).includes(value)) {
        out[key] = value;
      }
      continue;
    }
    if (isFxParam(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[key] = Math.min(1, Math.max(0, value));
      }
    }
    // Unknown keys are ignored entirely.
  }
  return out;
}

export function getNum(params: RigParams, key: string): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function getEnum(params: RigParams, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

/** Linear interpolation between two parameter maps (enums blend by weight). */
export function lerpParams(a: RigParams, b: RigParams, weightB: number): RigParams {
  const out: RigParams = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') {
      out[key] = va + (vb - va) * weightB;
    } else if (typeof va === 'string' && typeof vb === 'string') {
      out[key] = weightB > 0.5 ? vb : va;
    } else if (va !== undefined) {
      out[key] = va;
    } else if (vb !== undefined) {
      out[key] = vb;
    }
  }
  return out;
}
