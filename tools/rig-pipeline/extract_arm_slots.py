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

import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
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

    (ART / 'slots.json').write_text(json.dumps(slots, indent=1) + '\n', encoding='utf-8')
    print(f'slots.json -> {ART / "slots.json"}')


if __name__ == '__main__':
    main()
