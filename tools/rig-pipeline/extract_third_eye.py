#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Third-eye half/open slot patches (round-3 rework of P1-1).

Two defects in the round-2 patches: the iris came out BLUE and the patch
carried a rectangular hood-white background that showed as a box edge over
the hood.

The blue was a CHANNEL-SWAP bug, not the variant's palette: round 2 loaded
the variant with PIL (RGB) but wrote the patch with cv2.imwrite (which
interprets the array as BGR), flipping R and B on disk — the amber iris
shipped blue. This script now loads and saves with PIL consistently, so
the variant's own amber survives. The HSV cold-hue recolor below stays as
a guard: if a future variant render does come out cold, its blue/cyan
pixels are rotated into the master's amber family (hue 34 deg measured
from the closed eye) with a smooth selection that leaves the dark
vertical pupil and the shell untouched.

Mask: the patch keeps only the drawing that differs from the master (the
open/half eye) plus a flat-skin margin ring, feathered 2 px — the
hood-white rectangle background is gone and the hood layer (socket +
shell) shows through everywhere else.

The closed slot stays the master's own third-eye part.
"""
import os
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
SRC = ART / 'registered'
OUT = ART / 'patches'
OUT.mkdir(parents=True, exist_ok=True)
THIRD_BOX = (380, 120, 500, 195)
MARGIN, FEATHER = 6, 2
RING_PX = 2

# amber reference (master closed-eye iris) and shell reference
AMBER_HSV = None  # measured from the master in main()
SHELL_RGB = np.array([249, 243, 240], float)


PATCH_PAD = 12
# search window for the third eye (master coords, generous for variant
# offsets; horns sit outside x 365-515)
EYE_WIN = (365, 95, 515, 245)


def eye_almond(img):
    """Convex hull of the third-eye almond: the largest amber blob in the
    window plus the dark lid strokes touching it. Returns (mask, bbox) in
    full-image coordinates, or (None, None)."""
    x0, y0, x1, y1 = EYE_WIN
    win = img[y0:y1, x0:x1]
    lab = cv2.cvtColor(win[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    solid = win[..., 3] > 128
    amber = (lab[..., 1] > 135) & (lab[..., 2] > 150) & solid
    n, lbl, st, _ = cv2.connectedComponentsWithStats(amber.astype(np.uint8), connectivity=8)
    if n < 2:
        return None, None
    iris = lbl == (1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA])))
    dark = (lab[..., 0] < 95) & solid
    near = cv2.dilate(iris.astype(np.uint8), np.ones((17, 17), np.uint8)) > 0
    n, lbl = cv2.connectedComponents(dark.astype(np.uint8), connectivity=8)
    keep = iris.copy()
    for i in set(np.unique(lbl[near & dark])) - {0}:
        comp = lbl == i
        ys, xs = np.nonzero(comp)
        # the hood-top outline spans the whole window: never part of the eye
        if xs.max() - xs.min() > 0.9 * (x1 - x0) or ys.min() == 0:
            continue
        keep |= comp
    pts = cv2.findNonZero(keep.astype(np.uint8))
    hull = np.zeros(keep.shape, np.uint8)
    cv2.fillConvexPoly(hull, cv2.convexHull(pts), 1)
    full = np.zeros(img.shape[:2], bool)
    full[y0:y1, x0:x1] = hull > 0
    ys, xs = np.nonzero(full)
    return full, (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def load_rgba(p):
    return np.array(Image.open(p).convert('RGBA'))


def head_register(master_gray, var, master_alpha):
    h, w = master_gray.shape
    vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    if vg.shape != master_gray.shape:
        var = cv2.resize(var, (w, h), interpolation=cv2.INTER_LANCZOS4)
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

    def sil(img):
        a = (img[..., 3] if img.ndim == 3 else img)[60:600, 160:700]
        ys, xs = np.where(a > 8)
        if xs.size == 0:
            return None
        return float(xs.min()) + 160, float(ys.min()) + 60, float(xs.max()) + 160, float(ys.max()) + 60

    mb = sil(master_alpha)
    vb = sil(var)
    if mb and vb:
        s = (mb[2] - mb[0]) / max(vb[2] - vb[0], 1.0)
        mcx, mcy = (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2
        vcx, vcy = (vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2
        pre = np.float32([[s, 0, mcx - s * vcx], [0, s, mcy - s * vcy]])
        var = cv2.warpAffine(var, pre, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0))
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    mask = np.zeros_like(master_gray)
    mask[60:600, 160:700] = 255
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    warp = np.eye(2, 3, dtype=np.float32)
    for scale in (0.25, 0.5, 1.0):
        dsize = (int(w * scale), int(h * scale))
        m0 = cv2.resize(master_gray, dsize)
        v0 = cv2.resize(vg, dsize)
        mk = cv2.resize(mask, dsize, interpolation=cv2.INTER_NEAREST)
        try:
            _, ws = cv2.findTransformECC(m0, v0, warp, cv2.MOTION_AFFINE, criteria, mk, 5)
        except cv2.error:
            return None, var
        ws = ws.copy()
        ws[:, 2] /= scale
        warp = ws
    aligned = cv2.warpAffine(var, warp, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0))
    return warp, aligned


def recolor_to_amber(patch, amber_h):
    """Rotate cold-hue pixels into the master's amber family (HSV space,
    smooth selection — no hard recolor boundary inside the patch). Blue
    (~210 deg, S~1.0, V~0.94) lands on the closed eye's amber
    (~34 deg, S~0.71, V~0.88); navy strokes land on the master's warm dark
    brown; low-saturation pixels (pupil, shell) are untouched."""
    hsv = cv2.cvtColor(patch[..., :3], cv2.COLOR_RGB2HSV).astype(float)
    H, S, V = hsv[..., 0] * 2, hsv[..., 1] / 255.0, hsv[..., 2] / 255.0  # hue -> degrees
    # cold selection: hue inside [170, 270] deg with soft 25 deg falloff,
    # needs some saturation so shell/pupil pixels are untouched
    d = np.abs(H - 220.0)
    d = np.minimum(d, 360 - d)
    w_hue = np.clip((70.0 - d) / 25.0, 0, 1)
    w_sat = np.clip((S - 0.10) / 0.15, 0, 1)
    w = w_hue * w_sat
    if w.max() <= 0:
        return patch
    h2 = (amber_h + (H - 210.0) * 0.15) % 360.0  # blue family -> amber, keep variation
    s2 = np.clip(S * 0.72, 0, 0.85)
    v2 = np.clip(V * 0.94, 0, 1)
    hsv2 = np.stack([h2 / 2.0, s2 * 255.0, v2 * 255.0], axis=-1)
    rgb2 = cv2.cvtColor(hsv2.astype(np.uint8), cv2.COLOR_HSV2RGB).astype(float)
    w3 = w[..., None]
    out = patch[..., :3].astype(float) * (1 - w3) + rgb2 * w3
    return np.dstack([np.clip(out, 0, 255).astype(np.uint8), patch[..., 3]])


def content_mask_3eye(patch):
    """Eye-only mask: the light region walled off by the eyelid strokes
    (flood: walls = strokes, passable = opaque light pixels) + those
    strokes + a small margin, feathered 2 px."""
    h, w = patch.shape[:2]
    lab = cv2.cvtColor(patch[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    alpha = patch[..., 3]
    solid = alpha > 128
    stroke = lab[..., 0] < 90
    passable = (solid & ~stroke) | (alpha <= 8)
    ff = passable.astype(np.uint8)
    reach = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(w):
        for y in (0, h - 1):
            if ff[y, x] == 1 and reach[y + 1, x + 1] == 0:
                cv2.floodFill(ff, reach, (x, y), 2)
    for y in range(h):
        for x in (0, w - 1):
            if ff[y, x] == 1 and reach[y + 1, x + 1] == 0:
                cv2.floodFill(ff, reach, (x, y), 2)
    outside = ff == 2
    enclosed = solid & ~stroke & ~outside
    if enclosed.sum() < 0.08 * solid.sum() or enclosed.sum() > 0.85 * solid.sum():
        return None
    near = cv2.dilate(enclosed.astype(np.uint8),
                      np.ones((2 * RING_PX + 1, 2 * RING_PX + 1), np.uint8)) > 0
    keep = enclosed | (stroke.astype(bool) & near)
    soft = cv2.GaussianBlur(keep.astype(float), (2 * FEATHER + 1, 2 * FEATHER + 1), 0)
    return np.clip(soft * alpha, 0, 255).astype(np.uint8)


def main():
    master = load_rgba(ART / 'master.png')
    mg = cv2.cvtColor(master, cv2.COLOR_BGRA2GRAY)
    # amber reference from the master's closed third-eye (part bbox 381-493 x 146-203)
    ref = master[146:204, 381:494]
    rl = cv2.cvtColor(ref[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    iris_sel = (rl[..., 1] > 110) & (rl[..., 2] > 140) & (ref[..., 3] > 200)
    iris_rgb = np.median(ref[..., :3][iris_sel], axis=0)
    iris_hsv = cv2.cvtColor(iris_rgb.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2HSV)[0, 0].astype(float)
    amber = float(iris_hsv[0]) * 2
    print(f'amber reference hue = {amber:.0f} deg from RGB {iris_rgb.astype(int).tolist()}')

    # Round-5: eye-anchored extraction. The ECC head registration left the
    # variant's eye ~20 px low and the content mask then kept the variant's
    # own hood-top outline as a long dark "lid" line plus torn shell
    # fragments around it (the tear next to the third eye in think). Now
    # each eye almond (amber iris + the lid strokes touching it) is located
    # directly in master and variant, the variant is translated so the
    # almonds share x-centre and lower-lid line, and the patch alpha is the
    # almond's convex hull only, so no hood outline can ride along.
    m_hull, m_box = eye_almond(master)
    if m_hull is None:
        raise SystemExit('third-eye: master almond not found')
    mx0, my0, mx1, my1 = m_box
    pad = PATCH_PAD
    a, c = max(0, mx0 - pad), max(0, my0 - pad)
    b, d = min(master.shape[1], mx1 + pad + 1), min(master.shape[0], my1 + pad + 1)

    report_path = OUT / 'patches-report.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    for shape, fname in (('open', 'v-third-eye-open-1.png'), ('half', 'v-third-eye-half-1.png')):
        var = load_rgba(SRC / fname)
        if var.shape[:2] != master.shape[:2]:
            var = cv2.resize(var, (master.shape[1], master.shape[0]), interpolation=cv2.INTER_LANCZOS4)
        hull, box = eye_almond(var)
        if hull is None:
            raise SystemExit(f'third-eye-{shape}: variant almond not found')
        dx = (mx0 + mx1) / 2 - (box[0] + box[2]) / 2
        dy = my1 - box[3]
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        hw = (master.shape[1], master.shape[0])
        moved = cv2.warpAffine(var, M, hw, flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        hull_m = cv2.warpAffine(hull.astype(np.uint8) * 255, M, hw, flags=cv2.INTER_NEAREST) > 0
        grown = cv2.dilate(hull_m.astype(np.uint8), np.ones((5, 5), np.uint8))
        alpha = cv2.GaussianBlur(grown.astype(np.float32) * 255, (2 * FEATHER + 1, 2 * FEATHER + 1), 0)
        alpha = np.maximum(alpha, hull_m * 255.0)
        patch = moved[c:d, a:b].copy()
        patch = recolor_to_amber(patch, amber)
        patch[..., 3] = np.minimum(alpha[c:d, a:b], moved[c:d, a:b, 3]).astype(np.uint8)
        # R7-4.1, same rule as the closed-eye part: the alpha stops at the
        # eye outline's outer edge with at most a 2 px AA transition — any
        # halo / dashed speck further out loses its alpha.
        from scipy import ndimage as _ndi
        te_contour = _ndi.binary_fill_holes(patch[..., 3] > 128)
        te_dist = cv2.distanceTransform((~te_contour).astype(np.uint8), cv2.DIST_L2, 3)
        patch[..., 3][(~te_contour) & (te_dist > 2)] = 0
        print(f'third-eye-{shape}: shift ({dx:+.0f},{dy:+.0f}) px, almond {box}')
        out = OUT / f'third-eye-{shape}.png'
        # PIL save: load_rgba above is RGB-ordered; cv2.imwrite would swap
        # R and B on disk (the round-2 blue-iris bug)
        Image.fromarray(patch).save(out)
        report[f'third-eye-{shape}'] = {'image': str(out.relative_to(ROOT)), 'offset': [int(a), int(c)]}
    report_path.write_text(json.dumps(report, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
