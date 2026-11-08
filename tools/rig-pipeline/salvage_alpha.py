#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Salvage alpha-less generations (task book F8 companion).

The upstream intermittently drops background=transparent and composites the
character on a flat black canvas. Those responses are billed and otherwise
correct, so instead of discarding *.reject files we key out the flat black:
flood fill from border seeds through near-black pixels only (never entering
enclosed dark regions like line-art outlines), then feather the edge. Output
goes next to the target as <name>-salv.png for manual review.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

T = 14  # near-black tolerance per channel (background measures 0-1)


def salvage(src: Path, dst: Path) -> None:
    img = np.array(Image.open(src).convert('RGB'))
    h, w = img.shape[:2]
    flood_mask = np.zeros((h + 2, w + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)
    lo = (T, T, T)
    for x in range(0, w, 6):
        for seed in ((x, 0), (x, h - 1), (0, x % w), (w - 1, x % w)):
            cv2.floodFill(img.copy(), flood_mask, seed, 0, lo, lo, flags)
    bg = flood_mask[1:-1, 1:-1] > 0

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    # Keep the interior fully opaque; only the edge band is feathered.
    hard = np.where(bg, 0, 255).astype(np.uint8)
    alpha = np.where(hard == 255, np.maximum(alpha, hard), alpha)
    # Pixels just outside the silhouette that stayed dark get cut outright.
    alpha[bg] = 0

    out = Image.fromarray(np.dstack([img, alpha]), 'RGBA')
    out.save(dst, optimize=True)


def main() -> None:
    art = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe/demo/rig-art')
    targets = []
    for d in (art / 'variants', art / 'expressions'):
        for reject in sorted(d.glob('*.png.reject')):
            dest = reject.parent / reject.name.replace('.png.reject', '-salv.png')
            targets.append((reject, dest))

    only = sys.argv[1:] if len(sys.argv) > 1 else None
    done = 0
    for reject, dest in targets:
        if only and not any(o in reject.name for o in only):
            continue
        salvage(reject, dest)
        print(f'salvaged {dest.name} ({dest.stat().st_size // 1024}KB)')
        done += 1
    print(f'{done} salvaged')


if __name__ == '__main__':
    main()
