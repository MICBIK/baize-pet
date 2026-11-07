#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""A5 joint extension (task book A4 last column / A5 joint-growth rule).

Grows each part mask outward by its task-book margin so joint rotations
never expose holes. Extension pixels are painted with the master's own
RGBA at those coordinates: invisible at rest (the composite still
reproduces the master exactly) and plausible while a joint is rotated.
Extensions only grow into master-opaque pixels, never into transparency.
"""
from pathlib import Path

import os
import cv2
import numpy as np
from PIL import Image

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
SRC = ART / 'parts-full'
DST = ART / 'parts-ext'
DST.mkdir(parents=True, exist_ok=True)

# Part -> extension radius in master px (task book A4 table last column).
EXTEND = {
    'tail': 30,
    'leg-L': 50,
    'leg-R': 50,
    'torso': 35,
    'shorts': 12,
    'string-L': 6,
    'string-R': 6,
    'arm-L': 40,
    'arm-R': 40,
    'hood': 20,
    'horn-L': 10,
    'horn-R': 10,
    'ear-L': 15,
    'ear-R': 15,
    'third-eye': 8,
    'face': 15,
    'bangs': 10,
    'eye-L': 8,
    'eye-R': 8,
    'mouth': 8,
}


def main():
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    opaque = master[..., 3] > 128
    for f in sorted(SRC.glob('*.png')):
        img = np.array(Image.open(f).convert('RGBA'))
        mask = img[..., 3] > 8
        radius = EXTEND.get(f.stem)
        if radius:
            kernel = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
            )
            grown = cv2.dilate(mask.astype(np.uint8), kernel) > 0
            ext = grown & opaque & ~mask
            # Paint the extension with the master's own pixels.
            img[..., 3][ext] = master[..., 3][ext]
            for c in range(3):
                img[..., c][ext] = master[..., c][ext]
            print(f'{f.stem}: +{int(ext.sum())} ext px (K={radius})')
        Image.fromarray(img).save(DST / f.name)
    print(f'extended parts -> {DST}')


if __name__ == '__main__':
    main()
