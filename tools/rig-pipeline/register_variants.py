#!/usr/bin/env python3
# SPDX-License-Identifier: AGGL-3.0-only
"""Register A2 variant images onto the rig master (task book A3).

For each variant, an unaffected region (head+legs for arm variants, face+torso
for third-eye variants) drives a coarse-to-fine ECC affine registration; ORB
+ RANSAC is the fallback. Per the recorded gate semantics (tools/rig-pipeline
/README.md, open-questions #12): the global in-region IoU is RECORDED, not
gated — every clone-drifted generation lands at 0.7-0.8 even when alignment
is good — and the acceptance decision happens at slot extraction (aligned
overlay review + geometric checks in the usage region). Outputs registered/
<variant>.png for every successfully warped candidate plus a 50/50 QA overlay.
"""

from pathlib import Path

import cv2
import numpy as np

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
ART = ROOT / 'demo/rig-art'
MASTER = ART / 'master.png'
VARIANTS = ART / 'variants'
REGISTERED = ART / 'registered'
QA = ART / 'qa'
REGISTERED.mkdir(parents=True, exist_ok=True)
QA.mkdir(parents=True, exist_ok=True)

# Which region drives registration, per variant family.
ARM_VARIANTS = {
    'v-arms-behind', 'v-arm-wave-R', 'v-arm-up-both', 'v-arm-chin-R',
    'v-arm-hold', 'v-arm-cover-R', 'v-arm-rub-R', 'v-arm-head-both', 'v-arm-out-both',
}

# Head region (y 60..600 of 1188) and legs region (y 950..1120) in master px.
HEAD_BAND = (60, 600)
LEGS_BAND = (950, 1120)
# Face+torso band for third-eye variants (avoid the hood forehead).
FACE_BAND = (600, 1000)


def load_rgba(p: Path):
    im = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    if im is None or im.shape[2] != 4:
        raise SystemExit(f'not RGBA: {p}')
    return im


def alpha_of(im: np.ndarray) -> np.ndarray:
    return im[..., 3]


def iou_in_region(a_alpha: np.ndarray, b_alpha: np.ndarray) -> float:
    """IoU of two binary alpha masks (already cropped to the region)."""
    a = a_alpha > 128
    b = b_alpha > 128
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union > 0 else 0.0


def region_mask(shape, bands):
    """Union of horizontal bands as a uint8 mask (255 = use for ECC)."""
    h, w = shape[:2]
    m = np.zeros((h, w), np.uint8)
    for y0, y1 in bands:
        y0c = max(0, int(y0))
        y1c = min(h, int(y1))
        m[y0c:y1c, :] = 255
    return m


def register_ecc(master_gray, var_gray, reg_mask):
    """Coarse-to-fine ECC affine. Returns 2x3 matrix or None."""
    import cv2

    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    # Downscale pyramid: 1/4, 1/2, full.
    h, w = master_gray.shape
    for scale in (0.25, 0.5, 1.0):
        if scale == 1.0:
            m0, v0, mk = master_gray, var_gray, reg_mask
        else:
            dsize = (int(w * scale), int(h * scale))
            m0 = cv2.resize(master_gray, dsize)
            v0 = cv2.resize(var_gray, dsize)
            mk = cv2.resize(reg_mask, dsize, interpolation=cv2.INTER_NEAREST)
        try:
            cc, warp_scaled = cv2.findTransformECC(m0, v0, warp, cv2.MOTION_AFFINE, criteria, mk, 5)
        except cv2.error:
            return None
        # Warp was estimated at this scale; bring translation back to full-res.
        warp_scaled = warp_scaled.copy()
        warp_scaled[:, 2] /= scale
        warp = warp_scaled
    return warp


def register_orb(master_gray, var_gray, reg_mask):
    """Fallback: ORB features + RANSAC partial affine, masked to the region."""
    import cv2

    orb = cv2.ORB_create(nfeatures=4000)
    m = cv2.bitwise_and(master_gray, master_gray, mask=reg_mask)
    v = cv2.bitwise_and(var_gray, var_gray, mask=reg_mask)
    k1, d1 = orb.detectAndCompute(m, None)
    k2, d2 = orb.detectAndCompute(v, None)
    if d1 is None or d2 is None or len(k1) < 20 or len(k2) < 20:
        return None
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(d1, d2)
    if len(matches) < 12:
        return None
    src = np.float32([k1[mm.queryIdx].pt for mm in matches])
    dst = np.float32([k2[mm.trainIdx].pt for mm in matches])
    M, inliers = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0
    )
    return None if M is None else M


def main():
    master = load_rgba(MASTER)
    mg = cv2.cvtColor(master, cv2.COLOR_BGRA2GRAY)
    targets = sorted(p for p in VARIANTS.glob('*.png') if not p.name.startswith('probe'))
    print(f'{len(targets)} variant candidates found')
    results = {}
    for vp in targets:
        var = load_rgba(vp)
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

        # Resize variant to master canvas if the API returned another size.
        if vg.shape != mg.shape:
            var = cv2.resize(var, (mg.shape[1], mg.shape[0]), interpolation=cv2.INTER_LANCZOS4)
            vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

        base = vp.stem.rsplit('-', 1)[0]
        if base in ARM_VARIANTS:
            bands = (HEAD_BAND, LEGS_BAND)
        elif base.startswith('v-third-eye'):
            bands = (FACE_BAND,)
        else:  # v-no-tail: anything but the tail corner; use head+legs too
            bands = (HEAD_BAND, LEGS_BAND)
        reg_mask = region_mask(mg.shape, bands)

        warp = register_ecc(mg, vg, reg_mask)
        method = 'ecc'
        if warp is None:
            warp = register_orb(mg, vg, reg_mask)
            method = 'orb'
        if warp is None:
            print(f'{vp.name}: REGISTRATION FAILED (both methods)')
            results[vp.name] = {'ok': False, 'reason': 'no warp'}
            continue

        h, w = mg.shape
        aligned = cv2.warpAffine(var, warp, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0))
        reg_crop = reg_mask > 0
        iou = iou_in_region(alpha_of(aligned)[reg_crop], alpha_of(master)[reg_crop])

        overlay = cv2.addWeighted(master, 0.5, aligned, 0.5, 0)
        cv2.imwrite(str(QA / f'{vp.stem}-overlay.png'), overlay)

        cv2.imwrite(str(REGISTERED / vp.name), aligned)
        print(f'{vp.name}: method={method} IoU={iou:.4f} -> registered (IoU recorded, pick by overlay review)')
        results[vp.name] = {'ok': True, 'iou': round(float(iou), 4), 'method': method}

    report = REGISTERED / 'registration-report.txt'
    lines = [f'{k}: {v}' for k, v in sorted(results.items())]
    report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'report -> {report}')


if __name__ == '__main__':
    main()
