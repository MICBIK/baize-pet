#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Remove stray fragments from part masks (found via rig-viewer QA).

segment_parts.py assigns leftover master ink to the nearest part, and
extend_parts.py grows part masks into neighboring ink, so both parts-full
and parts-ext can carry slivers of the neighboring leg (leg-L/R) or
shoulder-skin patches (face). Invisible at rest, they swing visibly when
the part rotates (walk/tilt-head). Parts listed here must be one connected
region: keep the largest 8-connected component, drop the rest. Multi-region
parts (blush = two cheeks, iris = pupil + glint) stay untouched.

Run AFTER segment_parts.py and again AFTER extend_parts.py (the extension
can regrow fragments); then qa.py and export_pack.py regenerate downstream.
"""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
ART = ROOT / 'demo/rig-art'

# Parts that must be one piece; fragments found by the QA sheet review.
SINGLE_PIECE = {'leg-L', 'leg-R', 'face'}


def clean(path: Path) -> int:
    img = np.array(Image.open(path).convert('RGBA'))
    alpha = (img[:, :, 3] > 24).astype(np.uint8)
    n, labels = cv2.connectedComponents(alpha, connectivity=8)
    if n <= 2:
        return 0
    sizes = [(int((labels == i).sum()), i) for i in range(1, n)]
    sizes.sort(reverse=True)
    removed = 0
    for size, i in sizes[1:]:
        img[labels == i] = 0
        removed += size
    Image.fromarray(img, 'RGBA').save(path, optimize=True)
    return removed


def main() -> None:
    total = 0
    for stage in ('parts-full', 'parts-ext'):
        for pid in sorted(SINGLE_PIECE):
            path = ART / stage / f'{pid}.png'
            if not path.exists():
                continue
            removed = clean(path)
            print(f'{stage}/{pid}: removed {removed}px of fragments')
            total += removed
    print(f'done, {total}px removed')


if __name__ == '__main__':
    main()
