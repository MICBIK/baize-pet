#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Extract A6 expression patches from head-registered expression images.

For each demo/rig-art/expressions/eye-*.png / mouth-*.png: register the head
region onto the master (same ECC machinery as A3), then cut the eye boxes and
mouth box (10 px margin, 3 px feather) with their surrounding skin, and save
patch PNGs + offsets so rig.json can register them as slots.
"""
import os
import json
from pathlib import Path

import cv2
import numpy as np

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
SRC = ART / 'expressions'
OUT = ART / 'patches'
QA = ART / 'qa'
OUT.mkdir(parents=True, exist_ok=True)

# Boxes from parts.prompts.json (master px), widened for the patch margins.
EYE_BOXES = {
    'L': (320, 350, 420, 425),
    'R': (440, 350, 540, 425),
}
MOUTH_BOX = (400, 440, 458, 470)
MARGIN = 12
FEATHER = 3
# Round-4 shred fallback (task: a content mask that is split (> 1 opaque
# component), covers < 60 % of the master eye/mouth zone, or has holes
# inside it regresses to the round-2 full-rectangle-minus-lining mask).
MIN_BLOB = 20
SHRED_MIN_COVERAGE = 0.6
EDGE_FEATHER = 8
ZONE_PAD = 10  # px around the master stroke zone the fallback may cover
ZONE_PAD_MOUTH = 3  # the mouth box already spans the open mouth; below it is chin
# Faces whose proportions drift too far from the master for an affine head
# registration (mouth-puff renders the mouth ~20px above the box): the patch
# would paste the wrong region, so the slot stays absent and the solver's
# fallback answers it (F4).
SKIP = {'mouth-puff'}
# Round 4: eye-smile's head registration drags a band of hood lining and
# hair tips across the cheek and loses the arc itself (qa/patches-check.png)
# under both mask styles. The happy-eye arc is the closed-eye arc flipped
# vertically (lid line "u" -> "n"), so derive it from the clean closed patch.
DERIVE_FLIPPED = {'eye-smile': 'eye-closed'}


def load_rgba(p):
    im = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
    if im is None or im.ndim != 3 or im.shape[2] != 4:
        return None
    return im


def head_register(master_gray, var, master_alpha=None):
    """Coarse-to-fine ECC on the head band; identity on failure."""
    h, w = master_gray.shape
    vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)
    if vg.shape != master_gray.shape:
        var = cv2.resize(var, (w, h), interpolation=cv2.INTER_LANCZOS4)
        vg = cv2.cvtColor(var, cv2.COLOR_BGRA2GRAY)

    # Pre-align by silhouette bbox (upstream renders the subject a few percent
    # larger or smaller per frame; ECC alone diverges from that starting gap).
    if master_alpha is not None:
        def sil(img):
            # Head band only: a swung-out tail must not widen the box.
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
            var = cv2.warpAffine(
                var, pre, (w, h), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0, 0)
            )
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


def master_stroke_bbox(master, box, margin):
    """Master's own eye/mouth stroke bbox inside a slot box (master-px
    bbox of the crop), widened by 14 px — the geometry zone the patch's
    drawing may live in. Hair strands, hood rim and lining fringes sit
    outside it (or are identical to the master and unneeded)."""
    x0, y0, x1, y1 = box
    H, W = master.shape[:2]
    a = max(0, x0 - margin)
    b = min(W, x1 + margin)
    c = max(0, y0 - margin)
    d = min(H, y1 + margin)
    crop = master[c:d, a:b]
    lab = cv2.cvtColor(crop[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    strokes = (lab[..., 0] < 95) & (crop[..., 3] > 128)
    ys, xs = np.where(strokes)
    if len(ys) < 30:
        return None
    return (c, a, int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def content_mask(patch, master_crop, zone, feather, ring_px=6):
    """Round-3 content-boundary patch mask: keep only what the expression
    actually DREW DIFFERENTLY from the master (the new eye/mouth), plus a
    flat-skin blend ring. Everything the patch carries unchanged from the
    master (fringe strands, rim strokes, lining fringes, plain skin) is
    drawn by the layers beneath, so keeping it would only ghost across the
    face when the patch slides with the eye/mouth part.

    zone = master stroke bbox + pad, constraining where new drawing may
    live; blobs of change below 40 px are registration residue, dropped."""
    h, w = patch.shape[:2]
    rgb = patch[..., :3].astype(int)
    lab = cv2.cvtColor(patch[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    alpha = patch[..., 3]
    solid = alpha > 8
    diff = np.abs(rgb - master_crop[..., :3].astype(int)).mean(axis=2)
    changed = (diff > 20) & solid
    n, lbl = cv2.connectedComponents(changed.astype(np.uint8), connectivity=8)
    kept_changed = np.zeros((h, w), bool)
    dark = lab[..., 0] < 95
    for i in range(1, n):
        blob = lbl == i
        if blob.sum() < 80:
            continue  # registration residue, not a drawn feature
        if not (dark & blob).any():
            continue  # an eye/mouth drawing change always carries new strokes
        kept_changed |= blob
    sc, a0, x0s, y0s, x1s, y1s = zone
    zone_mask = np.zeros((h, w), bool)
    # stroke bbox coords are already crop-space == patch space; a tight 4 px
    # pad keeps the margin band (where rim strokes live) out of the mask
    zx0, zy0 = max(0, x0s - 4), max(0, y0s - 4)
    zx1, zy1 = min(w, x1s + 4 + 1), min(h, y1s + 4 + 1)
    zone_mask[zy0:zy1, zx0:zx1] = True
    changed_zone = kept_changed & zone_mask
    if changed_zone.sum() < 40:
        return None
    grown = cv2.dilate(changed_zone.astype(np.uint8),
                       np.ones((2 * ring_px + 1, 2 * ring_px + 1), np.uint8)) > 0
    skinish = ((np.abs(rgb[..., 0] - 248) < 22) & (np.abs(rgb[..., 1] - 225) < 24)
               & (np.abs(rgb[..., 2] - 205) < 30))
    keep = changed_zone | (skinish & solid & grown)
    soft = cv2.GaussianBlur(keep.astype(float), (2 * feather + 1, 2 * feather + 1), 0)
    return np.clip(soft * alpha, 0, 255).astype(np.uint8)


def shred_stats(alpha, zone_rect):
    """Round-4 shred check for a content mask: opaque (alpha > 128)
    components of >= MIN_BLOB px, opaque coverage of the master eye/mouth
    zone, and enclosed transparent holes (>= MIN_BLOB px) inside the zone —
    a hole shows the flat skin underlay through the new eye white."""
    zx0, zy0, zx1, zy1 = zone_rect
    solid = alpha > 128
    n, _, st, _ = cv2.connectedComponentsWithStats(solid.astype(np.uint8), connectivity=8)
    comps = int((st[1:, cv2.CC_STAT_AREA] >= MIN_BLOB).sum())
    zone = np.zeros_like(solid)
    zone[zy0:zy1, zx0:zx1] = True
    coverage = float((solid & zone).sum()) / max(1, int(zone.sum()))
    # holes: transparent components inside the zone not touching its border
    hole_src = (~solid & zone).astype(np.uint8)
    hn, hl, hst, _ = cv2.connectedComponentsWithStats(hole_src, connectivity=4)
    holes = 0
    for i in range(1, hn):
        x, y, w, h, area = hst[i]
        if area < MIN_BLOB:
            continue
        if x <= zx0 or y <= zy0 or x + w >= zx1 or y + h >= zy1:
            continue
        holes += 1
    return comps, coverage, holes


def is_shredded(stats):
    comps, coverage, holes = stats
    return comps > 1 or coverage < SHRED_MIN_COVERAGE or holes > 0


def zone_rect(zone, shape):
    """Content-mask zone (stroke bbox + 4 px pad) in patch coordinates."""
    h, w = shape[:2]
    _, _, x0s, y0s, x1s, y1s = zone
    return (max(0, x0s - 4), max(0, y0s - 4), min(w, x1s + 5), min(h, y1s + 5))


def round2_mask(patch, lining_crop, rect=None, edge=EDGE_FEATHER):
    """Round-2 fallback: the eye/mouth zone minus the hood lining, feathered.
    Round 4 bounds it by `rect` (the master stroke zone + ZONE_PAD; the full
    patch rectangle when None) and ramps alpha to zero over `edge` px inside
    that bound: no straight seam where the patch meets the face, and the
    margin band (cheek lining, hair tips a misregistered expression drags
    along, e.g. eye-smile) stays out."""
    h, w = patch.shape[:2]
    alpha = patch[..., 3].astype(float)
    if lining_crop is not None:
        alpha[lining_crop] = 0
    k = 2 * FEATHER + 1
    soft = cv2.GaussianBlur(alpha, (k, k), 0)
    alpha = alpha * 0.4 + soft * 0.6
    x0, y0, x1, y1 = rect if rect is not None else (0, 0, w, h)
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.minimum.reduce([xx - x0, yy - y0, x1 - 1 - xx, y1 - 1 - yy]).astype(float)
    ramp = np.clip(dist / edge, 0, 1)
    return np.clip(alpha * ramp, 0, 255).astype(np.uint8)


def cut_patch(img, box, margin, feather, lining=None, master=None, zone=None, log=None):
    is_mouth = box == MOUTH_BOX
    x0, y0, x1, y1 = box
    H, W = img.shape[:2]
    a = max(0, x0 - margin)
    b = min(W, x1 + margin)
    c = max(0, y0 - margin)
    d = min(H, y1 + margin)
    patch = img[c:d, a:b].copy()
    lining_crop = lining[c:d, a:b] if lining is not None else None
    if lining_crop is not None:
        # rework P0-3: never carry hood-lining amber — the patch mask is
        # subtracted by the lining zone in this region, feathered after
        patch[..., 3][lining_crop] = 0
    mode = 'round2'
    stats = None
    if zone is not None and master is not None:
        master_crop = master[c:d, a:b]
        m = content_mask(patch, master_crop, zone, feather)
        if m is not None:
            stats = shred_stats(m, zone_rect(zone, patch.shape))
            if not is_shredded(stats):
                patch[..., 3] = m
                mode = 'content'
        else:
            print('    change area degenerate')
    if mode == 'round2':
        rect = None
        if zone is not None:
            zx0, zy0, zx1, zy1 = zone_rect(zone, patch.shape)
            ph, pw = patch.shape[:2]
            pad = ZONE_PAD_MOUTH if is_mouth else ZONE_PAD
            rect = (max(0, zx0 - pad), max(0, zy0 - pad),
                    min(pw, zx1 + pad), min(ph, zy1 + pad))
        patch[..., 3] = round2_mask(patch, lining_crop, rect)
    if log is not None:
        log.update({'mask': mode, 'contentStats': list(stats) if stats else None})
    return patch, int(a), int(c)


def main():
    master = load_rgba(ART / 'master.png')
    if master is None:
        raise SystemExit('master missing')
    mg = cv2.cvtColor(master, cv2.COLOR_BGR2GRAY) if master.shape[2] == 4 else None
    mg = cv2.cvtColor(master, cv2.COLOR_BGRA2GRAY)

    # hood-lining zone (rework P0-3): amber pixels of the re-segmented hood
    hood = load_rgba(ART / 'parts-ext/hood.png')
    lab = cv2.cvtColor(hood[..., :3], cv2.COLOR_RGB2LAB)
    lining = (
        (lab[..., 1].astype(int) > 135)
        & (lab[..., 2].astype(int) > 170)
        & (hood[..., 3] > 8)
    )

    # master stroke geometry per slot (round-3 content-boundary masks).
    # Eyes: the master's stroke bbox. Mouth: the box interior — the master's
    # smile line is too light for a reliable stroke bbox, and its chin
    # shading would pull the zone down onto the hood rim; the box interior
    # excludes the rim by construction.
    zones = {}
    for side, box in EYE_BOXES.items():
        zones[f'eye-{side}'] = master_stroke_bbox(master, box, MARGIN)
    bx0, by0, bx1, by1 = MOUTH_BOX
    zones['mouth'] = (by0 - MARGIN, bx0 - MARGIN,
                      MARGIN, MARGIN, MARGIN + (bx1 - bx0), MARGIN + (by1 - by0))

    report = {}
    for p in sorted(SRC.glob('*.png')):
        var = load_rgba(p)
        if var is None:
            continue
        _, aligned = head_register(mg, var, master[..., 3])
        name = p.stem
        if name in SKIP:
            continue
        entry = {}
        if name.startswith('eye-'):
            for side, box in EYE_BOXES.items():
                zone = zones[f'eye-{side}']
                log = {}
                patch, ox, oy = cut_patch(aligned, box, MARGIN, FEATHER, lining,
                                          master=master, zone=zone, log=log)
                out = OUT / f'{name}-{side}.png'
                cv2.imwrite(str(out), patch)
                entry[side] = {'image': str(out.relative_to(ROOT)), 'offset': [ox, oy], **log}
        elif name.startswith('mouth-'):
            log = {}
            patch, ox, oy = cut_patch(aligned, MOUTH_BOX, MARGIN, FEATHER, lining,
                                      master=master, zone=zones['mouth'], log=log)
            out = OUT / f'{name}.png'
            cv2.imwrite(str(out), patch)
            entry = {'image': str(out.relative_to(ROOT)), 'offset': [ox, oy], **log}
        else:
            continue
        report[name] = entry
        print(f'{name}: patch ok ' + ' '.join(
            f"{k}={v.get('mask')}" for k, v in entry.items() if isinstance(v, dict))
            + (f" mask={entry.get('mask')}" if 'mask' in entry else ''))

    for name, src in DERIVE_FLIPPED.items():
        if src not in report:
            continue
        entry = {}
        for side in ('L', 'R'):
            img = cv2.imread(str(OUT / f'{src}-{side}.png'), cv2.IMREAD_UNCHANGED)
            out = OUT / f'{name}-{side}.png'
            cv2.imwrite(str(out), img[::-1].copy())
            entry[side] = {'image': str(out.relative_to(ROOT)),
                           'offset': report[src][side]['offset'],
                           'mask': f'derived:{src}:flip-v'}
        report[name] = entry
        print(f'{name}: derived from {src} (vertical flip)')

    # R6-5 (method B): the cat mouth as a program-drawn ω. The generated
    # variant's patch carried only a grey chin smudge (4 rose px, dropped at
    # export) and no image API key is available in this environment, so the
    # slot is drawn directly: two downward arcs joined at a small centre
    # tip — width 1.1x the master's own smile line, stroke colour/width from
    # the smile's ink, 4x supersampled then area-downscaled. The median
    # stroke (hue 11, sat 87) is brown-line ink, so clean_mouth_patch keeps
    # it, and the arcs' shared endpoint forms the centre tip.
    def draw_cat_mouth():
        bx0, by0, bx1, by1 = MOUTH_BOX
        box = master[by0:by1, bx0:bx1]
        rgb = cv2.cvtColor(box, cv2.COLOR_BGRA2RGBA)
        hsv = cv2.cvtColor(rgb[..., :3], cv2.COLOR_RGB2HSV).astype(np.int32)
        hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        ink = (box[..., 3] > 100) & (
            ((hue >= 150) | (hue <= 8)) & (sat > 45)          # pink interior
            | (val < 120)                                     # dark outline
            | ((hue <= 20) & (sat >= 45) & (val < 250)))      # brown stroke
        ys, xs = np.where(ink)
        if len(ys) < 20:
            print('mouth-cat: no measurable smile line, slot left to solver fallback')
            return
        smile_w = int(xs.max() - xs.min() + 1)
        cx = int((xs.max() + xs.min()) / 2) + bx0
        corner_y = int((ys.max() + ys.min()) / 2) + by0
        col = tuple(int(v) for v in np.median(box[..., :3][ink], axis=0))  # BGR
        runs = []
        for c in range(ink.shape[1]):
            n = 0
            for v in ink[:, c]:
                if v:
                    n += 1
                elif n:
                    runs.append(n)
                    n = 0
            if n:
                runs.append(n)
        stroke = max(2, int(round(float(np.median(runs)))))
        w = max(3 * stroke, int(round(smile_w * 1.1)))   # 1.0-1.2x smile line
        r = w // 4
        S, m = 4, 6
        pw, ph = w + 2 * m, r + stroke + 2 * m
        big = np.zeros((ph * S, pw * S, 4), np.uint8)
        jx, jy = (m + w // 2) * S, (m + stroke // 2) * S
        for sgn in (-1, 1):
            cv2.ellipse(big, (jx + sgn * r * S, jy), (r * S, r * S), 0,
                        0, 180, (col[0], col[1], col[2], 255), stroke * S,
                        cv2.LINE_AA)
        patch = cv2.resize(big, (pw, ph), interpolation=cv2.INTER_AREA)
        out = OUT / 'mouth-cat.png'
        cv2.imwrite(str(out), patch)
        ox, oy = cx - w // 2 - m, corner_y - (m + stroke // 2)
        report['mouth-cat'] = {'image': str(out.relative_to(ROOT)),
                               'offset': [ox, oy], 'mask': 'drawn:omega'}
        print(f'mouth-cat: drawn omega w={w} stroke={stroke} '
              f'col(BGR)={col} offset=({ox},{oy})')

    draw_cat_mouth()

    # keep entries this script does not produce (gen_mouths small/mid/o,
    # extract_third_eye half/open) so a re-run never drops other slots
    report_path = OUT / 'patches-report.json'
    if report_path.exists():
        old = json.loads(report_path.read_text(encoding='utf-8'))
        for k, v in old.items():
            report.setdefault(k, v)
    (OUT / 'patches-report.json').write_text(
        json.dumps(report, indent=1) + '\n', encoding='utf-8'
    )
    print(f'{len(report)} patches -> {OUT}')


if __name__ == '__main__':
    main()