// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  clampParams,
  createDefaultParams,
  getEnum,
  getNum,
  isFxParam,
  lerpParams,
  PARAM_DEFS,
} from './params.js';

describe('rig params', () => {
  it('has unique keys and finite ranges', () => {
    const keys = PARAM_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of PARAM_DEFS) {
      if (d.kind === 'number') {
        expect(Number.isFinite(d.min)).toBe(true);
        expect(Number.isFinite(d.max)).toBe(true);
        expect(d.min).toBeLessThanOrEqual(d.max);
        expect(d.def).toBeGreaterThanOrEqual(d.min);
        expect(d.def).toBeLessThanOrEqual(d.max);
      }
    }
  });

  it('creates defaults for every known param', () => {
    const p = createDefaultParams();
    for (const d of PARAM_DEFS) expect(p[d.key]).toBe(d.def);
    expect(p['body.squash']).toBe(0);
    expect(p['eye.shape']).toBe('auto');
    expect(p['arm.R.slot']).toBe('down');
  });

  it('clamps numeric params into range', () => {
    const p = clampParams({ 'body.x': 999, 'body.y': -999, 'body.squash': 0.5 });
    expect(p['body.x']).toBe(40);
    expect(p['body.y']).toBe(-40);
    expect(p['body.squash']).toBe(0.5);
  });

  it('rejects illegal enum values by dropping them', () => {
    const p = clampParams({ 'eye.shape': 'nope', 'mouth.shape': 'wide', 'arm.L.slot': 'wave' });
    expect(p['eye.shape']).toBeUndefined();
    expect(p['mouth.shape']).toBe('wide');
    expect(p['arm.L.slot']).toBe('wave');
  });

  it('drops non-finite numbers and unknown keys', () => {
    const p = clampParams({ 'body.x': Number.NaN, madeUp: 1, 'fx.sparkle': 2 });
    expect(p['body.x']).toBeUndefined();
    expect(p.madeUp).toBeUndefined();
    expect(p['fx.sparkle']).toBe(1);
  });

  it('treats fx.* keys as 0..1 strength params', () => {
    expect(isFxParam('fx.zzz')).toBe(true);
    expect(isFxParam('body.x')).toBe(false);
    expect(clampParams({ 'fx.tear': -3 })['fx.tear']).toBe(0);
  });

  it('getters fall back to zero and empty string', () => {
    expect(getNum({}, 'body.x')).toBe(0);
    expect(getEnum({}, 'eye.shape')).toBe('');
    expect(getNum({ 'body.x': 3 }, 'body.x')).toBe(3);
  });

  it('lerps numeric params and steps enums at weight 0.5', () => {
    const a = createDefaultParams();
    const b = clampParams({ 'body.x': 10, 'eye.shape': 'wide', 'mouth.shape': 'o' });
    const mid = lerpParams(a, b, 0.5);
    expect(mid['body.x']).toBe(5);
    expect(mid['eye.shape']).toBe('auto'); // weight <= 0.5 keeps a
    const late = lerpParams(a, b, 0.75);
    expect(late['eye.shape']).toBe('wide');
    expect(late['body.x']).toBeCloseTo(7.5, 10);
  });
});
