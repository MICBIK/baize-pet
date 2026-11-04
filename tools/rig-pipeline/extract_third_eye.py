#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Third-eye half/open slot patches (rework P1-1).

The v-third-eye-open/half variants (A2) were registered last round; the
registered images are head-registered against the master (same machinery
as extract_patches) and the third-eye box is cut as a slot patch (+6 px
margin, 3 px feather). The patch carries the hood-shell white around the
eye by design: it pastes over the same spot of the hood. The closed slot
stays the master's own third-eye part.
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
ART = ROOT / 'demo/rig-art'
SRC = ART / 'registered'
OUT = ART / 'patches'
OUT.mkdir(parents=True, exist_ok=True)
THIRD_BOX = (380, 120, 500, 195)
MARGIN, FEATHER = 6, 3


def load_rgba(p):
    return np.array(Image.open(p).convert('RGBA'))


def head_register(master_gray, var, master_alpha):
    h, w = master_gray.shape
    vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    if vg.shape != master_gray.shape:
        var = cv2.resize(var, (w, h), interpolation=cv2.INTER_LANCZOS4)
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

    def sil(img):
        a = (img[..., 3] if img.ndim == 3 else img)[60:600, 160:700]
        ys, xs = np.where(a > 8)
        if xs.size == 0:
            return None
        return float(xs.min()) + 160, float(ys.min()) + 60, float(xs.max()) + 160, float(ys.max()) + 60

    mb = sil(master_alpha)
    vb = sil(var)
    if mb and vb:
        s = (mb[2] - mb[0]) / max(vb[2] - vb[0], 1.0)
        mcx, mcy = (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2
        vcx, vcy = (vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2
        pre = np.float32([[s, 0, mcx - s * vcx], [0, s, mcy - s * vcy]])
        var = cv2.warpAffine(var, pre, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0))
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    mask = np.zeros_like(master_gray)
    mask[60:600, 160:700] = 255
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    warp = np.eye(2, 3, dtype=np.float32)
    for scale in (0.25, 0.5, 1.0):
        dsize = (int(w * scale), int(h * scale))
        m0 = cv2.resize(master_gray, dsize)
        v0 = cv2.resize(vg, dsize)
        mk = cv2.resize(mask, dsize, interpolation=cv2.INTER_NEAREST)
        try:
            _, ws = cv2.findTransformECC(m0, v0, warp, cv2.MOTION_AFFINE, criteria, mk, 5)
        except cv2.error:
            return None, var
        ws = ws.copy()
        ws[:, 2] /= scale
        warp = ws
    aligned = cv2.warpAffine(var, warp, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0))
    return warp, aligned


def main():
    master = load_rgba(ART / 'master.png')
    mg = cv2.cvtColor(master, cv2.COLOR_BGRA2GRAY)
    report_path = OUT / 'patches-report.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    for shape, fname in (('open', 'v-third-eye-open-1.png'), ('half', 'v-third-eye-half-1.png')):
        var = load_rgba(SRC / fname)
        _, aligned = head_register(mg, var, master[..., 3])
        x0, y0, x1, y1 = THIRD_BOX
        a, b = max(0, x0 - MARGIN), x1 + MARGIN
        c, d = max(0, y0 - MARGIN), y1 + MARGIN
        patch = aligned[c:d, a:b].copy()
        alpha = patch[..., 3].astype(float)
        k = 2 * FEATHER + 1
        soft = cv2.GaussianBlur(alpha, (k, k), 0)
        patch[..., 3] = np.clip(alpha * 0.4 + soft * 0.6, 0, 255).astype(np.uint8)
        out = OUT / f'third-eye-{shape}.png'
        cv2.imwrite(str(out), patch)
        report[f'third-eye-{shape}'] = {'image': str(out.relative_to(ROOT)), 'offset': [int(a), int(c)]}
        print(f'third-eye-{shape}: patch ok')
    report_path.write_text(json.dumps(report, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
