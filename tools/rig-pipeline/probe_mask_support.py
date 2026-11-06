#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Build a probe mask for the A0 experiment (does the relay accept `mask`?).

The mask is a RGBA PNG the same size as the master; OPAQUE pixels are kept,
fully TRANSPARENT pixels mark the region to repaint. We mark the third-eye
area of the hood forehead as transparent and ask the model to open the eye
there. If the upstream accepts the call, A0 reports "mask supported".
"""
from pathlib import Path

import os
import numpy as np
from PIL import Image

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
master = Image.open(ROOT / 'demo/rig-art/master.png').convert('RGBA')
w, h = master.size

mask = np.zeros((h, w, 4), dtype=np.uint8)
mask[..., 3] = 255  # opaque everywhere = keep everything

# Third-eye region: centred horizontally, on the hood forehead above the face.
cx = w // 2
cy = int(h * 0.155)
rx, ry = int(w * 0.075), int(h * 0.045)
yy, xx = np.ogrid[:h, :w]
mask[(xx - cx) ** 2 / rx**2 + (yy - cy) ** 2 / ry**2 <= 1, 3] = 0

out = ROOT / 'demo/rig-art/mask-third-eye.png'
Image.fromarray(mask).save(out)
print('wrote', out, f'{w}x{h} transparent px:', int((mask[..., 3] == 0).sum()))
