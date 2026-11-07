#!/usr/bin/env AGPL-3.0-only
# SPDX-License-Identifier: AGPL-3.0-only
"""Round-3 seam-line probe: locate the layers behind the 1-2 px straight
lines seen on face/hood during head motion (look-around / nod / sleep /
happy).

Method
1. Composite parts-ext at rest and at the runtime head-turn parallax
   (solver.ts FAC: hood -0.35, ear -0.45, face 0.4, eye/mouth/bangs 1.0,
   third-eye 0.6; kx = 368*0.06, ky = 300*0.04 master px per unit).
2. Hough-line detection (length >= 25 px, near-horizontal / near-vertical)
   on the composite interior, ignoring lines that sit on the master's own
   ink (dilated Canny) — those are original artwork.
3. Attribution: repeat the detection with ONE part displaced at a time
   (full k in both directions) — a part whose solo shift reproduces the
   lines owns them.

Writes qa/seam-full-<pose>.png overlays and prints a per-part table.
"""
from pathlib import Path

import os
import cv2
import numpy as np
from PIL import Image

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
PARTS = ART / 'parts-ext'
QA = ART / 'qa'

ZORDER = [
    'tail', 'leg-L', 'leg-R', 'shorts', 'torso', 'string-L', 'string-R',
    'arm-L', 'arm-R', 'hood', 'horn-L', 'horn-R', 'ear-L', 'ear-R',
    'third-eye', 'face', 'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth',
    'blush', 'bangs',
]
# runtime solver.ts factors
KX = 368 * 0.06   # 22.08 master px per head.turnX unit
KY = 300 * 0.04   # 12.0 master px per head.turnY unit
FAC = {
    'hood': -0.35, 'ear-L': -0.45, 'ear-R': -0.45, 'face': 0.4,
    'eye-L': 1.0, 'eye-R': 1.0, 'iris-L': 1.0, 'iris-R': 1.0,
    'mouth': 1.0, 'bangs': 1.0, 'blush': 0.4, 'third-eye': 0.6,
}
LINE_LEN = 25
ANG_TOL = 6  # degrees around horizontal/vertical


def load_parts():
    return {
        n: np.array(Image.open(PARTS / f'{n}.png').convert('RGBA'))
        for n in ZORDER if (PARTS / f'{n}.png').exists()
    }


def composite(parts, offsets=None):
    canvas = np.zeros_like(parts['torso'])
    for name in ZORDER:
        if name not in parts:
            continue
        img = parts[name]
        if offsets and name in offsets:
            dx, dy = offsets[name]
            M = np.float32([[1, 0, dx], [0, 1, dy]])
            img = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]),
                                 flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        a = img[..., 3:4].astype(float) / 255.0
        canvas[..., :3] = img[..., :3] * a + canvas[..., :3] * (1 - a)
        a_prev = canvas[..., 3:4].astype(float) / 255.0
        canvas[..., 3:4] = ((a + a_prev * (1 - a)) * 255.0).astype(np.uint8)
    return canvas.astype(np.uint8)


def line_mask(img, interior, exempt_ink):
    """Hough lines (>=LINE_LEN, near-H/V, inside interior, not on exempt
    ink). exempt_ink covers the master's own strokes AND the same strokes
    shifted by every part offset of the pose — a part's own content sliding
    with its parallax offset is legitimate motion, not a seam."""
    gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=40,
                            minLineLength=LINE_LEN, maxLineGap=2)
    hits = np.zeros(img.shape[:2], bool)
    found = []
    if lines is None:
        return hits, found
    flat = np.asarray(lines).reshape(-1, 4)
    for l in flat:
        x1, y1, x2, y2 = map(float, l)
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
        near_h = min(ang, 180 - ang) <= ANG_TOL
        near_v = abs(ang - 90) <= ANG_TOL
        if not (near_h or near_v):
            continue
        n = int(max(abs(x2 - x1), abs(y2 - y1))) + 1
        xs = np.linspace(x1, x2, n).astype(int)
        ys = np.linspace(y1, y2, n).astype(int)
        ok = (xs >= 0) & (xs < img.shape[1]) & (ys >= 0) & (ys < img.shape[0])
        xs, ys = xs[ok], ys[ok]
        inside = interior[ys, xs].mean() if len(xs) else 0
        on_ink = exempt_ink[ys, xs].mean() if len(xs) else 1
        # a seam is an interior line that is NOT the master's own stroke
        # (nor a stroke carried to its pose position by a part offset)
        if inside > 0.9 and on_ink < 0.5:
            hits[ys, xs] = True
            found.append((int(x1), int(y1), int(x2), int(y2), float(on_ink)))
    return hits, found


def overlay(img, hits, path):
    vis = img.copy()
    vis[hits] = (255, 0, 90, 255)
    Image.fromarray(vis).save(path)


def main():
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    parts = load_parts()

    alpha_full = master[..., 3] > 128
    interior = cv2.erode(alpha_full.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    mgray = cv2.cvtColor(master, cv2.COLOR_RGBA2GRAY)
    rest = composite(parts)
    # Rest-state edges at the SAME detection sensitivity: an edge in a pose
    # that is a moved copy of a rest edge is a part carrying its own content
    # (legitimate parallax). Only NEW edges are seams. The master's soft
    # folds are part of the rest composite, so they are covered too.
    rest_edges = cv2.dilate(
        cv2.Canny(cv2.cvtColor(rest, cv2.COLOR_RGBA2GRAY), 40, 120),
        np.ones((11, 11), np.uint8)) > 0

    def exempt_for(offsets):
        ex = rest_edges.copy()
        h, w = ex.shape
        for dx, dy in set((offsets or {}).values()):
            if dx == 0 and dy == 0:
                continue
            M = np.float32([[1, 0, -dx], [0, 1, -dy]])
            ex |= cv2.warpAffine(ex.astype(np.uint8), M, (w, h),
                                 flags=cv2.INTER_NEAREST, borderValue=0) > 0
        return ex

    def run(tag, offsets):
        comp = composite(parts, offsets)
        ex = exempt_for(offsets)
        hits, found = line_mask(comp, interior, ex)
        overlay(comp, hits, QA / f'seam-{tag}.png')
        print(f'{tag}: {len(found)} seam lines')
        return comp, hits, found

    # --- full runtime poses ---------------------------------------------------
    for sign, name in ((1, 'turnX+1'), (-1, 'turnX-1')):
        off = {n: (KX * f * sign, 0.0) for n, f in FAC.items() if n in parts}
        run(name, off)
    for sign, name in ((1, 'turnY+1'), (-1, 'turnY-1')):
        off = {n: (0.0, KY * f * sign) for n, f in FAC.items() if n in parts}
        run(name, off)

    # --- single-part attribution: full k each direction ------------------------
    print('\n-- per-part solo shift attribution (dx=±KX, dy=±KY) --')
    for name in ZORDER:
        if name not in parts or name not in FAC:
            continue
        total = 0
        where = []
        for dx, dy in ((KX, 0), (-KX, 0), (0, KY), (0, -KY)):
            comp = composite(parts, {name: (dx, dy)})
            hits, found = line_mask(comp, interior, exempt_for({name: (dx, dy)}))
            total += len(found)
            if found:
                where.append((int(dx), int(dy), len(found)))
        if total:
            print(f'  {name}: {total} lines  {where}')

    # --- rest-state check (lines without any motion are export bugs) ----------
    run('rest', None)


if __name__ == '__main__':
    main()
