#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Extract arm slot images from registered variants (task book A6/D2).

For each arm family one candidate is chosen (reviewed overlays); the raised
arm ink is isolated by colour difference against the master (the variant's
unchanged pixels are aligned and cancel out, so the sleeve-over-face pixels
of chin/cover/rub stay arm-only and no drifted face is baked into the slot),
cleaned morphologically and cropped at master resolution, exported at 0.5x
like every other part. Output: demo/rig-art/slots/*.png + slots.json with
{partId: {slotName: {image, x, y}}} consumed by export_pack.py.
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
MARGIN = 6
DIFF_T = 18

# family -> (variant file, parts to fill). Only families whose registration
# AND colour-delta isolation survived the sheet review are registered here.
# cover/rub/up/hold/head/out failed isolation (mask swallowed body-wide
# generation drift or the registration itself misaligned) and take the F4
# fallback: the action approximates the pose by rotating the down slot.
PICKS = {
    'wave': ('v-arm-wave-R-2.png', ['arm-R']),
    'chin': ('v-arm-chin-R-1.png', ['arm-R']),
}


def main() -> None:
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    slots: dict[str, dict[str, dict]] = {}
    for family, (variant, parts) in PICKS.items():
        aligned = np.array(Image.open(ART / 'registered' / variant).convert('RGBA'))
        if aligned.shape[:2] != master.shape[:2]:
            aligned = cv2.resize(aligned, (master.shape[1], master.shape[0]), interpolation=cv2.INTER_LANCZOS4)

        m_rgb = master[:, :, :3].astype(int)
        v_rgb = aligned[:, :, :3].astype(int)
        v_alpha = aligned[:, :, 3] > 24
        m_alpha = master[:, :, 3] > 24
        diff = np.abs(v_rgb - m_rgb).mean(axis=2)
        changed = (diff > DIFF_T) & v_alpha
        # Clean speckle, then keep the big structures.
        changed = cv2.morphologyEx(changed.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
        changed &= ~m_alpha  # the arm is where the master had no ink (plus overlaps below)

        # The sleeve may overlap master ink (torso/face); those pixels differ
        # strongly too. Re-include changed pixels that DO sit on master ink,
        # minus a small halo, so the sleeve keeps its cover over the face.
        overlap = (diff > DIFF_T) & v_alpha & m_alpha
        overlap = cv2.morphologyEx(overlap.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)) > 0
        arm_ink = changed | overlap

        n, labels = cv2.connectedComponents(arm_ink.astype(np.uint8), connectivity=8)
        if n <= 1:
            print(f'{family}: no arm ink found, skipped')
            continue
        sizes = sorted(((int((labels == i).sum()), i) for i in range(1, n)), reverse=True)
        cx = master.shape[1] / 2
        for part_id in parts:
            right = part_id.endswith('R')
            comp = None
            for size, i in sizes:
                ys, xs = np.where(labels == i)
                # The main (largest) component may span both arms; use it when
                # it covers the wanted side, else take the biggest on that side.
                if (right and xs.mean() > cx) or (not right and xs.mean() <= cx):
                    comp = i
                    break
            if comp is None:
                print(f'{family}: no component on the {"R" if right else "L"} side, skipped')
                continue
            mask = labels == comp
            mask = cv2.dilate(mask.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
            mask &= v_alpha
            ys, xs = np.where(mask)
            x0 = max(0, int(xs.min()) - MARGIN)
            y0 = max(0, int(ys.min()) - MARGIN)
            x1 = min(master.shape[1], int(xs.max()) + 1 + MARGIN)
            y1 = min(master.shape[0], int(ys.max()) + 1 + MARGIN)

            crop = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
            sub = mask[y0:y1, x0:x1]
            crop[sub] = aligned[y0:y1, x0:x1][sub]
            h, w = crop.shape[:2]
            small = cv2.resize(crop, (max(1, round(w * SCALE)), max(1, round(h * SCALE))), interpolation=cv2.INTER_LANCZOS4)
            fname = f'arm-{"R" if right else "L"}-{family}.png'
            Image.fromarray(small, 'RGBA').save(OUT / fname, optimize=True)
            slots.setdefault(part_id, {})[family] = {
                'image': f'parts/{fname}',
                'x': x0,
                'y': y0,
            }
            print(f'{family} -> {part_id}: {fname} box=({x0},{y0})-({x1},{y1}) mask={int(mask.sum())}px')

    (ART / 'slots.json').write_text(json.dumps(slots, indent=1) + '\n', encoding='utf-8')
    print(f'slots.json -> {ART / "slots.json"}')


if __name__ == '__main__':
    main()
