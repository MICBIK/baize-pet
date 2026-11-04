#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""P1-3 mouth slots small/mid/o derived from the wide patch.

The rework task book's fallback: scale the wide mouth patch vertically
(0.35 → small, 0.65 → mid) about the mouth-corner line, and squeeze it
horizontally + stretch slightly for the round o. Offsets shift so the
corner line stays at the master's mouth y. Quality is judged visually in
the viewer; these are slot fallbacks for lip-sync, not hero art.
"""
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
ART = ROOT / 'demo/rig-art'
MOUTH_Y = 455  # mouth-corner line in master px (MOUTH_BOX centre y ≈ 455)

SHAPES = {
    'small': {'sy': 0.35, 'sx': 0.92},
    'mid': {'sy': 0.65, 'sx': 0.97},
    'o': {'sy': 1.12, 'sx': 0.66},
}


def main():
    src = cv2.imread(str(ART / 'patches/mouth-wide.png'), cv2.IMREAD_UNCHANGED)
    if src is None or src.shape[2] != 4:
        raise SystemExit('mouth-wide patch missing')
    report = json.loads((ART / 'patches/patches-report.json').read_text(encoding='utf-8'))
    base_ox, base_oy = report['mouth-wide']['offset']
    h, w = src.shape[:2]
    for shape, cfg in SHAPES.items():
        sw, sh = max(1, round(w * cfg['sx'])), max(1, round(h * cfg['sy']))
        resized = cv2.resize(src, (sw, sh), interpolation=cv2.INTER_LANCZOS4)
        # anchor the patch so the mouth-corner line stays at MOUTH_Y
        corner_in_patch = MOUTH_Y - base_oy
        new_corner = sh * (corner_in_patch / h)
        ox = base_ox + round((w - sw) / 2)
        oy = base_oy + round(corner_in_patch - new_corner)
        out = ART / 'patches' / f'mouth-{shape}.png'
        cv2.imwrite(str(out), resized)
        report[f'mouth-{shape}'] = {'image': str(out.relative_to(ROOT)), 'offset': [int(ox), int(oy)]}
        print(f'mouth-{shape}: {sw}x{sh} offset ({ox},{oy})')
    (ART / 'patches/patches-report.json').write_text(json.dumps(report, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
