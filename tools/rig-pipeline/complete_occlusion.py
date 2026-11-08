#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Occlusion completion for the torso (task book A5 occlusion rule, F3).

The master's torso is partly hidden behind the arms and the hood. Those
pixels exist only in the arms-behind variant; after registration they can
back-fill the torso part, so switching an arm slot (wave/chin/cover/rub)
does not expose a body-shaped hole. Pixels are taken from the registered
arms-behind variant and written into parts-ext/torso.png.

parts-ext images are FULL master canvases (cropping happens at export), so
everything here works directly in master coordinates. At rest the added
pixels stay under the arm/hood ink (z-order), keeping the A9 restoration
composite unchanged. No dilation: any pixel outside the occluder cover
would show at rest and fail the restoration gate (worstBlock).

All image I/O uses PIL (RGBA channel order) end to end — mixing cv2.imread
(BGR) with PIL save (RGB) silently swaps red and blue.
"""

from pathlib import Path

import os
import cv2
import numpy as np
from PIL import Image

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
MASTER = ART / 'master.png'
BEHIND = ART / 'registered/v-arms-behind-3.png'  # best in-region IoU (0.8029)


def load_rgba(p: Path) -> np.ndarray:
    im = Image.open(p).convert('RGBA')
    return np.array(im)


def main() -> None:
    master = load_rgba(MASTER)
    behind = load_rgba(BEHIND)
    if behind.shape[:2] != master.shape[:2]:
        behind = cv2.resize(behind, (master.shape[1], master.shape[0]), interpolation=cv2.INTER_LANCZOS4)

    torso = load_rgba(ART / 'parts-ext/torso.png')
    occl = np.zeros(master.shape[:2], bool)
    for name in ('arm-L', 'arm-R', 'hood'):
        occl |= load_rgba(ART / f'parts-ext/{name}.png')[:, :, 3] > 24

    torso_a = torso[:, :, 3] > 24
    m_alpha = master[:, :, 3] > 24
    fill = (~torso_a) & occl & m_alpha

    usable = fill & (behind[:, :, 3] > 24)
    print(f'occluded ring px: {int(fill.sum())}, back-filled from variant: {int(usable.sum())}')

    out = torso.copy()
    out[usable] = behind[usable]
    Image.fromarray(out, 'RGBA').save(ART / 'parts-ext/torso.png', optimize=True)
    print('torso occlusion completion written')


if __name__ == '__main__':
    main()
