// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  isSafePackRelPath,
  parseClip,
  parseExpressions,
  parseRigManifest,
  validateRigGraph,
} from './schema.js';

const rigSample = {
  version: 1,
  master: { width: 690, height: 1024, scale: 0.5 },
  anchor: { hoodWidth: 184, groundY: 1013, centerX: 345 },
  parts: [
    { id: 'tail', image: 'parts/tail.png', x: 402, y: 640, z: 0, parent: 'body', pivot: [420, 700] },
    { id: 'torso', image: 'parts/torso.png', x: 250, y: 430, z: 30, parent: 'body', pivot: [345, 700] },
    {
      id: 'arm-R',
      z: 40,
      parent: 'torso',
      pivot: [470, 470],
      slots: { down: { image: 'parts/arm-R.down.png', x: 450, y: 455 }, wave: { image: 'parts/arm-R.wave.png', x: 440, y: 210 } },
    },
  ],
  groups: { body: { pivot: [345, 1013] }, head: { parent: 'body', pivot: [345, 560] } },
  fx: { zzz: { image: 'parts/fx-zzz.png', anchor: [480, 240] } },
  clips: ['clips/idle.json'],
  expressions: 'expressions.json',
};

describe('rig manifest schema', () => {
  it('parses a valid manifest', () => {
    const rig = parseRigManifest(rigSample);
    expect(rig.parts).toHaveLength(3);
    expect(rig.groups.head?.parent).toBe('body');
  });

  it('rejects wrong version and missing anchor fields', () => {
    expect(() => parseRigManifest({ ...rigSample, version: 2 })).toThrow();
    expect(() =>
      parseRigManifest({ ...rigSample, anchor: { hoodWidth: 1, groundY: 2 } }),
    ).toThrow();
  });

  it('validates parent existence and cycles', () => {
    expect(validateRigGraph(parseRigManifest(rigSample))).toEqual([]);
    const bad = parseRigManifest({
      ...rigSample,
      parts: [{ id: 'a', z: 1, pivot: [0, 0], parent: 'ghost' }],
    });
    expect(validateRigGraph(bad).join('\n')).toContain('missing parent');

    const cycled = parseRigManifest({
      ...rigSample,
      groups: {
        ...rigSample.groups,
        body: { pivot: [345, 1013], parent: 'head' }, // body -> head -> body
      },
    });
    expect(validateRigGraph(cycled).join('\n')).toContain('cycle');
  });
});

describe('clip schema', () => {
  it('parses a clip with numeric, enum and eased tracks', () => {
    const clip = parseClip({
      name: 'wave',
      duration: 1600,
      loop: false,
      tracks: {
        'arm.R.slot': [
          [0, 'wave'],
          [1450, 'down'],
        ],
        'arm.R.rot': [[0, 0, 'easeOutBack'], [180, -18, 'easeInOutSine'], [380, 18]],
        'body.lean': [[0, 0], [200, 3, 'easeOutSine'], [1300, 3], [1600, 0, 'easeInOutSine']],
      },
      events: [[0, 'say:wave']],
      next: null,
    });
    expect(clip.layer).toBe('action'); // defaulted
    expect(clip.tracks['arm.R.rot']).toHaveLength(3);
  });

  it('rejects unknown easing, zero duration and bad keyframes', () => {
    expect(() =>
      parseClip({ name: 'x', duration: 100, loop: false, tracks: { 'body.x': [[0, 0, 'easeOutBounce']] } }),
    ).toThrow();
    expect(() => parseClip({ name: 'x', duration: 0, loop: false, tracks: {} })).toThrow();
    expect(() =>
      parseClip({ name: 'x', duration: 100, loop: false, tracks: { 'body.x': [[-5, 0]] } }),
    ).toThrow();
  });
});

describe('expressions schema', () => {
  it('parses preset lists', () => {
    const f = parseExpressions({
      expressions: [
        { name: 'happy', params: { 'eye.shape': 'smile', 'mouth.shape': 'smile', blush: 0 } },
        { name: 'pout', params: { 'mouth.shape': 'pout', blush: 0.3 } },
      ],
    });
    expect(f.expressions[0]?.params['eye.shape']).toBe('smile');
  });
});

describe('pack path safety', () => {
  it('accepts plain relative paths and rejects traversal/absolute/scheme', () => {
    expect(isSafePackRelPath('parts/tail.png')).toBe(true);
    expect(isSafePackRelPath('rig/clips/idle.json')).toBe(true);
    expect(isSafePackRelPath('../secret.txt')).toBe(false);
    expect(isSafePackRelPath('parts/../../etc/passwd')).toBe(false);
    expect(isSafePackRelPath('/etc/passwd')).toBe(false);
    expect(isSafePackRelPath('http://evil/x.png')).toBe(false);
    expect(isSafePackRelPath('C:\\evil')).toBe(false);
  });
});
