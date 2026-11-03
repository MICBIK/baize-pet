#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Normalize the chosen rig master image (task book A1).

Steps: crop to the content bounding box, add an 8%-of-height transparent
margin on all sides, resize so the character height is exactly 1024 px
(LANCZOS), and normalise near-opaque alpha (>=235) to 255. Writes a side
report JSON next to the output so downstream stages can reproduce it.
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT_DIR = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe/demo/rig-art')


def normalize(src: Path, dst: Path, report: Path) -> None:
    im = Image.open(src).convert('RGBA')
    arr = np.array(im)
    alpha = arr[..., 3]

    ys, xs = np.where(alpha > 0)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = arr[y0:y1, x0:x1]

    h, w = crop.shape[:2]
    target_h = 1024
    scale = target_h / h
    target_w = max(1, round(w * scale))
    im2 = Image.fromarray(crop).resize((target_w, target_h), Image.LANCZOS)

    a2 = np.array(im2)
    a2[..., 3] = np.where(a2[..., 3] >= 235, 255, a2[..., 3])

    # 8% of the character height as transparent margin on every side.
    m = round(target_h * 0.08)
    canvas = np.zeros((target_h + 2 * m, target_w + 2 * m, 4), dtype=np.uint8)
    canvas[m:m + target_h, m:m + target_w] = a2

    Image.fromarray(canvas).save(dst)

    # Reproduction report (pathlib write; keep away from open(..., 'w')).
    report.write_text(
        '\n'.join([
            f'source: {src.name}',
            f'src_size: {im.size[0]}x{im.size[1]}',
            f'crop_box: x0={x0} y0={y0} x1={x1} y1={y1}',
            f'crop_size: {w}x{h}',
            f'scale: {scale:.5f}',
            f'char_size: {target_w}x{target_h}',
            f'margin: {m}',
            f'out_size: {canvas.shape[1]}x{canvas.shape[0]}',
            f'alpha_norm_threshold: 235',
        ]) + '\n',
        encoding='utf-8',
    )
    print(f'normalized {src.name} -> {dst.name} char {target_w}x{target_h} margin {m}')


if __name__ == '__main__':
    # Chosen master candidate is a constant (edit here to re-normalize another).
    src = OUT_DIR / 'master-candidates' / 'm3.png'
    normalize(src, OUT_DIR / 'master.png', OUT_DIR / 'master-normalize-report.txt')
