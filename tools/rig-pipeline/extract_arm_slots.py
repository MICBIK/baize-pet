#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Extract arm slot images from registered variants (task book A6/D2).

Fixed crop boxes per family (measured on the reviewed 50/50 overlays),
cropped UNMASKED from the registered variant with a feathered edge: the
variant's unchanged pixels are aligned onto their master positions, so
overlaying them is invisible; only the raised arm reads as new ink. The
face part's aligned ink is subtracted so a drifted iris never prints over
the live face at the raised-arm z (68). Families whose registration or
isolation failed (cover/rub/up/hold/head/out) take the F4 fallback: the
action approximates the pose by rotating the down slot.
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
OUT = ART / 'slots'
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 0.5
FEATHER = 10

# family -> (variant file, part, crop box in master px). Boxes measured on
# the QA overlays: hand beside the head, sleeve down to the shoulder pivot.
# chin was dropped after sheet review: the chin-R-1 hood edge drifts enough
# that its gold lining printed as fragments around the hood at z68 — F4
# fallback (think approximates the pose by rotating the down slot).
PICKS = {
    # wave was dropped in round 2 (rework P0-2): both v-arm-wave-R variants
    # rendered the character dark, so no clean sleeve crop exists — wave now
    # swings the down arm about the shoulder pivot (make-clips.cjs).
}


# Capped-shoulder slots built from the down sleeve (round 5).
CAPPED = [('arm-R', 'wave')]
# Armpit rows (split_parts.ARMPIT_Y): below them the sleeve already has its
# own outline on both sides; above them the cap replaces the open cut.
ARMPIT_Y = {'arm-L': 580, 'arm-R': 585}
CAP_INK_W = 4.0  # outline width in master px (matches the sleeve's own line)


def cap_shoulder(img: np.ndarray, armpit_y: int) -> np.ndarray:
    """Replace the sleeve above the armpit row with a half-ellipse cap of
    flat sleeve cloth and a closed anti-aliased outline. The ellipse spans
    the sleeve's width at the armpit row, so the new outline meets the
    sleeve's outer line and inner seam ink where the original art resumes."""
    out = img.copy()
    m = img[:, :, 3] > 128
    ys, _ = np.where(m)
    top = int(ys.min())
    row = np.where(m[armpit_y])[0]
    xl, xr = int(row.min()), int(row.max())
    cx, a = (xl + xr) / 2.0, (xr - xl) / 2.0 + 0.5
    b = float(armpit_y - top) + 2.0
    h, w = m.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # signed distance (approx, px) inside the upper half-ellipse
    r = np.sqrt(((xx - cx) / a) ** 2 + ((yy - armpit_y) / b) ** 2)
    inside_e = (1.0 - r) * min(a, b)
    cap_zone = yy < armpit_y
    lum = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2GRAY)
    cloth_px = m & (lum > 200) & (yy >= armpit_y) & (yy < armpit_y + 60)
    cloth = np.median(img[:, :, :3][cloth_px], axis=0) if cloth_px.any() else np.array([248, 246, 245])
    ink_px = m & (lum < 80)
    ink = np.median(img[:, :, :3][ink_px], axis=0) if ink_px.any() else np.array([52, 36, 32])
    zone = cap_zone & (inside_e > -1.0)
    cov = np.clip(inside_e + 0.5, 0, 1)            # silhouette coverage (AA)
    ink_w = np.clip(CAP_INK_W + 0.5 - inside_e, 0, 1)  # 1 on the outline ring
    rgb = cloth[None, None, :] * (1 - ink_w[..., None]) + ink[None, None, :] * ink_w[..., None]
    out[:, :, :3][cap_zone] = 0
    out[:, :, 3][cap_zone] = 0
    out[:, :, :3][zone] = rgb[zone].astype(np.uint8)
    out[:, :, 3][zone] = (cov[zone] * 255).astype(np.uint8)
    return out


def main() -> None:
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    face = np.array(Image.open(ART / 'parts-ext/face.png').convert('RGBA'))
    face_ink = cv2.erode(
        (face[:, :, 3] > 24).astype(np.uint8), np.ones((9, 9), np.uint8)
    ) > 0

    slots: dict[str, dict[str, dict]] = {}
    for family, (variant, part_id, (x0, y0, x1, y1)) in PICKS.items():
        aligned = np.array(Image.open(ART / 'registered' / variant).convert('RGBA'))
        if aligned.shape[:2] != master.shape[:2]:
            aligned = cv2.resize(aligned, (master.shape[1], master.shape[0]), interpolation=cv2.INTER_LANCZOS4)

        crop = aligned[y0:y1, x0:x1].copy()
        h, w = crop.shape[:2]
        ramp_x = np.minimum(np.arange(w) / FEATHER, np.arange(w)[::-1] / FEATHER).clip(0, 1)
        ramp_y = np.minimum(np.arange(h) / FEATHER, np.arange(h)[::-1] / FEATHER).clip(0, 1)
        feather = (np.minimum(ramp_x[None, :], ramp_y[:, None]) * 255).astype(np.uint8)
        crop[:, :, 3] = np.minimum(crop[:, :, 3], feather)

        # Subtract the face ink unconditionally: no registered family puts
        # sleeve ink over the face (chin/cover were dropped, F4), and the
        # variant's blush/shading drift would otherwise print over the live
        # face at the raised-arm z.
        face_here = face_ink[y0:y1, x0:x1]
        crop[:, :, 3][face_here] = 0

        small = cv2.resize(
            crop, (max(1, round(w * SCALE)), max(1, round(h * SCALE))), interpolation=cv2.INTER_LANCZOS4
        )
        fname = f'{part_id}-{family}.png'
        Image.fromarray(small, 'RGBA').save(OUT / fname, optimize=True)
        slots.setdefault(part_id, {})[family] = {'image': f'parts/{fname}', 'x': x0, 'y': y0}
        print(f'{family} -> {part_id}: {fname} box=({x0},{y0})-({x1},{y1})')

    # Round 5: the wave swings the down sleeve to -145 deg about the shoulder.
    # The down sleeve's top end is an open cut (raglan shoulder hidden in the
    # torso / under the hood at rest), and that cut swung out as a straight,
    # outline-less white edge at the wave peak. The wave slot is the same
    # sleeve with a closed, outlined, rounded shoulder cap. It renders at the
    # raised-arm z (68) only while the wave clip holds it, so the rest pose
    # (down slot) is untouched.
    for part_id, family in CAPPED:
        src = ART / 'parts-ext' / f'{part_id}.png'
        if not src.exists():
            continue
        capped = cap_shoulder(np.array(Image.open(src).convert('RGBA')), ARMPIT_Y[part_id])
        ys, xs = np.where(capped[:, :, 3] > 8)
        x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
        crop = Image.fromarray(capped[y0:y1, x0:x1], 'RGBA')
        small = crop.resize((max(1, round(crop.width * SCALE)), max(1, round(crop.height * SCALE))),
                            Image.LANCZOS)
        fname = f'{part_id}-{family}.png'
        small.save(OUT / fname, optimize=True)
        slots.setdefault(part_id, {})[family] = {'image': f'parts/{fname}', 'x': x0, 'y': y0}
        print(f'{family} -> {part_id}: {fname} (capped shoulder) box=({x0},{y0})-({x1},{y1})')

    (ART / 'slots.json').write_text(json.dumps(slots, indent=1) + '\n', encoding='utf-8')
    print(f'slots.json -> {ART / "slots.json"}')


if __name__ == '__main__':
    main()
