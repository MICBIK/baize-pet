#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Extract A6 expression patches from head-registered expression images.

For each demo/rig-art/expressions/eye-*.png / mouth-*.png: register the head
region onto the master (same ECC machinery as A3), then cut the eye boxes and
mouth box (10 px margin, 3 px feather) with their surrounding skin, and save
patch PNGs + offsets so rig.json can register them as slots.
"""
import os
import json
from pathlib import Path

import cv2
import numpy as np

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
SRC = ART / 'expressions'
OUT = ART / 'patches'
QA = ART / 'qa'
OUT.mkdir(parents=True, exist_ok=True)

# Boxes from parts.prompts.json (master px), widened for the patch margins.
EYE_BOXES = {
    'L': (320, 350, 420, 425),
    'R': (440, 350, 540, 425),
}
MOUTH_BOX = (400, 440, 458, 470)
MARGIN = 12
FEATHER = 3
# Faces whose proportions drift too far from the master for an affine head
# registration (mouth-puff renders the mouth ~20px above the box): the patch
# would paste the wrong region, so the slot stays absent and the solver's
# fallback answers it (F4).
SKIP = {'mouth-puff'}


def load_rgba(p):
    im = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    if im is None or im.ndim != 3 or im.shape[2] != 4:
        return None
    return im


def head_register(master_gray, var, master_alpha=None):
    """Coarse-to-fine ECC on the head band; identity on failure."""
    h, w = master_gray.shape
    vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    if vg.shape != master_gray.shape:
        var = cv2.resize(var, (w, h), interpolation=cv2.INTER_LANCZOS4)
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

    # Pre-align by silhouette bbox (upstream renders the subject a few percent
    # larger or smaller per frame; ECC alone diverges from that starting gap).
    if master_alpha is not None:
        def sil(img):
            # Head band only: a swung-out tail must not widen the box.
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
            var = cv2.warpAffine(
                var, pre, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0)
            )
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


def master_stroke_bbox(master, box, margin):
    """Master's own eye/mouth stroke bbox inside a slot box (master-px
    bbox of the crop), widened by 14 px — the geometry zone the patch's
    drawing may live in. Hair strands, hood rim and lining fringes sit
    outside it (or are identical to the master and unneeded)."""
    x0, y0, x1, y1 = box
    H, W = master.shape[:2]
    a = max(0, x0 - margin)
    b = min(W, x1 + margin)
    c = max(0, y0 - margin)
    d = min(H, y1 + margin)
    crop = master[c:d, a:b]
    lab = cv2.cvtColor(crop[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    strokes = (lab[..., 0] < 95) & (crop[..., 3] > 128)
    ys, xs = np.where(strokes)
    if len(ys) < 30:
        return None
    return (c, a, int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def content_mask(patch, master_crop, zone, feather, ring_px=6):
    """Round-3 content-boundary patch mask: keep only what the expression
    actually DREW DIFFERENTLY from the master (the new eye/mouth), plus a
    flat-skin blend ring. Everything the patch carries unchanged from the
    master (fringe strands, rim strokes, lining fringes, plain skin) is
    drawn by the layers beneath, so keeping it would only ghost across the
    face when the patch slides with the eye/mouth part.

    zone = master stroke bbox + pad, constraining where new drawing may
    live; blobs of change below 40 px are registration residue, dropped."""
    h, w = patch.shape[:2]
    rgb = patch[..., :3].astype(int)
    lab = cv2.cvtColor(patch[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    alpha = patch[..., 3]
    solid = alpha > 8
    diff = np.abs(rgb - master_crop[..., :3].astype(int)).mean(axis=2)
    changed = (diff > 20) & solid
    n, lbl = cv2.connectedComponents(changed.astype(np.uint8), connectivity=8)
    kept_changed = np.zeros((h, w), bool)
    dark = lab[..., 0] < 95
    for i in range(1, n):
        blob = lbl == i
        if blob.sum() < 80:
            continue  # registration residue, not a drawn feature
        if not (dark & blob).any():
            continue  # an eye/mouth drawing change always carries new strokes
        kept_changed |= blob
    sc, a0, x0s, y0s, x1s, y1s = zone
    zone_mask = np.zeros((h, w), bool)
    # stroke bbox coords are already crop-space == patch space; a tight 4 px
    # pad keeps the margin band (where rim strokes live) out of the mask
    zx0, zy0 = max(0, x0s - 4), max(0, y0s - 4)
    zx1, zy1 = min(w, x1s + 4 + 1), min(h, y1s + 4 + 1)
    zone_mask[zy0:zy1, zx0:zx1] = True
    changed_zone = kept_changed & zone_mask
    if changed_zone.sum() < 40:
        return None
    grown = cv2.dilate(changed_zone.astype(np.uint8),
                       np.ones((2 * ring_px + 1, 2 * ring_px + 1), np.uint8)) > 0
    skinish = ((np.abs(rgb[..., 0] - 248) < 22) & (np.abs(rgb[..., 1] - 225) < 24)
               & (np.abs(rgb[..., 2] - 205) < 30))
    keep = changed_zone | (skinish & solid & grown)
    soft = cv2.GaussianBlur(keep.astype(float), (2 * feather + 1, 2 * feather + 1), 0)
    return np.clip(soft * alpha, 0, 255).astype(np.uint8)


def cut_patch(img, box, margin, feather, lining=None, master=None, zone=None):
    x0, y0, x1, y1 = box
    H, W = img.shape[:2]
    a = max(0, x0 - margin)
    b = min(W, x1 + margin)
    c = max(0, y0 - margin)
    d = min(H, y1 + margin)
    patch = img[c:d, a:b].copy()
    if lining is not None:
        # rework P0-3: never carry hood-lining amber — the patch mask is
        # subtracted by the lining zone in this region, feathered after
        patch[..., 3][lining[c:d, a:b]] = 0
    if zone is not None and master is not None:
        master_crop = master[c:d, a:b]
        m = content_mask(patch, master_crop, zone, feather)
        if m is not None:
            patch[..., 3] = m
        else:
            print('    change area degenerate, feathered rectangle kept')
    else:
        alpha = patch[..., 3].astype(float)
        k = 2 * feather + 1
        soft = cv2.GaussianBlur(alpha, (k, k), 0)
        patch[..., 3] = np.clip(alpha * 0.4 + soft * 0.6, 0, 255).astype(np.uint8)
    return patch, int(a), int(c)


def main():
    master = load_rgba(ART / 'master.png')
    if master is None:
        raise SystemExit('master missing')
    mg = cv2.cvtColor(master, cv2.COLOR_BGR2GRAY) if master.shape[2] == 4 else None
    mg = cv2.cvtColor(master, cv2.COLOR_BGRA2GRAY)

    # hood-lining zone (rework P0-3): amber pixels of the re-segmented hood
    hood = load_rgba(ART / 'parts-ext/hood.png')
    lab = cv2.cvtColor(hood[..., :3], cv2.COLOR_RGB2LAB)
    lining = (
        (lab[..., 1].astype(int) > 135)
        & (lab[..., 2].astype(int) > 170)
        & (hood[..., 3] > 8)
    )

    # master stroke geometry per slot (round-3 content-boundary masks).
    # Eyes: the master's stroke bbox. Mouth: the box interior — the master's
    # smile line is too light for a reliable stroke bbox, and its chin
    # shading would pull the zone down onto the hood rim; the box interior
    # excludes the rim by construction.
    zones = {}
    for side, box in EYE_BOXES.items():
        zones[f'eye-{side}'] = master_stroke_bbox(master, box, MARGIN)
    bx0, by0, bx1, by1 = MOUTH_BOX
    zones['mouth'] = (by0 - MARGIN, bx0 - MARGIN,
                      MARGIN, MARGIN, MARGIN + (bx1 - bx0), MARGIN + (by1 - by0))

    report = {}
    for p in sorted(SRC.glob('*.png')):
        var = load_rgba(p)
        if var is None:
            continue
        _, aligned = head_register(mg, var, master[..., 3])
        name = p.stem
        if name in SKIP:
            continue
        entry = {}
        if name.startswith('eye-'):
            for side, box in EYE_BOXES.items():
                zone = zones[f'eye-{side}']
                patch, ox, oy = cut_patch(aligned, box, MARGIN, FEATHER, lining,
                                          master=master, zone=zone)
                out = OUT / f'{name}-{side}.png'
                cv2.imwrite(str(out), patch)
                entry[side] = {'image': str(out.relative_to(ROOT)), 'offset': [ox, oy]}
        elif name.startswith('mouth-'):
            patch, ox, oy = cut_patch(aligned, MOUTH_BOX, MARGIN, FEATHER, lining,
                                      master=master, zone=zones['mouth'])
            out = OUT / f'{name}.png'
            cv2.imwrite(str(out), patch)
            entry = {'image': str(out.relative_to(ROOT)), 'offset': [ox, oy]}
        else:
            continue
        report[name] = entry
        print(f'{name}: patch ok')

    (OUT / 'patches-report.json').write_text(
        json.dumps(report, indent=1) + '\n', encoding='utf-8'
    )
    print(f'{len(report)} patches -> {OUT}')


if __name__ == '__main__':
    main()