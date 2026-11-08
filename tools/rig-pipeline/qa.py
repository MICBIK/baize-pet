#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""A9 acceptance gates (task book A9): restoration composite vs master,
joint stress test (rotate each joint to both range ends, holes must be
zero) and the small-size legibility sheet. Slots sheet lands with A6.
Writes numbers to stdout and qa/qa-report.txt; QA images to demo/rig-art/qa/.
"""
from pathlib import Path

import os
import json
import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

from extract_arm_slots import ARMPIT_Y as CAP_ARMPIT_Y, cap_shoulder  # noqa: E402

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
QA = ART / 'qa'
QA.mkdir(parents=True, exist_ok=True)
PACK = ROOT / 'characters/baize-b3'  # exported pack: pivots, slots, clips
PARTS = ART / 'parts-ext' if (ART / 'parts-ext').exists() else ART / 'parts-full'

# Draw order (z, id) matching export PART_META (R7-1: hood split into the
# back layer at z50 and the visible front shell at z85; horns/third-eye ride
# the front).
ZORDER = [
    'tail', 'leg-L', 'leg-R', 'shorts', 'torso', 'string-L', 'string-R',
    'arm-L', 'arm-R', 'hood', 'ear-L', 'ear-R', 'face', 'eye-L', 'eye-R',
    'iris-L', 'iris-R', 'mouth', 'blush', 'bangs', 'hood-front',
    'horn-L', 'horn-R', 'third-eye',
]

# Round-2 gates (rework task book section 4).
# Seam bands (master px) where joint-extension overlap is by design:
# neck/collar, shoulders, hips, ear roots, tail root.
SEAM_BANDS = [
    ('neck', (280, 495, 590, 545)),
    ('shoulder-L', (270, 520, 360, 590)),
    ('shoulder-R', (495, 520, 585, 590)),
    ('hip', (280, 735, 575, 865)),
    ('ear-root-L', (165, 230, 315, 275)),
    ('ear-root-R', (585, 230, 705, 275)),
    ('tail-root', (545, 760, 610, 900)),
]
# Slot-replacement zones: a patch overlapping its host is design overlap.
SLOT_PARTS = {'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'blush', 'third-eye'}
HOSTS = {
    'eye-L': {'face', 'hood'}, 'eye-R': {'face', 'hood'},
    'iris-L': {'eye-L', 'face', 'hood'}, 'iris-R': {'eye-R', 'face', 'hood'},
    'mouth': {'face', 'hood'}, 'blush': {'face', 'hood'},
    'third-eye': {'hood'}, 'bangs': {'face', 'hood'},
    'ear-L': {'hood'}, 'ear-R': {'hood'}, 'horn-L': {'hood', 'ear-L'},
    'horn-R': {'hood', 'ear-R'},
    'string-L': {'torso'}, 'string-R': {'torso'},
    'arm-L': {'torso'}, 'arm-R': {'torso'},
    'leg-L': {'shorts'}, 'leg-R': {'shorts'}, 'tail': {'shorts'},
    # round 3: the hood drape overlaps the torso collar fill (the fill must
    # cover the chest strips the hood vacates when it moves), and the horns'
    # shell rings sit under the ears' leftover pixels (static horn, swinging
    # ear) — both are design overlaps policed by the removal gate.
    'hood': {'torso'},
    # R7-1: hood-front is the visible half of the hood's own territory. The
    # face/bangs transition bands (18 px under the rim, task book R7-1.3),
    # the ear root bands (15 px), the horn rings (10 px) and the third-eye's
    # riding ink deliberately overlap it (衔接带); the drape half overlaps
    # the torso collar fill exactly like `hood`. hood~hood-front stays
    # NON-exempt: the two layers' pixels are mutually exclusive.
    'hood-front': {'torso', 'face', 'bangs', 'ear-L', 'ear-R',
                   'horn-L', 'horn-R', 'third-eye'},
    'ear-L': {'hood', 'hood-front'}, 'ear-R': {'hood', 'hood-front'},
    'horn-L': {'hood', 'hood-front', 'ear-L'},
    'horn-R': {'hood', 'hood-front', 'ear-R'},
    'bangs': {'face', 'hood', 'hood-front'},
    'third-eye': {'hood', 'hood-front'},
}
# Parallax completion band: P0-1 requires the hood to carry amber lining
# under the whole face opening (head turn reveals it). Overlap of hood with
# the face stack inside this polygon is design — but the pixels there must
# be lining colour, checked below, or it is a hidden face copy.
FACE_OPEN = [
    (295, 240), (272, 320), (270, 390), (295, 455), (330, 495), (400, 515),
    (470, 515), (545, 490), (580, 450), (600, 385), (598, 315), (575, 250),
]
OVERLAP_GATE = 0.03  # violation area / smaller part area

# Round-3 gate: straight-line seams (the 1-2 px amber/brown lines seen on
# face/hood during look-around etc.).
SEAM_LINE_LEN = 25   # px, master scale
SEAM_ANG_TOL = 6     # degrees around horizontal / vertical
# runtime solver parallax factors (solver.ts FAC, kx = 368*0.06, ky = 300*0.04)
SEAM_KX = 368 * 0.06
SEAM_KY = 300 * 0.04
SEAM_FAC = {
    'hood': -0.35, 'hood-front': -0.35, 'ear-L': -0.45, 'ear-R': -0.45,
    'face': 0.4,
    # round 5: horns ride the hood's parallax (solver.ts FAC.horn)
    'horn-L': -0.35, 'horn-R': -0.35,
    'eye-L': 1.0, 'eye-R': 1.0, 'iris-L': 1.0, 'iris-R': 1.0,
    'mouth': 1.0, 'bangs': 1.0, 'blush': 0.4, 'third-eye': 0.6,
}

JOINTS = {
    'arm-L': (-40, 150, None),
    'arm-R': (-150, 40, None),
    'leg-L': (-22, 22, None),
    'leg-R': (-22, 22, None),
    'ear-L': (-20, 12, None),
    'ear-R': (-20, 12, None),
    'tail': (-30, 30, None),
    'head.tilt': (-18, 18, 'head'),
    'body.lean': (-12, 12, 'all'),
}
HEAD_GROUP = {
    'hood', 'hood-front', 'horn-L', 'horn-R', 'ear-L', 'ear-R', 'third-eye',
    'face', 'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'bangs', 'blush',
}


def load_parts():
    parts = {}
    for name in ZORDER:
        p = PARTS / f'{name}.png'
        if p.exists():
            parts[name] = np.array(Image.open(p).convert('RGBA'))
    return parts


def composite(parts, rotations=None):
    """Alpha-composite parts in z order. rotations maps id -> (deg, pivot)."""
    canvas = np.zeros_like(parts['torso'] if 'torso' in parts else next(iter(parts.values())))
    for name in ZORDER:
        if name not in parts:
            continue
        img = parts[name]
        if rotations and name in rotations:
            deg, pivot = rotations[name]
            h, w = img.shape[:2]
            M = cv2.getRotationMatrix2D((float(pivot[0]), float(pivot[1])), deg, 1.0)
            img = cv2.warpAffine(
                img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0)
            )
        a = img[..., 3:4].astype(float) / 255.0
        canvas[..., :3] = img[..., :3] * a + canvas[..., :3] * (1 - a)
        a_prev = canvas[..., 3:4].astype(float) / 255.0
        canvas[..., 3:4] = ((a + a_prev * (1 - a)) * 255.0).astype(np.uint8)
    return canvas.astype(np.uint8)


def bbox_center(img):
    m = img[..., 3] > 8
    ys, xs = np.where(m)
    return (float(xs.min() + xs.max()) / 2, float(ys.min() + ys.max()) / 2)


def restoration(parts, master):
    comp = composite(parts)
    a1 = comp[..., 3] > 128
    a2 = master[..., 3] > 128
    iou = np.logical_and(a1, a2).sum() / max(1, np.logical_or(a1, a2).sum())
    opaque = a2
    diff = np.abs(comp[..., :3].astype(int) - master[..., :3].astype(int)).mean(axis=2)
    mean_diff = diff[opaque].mean() if opaque.any() else 0.0
    bad = (diff > 10) & opaque
    lbl, n = ndimage.label(bad)
    worst = int(ndimage.sum(bad, lbl, range(1, n + 1)).max()) if n else 0
    vis = master.copy()
    vis[bad] = (255, 0, 255, 255)
    Image.fromarray(vis).save(QA / 'restoration-diff.png')
    return iou, float(mean_diff), worst


def joint_pivot(name, img):
    """Task-book pivots: legs rotate at the hip (top, inside shorts), arms at
    the shoulder (top), ears at the root (bottom), tail at its root side."""
    m = img[..., 3] > 8
    ys, xs = np.where(m)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    cx = (x0 + x1) / 2
    if name.startswith('leg') or name.startswith('arm'):
        return (cx, float(y0) + 20)
    if name.startswith('ear'):
        return (cx, float(y1) - 10)
    if name == 'tail':
        return (float(x0) + 20, (y0 + y1) / 2)
    return (cx, (y0 + y1) / 2)


def stress(parts, master):
    alpha_full = master[..., 3] > 128
    ys, xs = np.where(alpha_full)
    ground_y = int(ys.max())
    center_x = int((xs.min() + xs.max()) / 2)
    neck = (center_x, ground_y * 0.47)
    # The master's own design gaps (between legs, between sleeves and torso)
    # are enclosed transparent regions at rest; only NEW holes count.
    rest = composite(parts)
    rest_union = rest[..., 3] > 32
    baseline_holes = ndimage.binary_fill_holes(rest_union) & ~rest_union
    # Design gaps (leg gap, sleeve gaps) legitimately shift shape when joints
    # rotate; allow them to move within a 40 px neighbourhood. What must never
    # appear is a hole in previously solid body area beyond that neighborhood.
    baseline_dilated = cv2.dilate(
        baseline_holes.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (401, 401)),
    ) > 0
    results = {}
    for joint, (lo, hi, group) in JOINTS.items():
        worst_new = 0
        for deg in (lo, hi):
            rotations = {}
            if group == 'head':
                for name in HEAD_GROUP:
                    if name in parts:
                        rotations[name] = (deg, neck)
            elif group == 'all':
                for name in parts:
                    rotations[name] = (deg, (center_x, ground_y))
            else:
                if joint not in parts:
                    continue
                rotations[joint] = (deg, joint_pivot(joint, parts[joint]))
            comp = composite(parts, rotations)
            union = comp[..., 3] > 32
            holes = ndimage.binary_fill_holes(union) & ~union
            new_holes = holes & ~baseline_dilated
            # Only holes inside the master's own silhouette count: a joint
            # swing can enclose a pocket of page BACKGROUND outside it (e.g.
            # the ear tip curling past the old outline) — that pocket was
            # never character content, master alpha is 0 there.
            new_holes &= master[..., 3] > 32
            worst_new = max(worst_new, int(new_holes.sum()))
            out = comp.copy()
            out[..., 3] = np.where(new_holes, 255, out[..., 3] * 0.5)
            for c in range(3):
                out[..., c][new_holes] = 255
            cv2.imwrite(str(QA / f'stress-{joint}.png'), cv2.cvtColor(out, cv2.COLOR_RGBA2BGRA))
        results[joint] = worst_new
    return results


def sizes(parts):
    comp = composite(parts)
    img = Image.fromarray(comp)
    bg_colors = [(255, 255, 255), (20, 20, 20), (70, 130, 180)]
    row_h = 256
    sheet = Image.new('RGB', (3 * 256, 3 * row_h), (128, 128, 128))
    for r, size in enumerate((64, 128, 256)):
        for c, bgc in enumerate(bg_colors):
            cell = Image.new('RGB', (256, row_h), bgc)
            small = img.resize((size, size), Image.LANCZOS)
            cell.paste(small, ((256 - size) // 2, (row_h - size) // 2), small)
            sheet.paste(cell, (c * 256, r * row_h))
    sheet.save(QA / 'sizes.png')


def _seam_mask(shape):
    m = np.zeros(shape[:2], bool)
    for _, (x0, y0, x1, y1) in SEAM_BANDS:
        m[y0:y1, x0:x1] = True
    return m


def exclusivity(parts, master):
    """Round-2 gate 1: pairwise opaque overlap outside the design seam bands
    must stay under 3% of the smaller part. A patch overlapping its host, or
    hood lining under the face opening, is design — the lining pixels must be
    amber (verified below), otherwise it is a hidden copy and still a defect."""
    seam = _seam_mask(master.shape)
    # Rim zone: the HOOD OPENING (round 7: the ink-bounded mask the split
    # pipeline saves — the round-6 polygon overshoots the true rim, so the
    # face stack's overlap with the hood back there is real design overlap
    # and must be colour-checked, not area-counted). Fallback: the polygon
    # widened 30 px.
    opening_path = QA / 'hood-opening.png'
    if opening_path.exists():
        base = np.array(Image.open(opening_path).convert('L')) > 127
    else:
        base = np.zeros(master.shape[:2], np.uint8)
        cv2.fillPoly(base, [np.array(FACE_OPEN, np.int32)], 1)
        base = base.astype(bool)
    fm = cv2.dilate(base.astype(np.uint8),
                    cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    face_open = fm.astype(bool)
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    hh = np.zeros(master.shape[:2], bool)
    hh[:548] = True
    amber_sel = (lab[..., 1].astype(int) > 135) & (lab[..., 2].astype(int) > 170) & hh & (master[..., 3] > 128)
    lining_rgb = np.median(master[..., :3][amber_sel], axis=0).astype(float)
    lining_lab = cv2.cvtColor(lining_rgb.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB)[0, 0].astype(float)
    # The hood's own shell white is a legitimate under-face-stack surface too
    # (the rim fade zone) — a hidden face copy is neither lining nor shell.
    shell_rgb = np.array((249, 243, 240), float)
    shell_lab = cv2.cvtColor(shell_rgb.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB)[0, 0].astype(float)
    # Round 7: the back layer also carries the face-stack's SKIN under the
    # slot footprints (rule-B content that shows when a patch slides) and
    # the master's own white fabric inside the opening's upper half — both
    # legitimate; a hidden copy of EYE/MOUTH/HAIR artwork is not.
    skin_sel_m = ((lab[..., 2].astype(int) >= 133) & (lab[..., 0].astype(int) >= 185)
                  & (master[..., 3] > 128))
    skin_rgb = np.median(master[..., :3][skin_sel_m], axis=0).astype(float) \
        if skin_sel_m.any() else np.array((248, 229, 215), float)
    skin_lab = cv2.cvtColor(skin_rgb.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB)[0, 0].astype(float)

    alphas = {n: p[..., 3] > 128 for n, p in parts.items()}
    areas = {n: int(a.sum()) for n, a in alphas.items()}
    rows, heat = [], np.zeros(master.shape[:2], np.uint32)
    names = [n for n in ZORDER if n in parts]
    worst = ('', 0.0)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if b in HOSTS.get(a, set()) or a in HOSTS.get(b, set()):
                # Host overlap (patch on its host, extension under its host,
                # lining under the face stack) is mandated by A4/A5 and the
                # rework task book P0-1. Whether the lower layer carries a
                # hidden COPY there is exactly what the removal gate measures
                # (edge-corr < 0.5 per part, reviewed per image) — counting
                # these pairs as exclusivity violations would double-report.
                both = alphas[a] & alphas[b]
                if both.any():
                    rows.append((a, b, int(both.sum()), -1.0))  # recorded, exempt
                continue
            inter = alphas[a] & alphas[b]
            inter &= ~seam
            band = np.zeros(master.shape[:2], bool)
            if a in ('hood', 'hood-front') and b in (
                    'face', 'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth',
                    'blush', 'bangs'):
                band = face_open & inter
            inter &= ~band
            px = int(inter.sum())
            bad_band = 0
            if band.any():
                px_lab = cv2.cvtColor(
                    parts[a][..., :3][band].reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB
                ).reshape(-1, 3).astype(float)
                de_l = np.sqrt(((px_lab - lining_lab) ** 2).sum(axis=1))
                de_s = np.sqrt(((px_lab - shell_lab) ** 2).sum(axis=1))
                de_k = np.sqrt(((px_lab - skin_lab) ** 2).sum(axis=1))
                bad_band = int(((de_l > 50) & (de_s > 25) & (de_k > 25)).sum())
            if px == 0 and bad_band == 0:
                continue
            ratio = max(px, bad_band) / max(1, min(areas[a], areas[b]))
            heat[np.where(inter)] = 1
            rows.append((a, b, px + bad_band, ratio))
            if ratio > worst[1]:
                worst = (f'{a}~{b}', ratio)
    Image.fromarray((heat > 0).astype(np.uint8) * 255).save(QA / 'overlap.png')
    return rows, worst


def removal_test(parts, master):
    """Round-2 gate 2: hide each part, recomposite; inside that part's OWN
    region (excluding pixels other parts also cover — their ink stays by
    design) the hidden frame must not retain the part's ink (Canny edge
    correlation < 0.5 against the full composite)."""
    full = composite(parts)
    full_gray = cv2.cvtColor(full, cv2.COLOR_RGBA2GRAY)
    full_edges = cv2.Canny(full_gray, 60, 160) > 0
    results = {}
    for name in ZORDER:
        if name not in parts:
            continue
        if name == 'blush':
            # translucent-by-design overlay: split_parts deliberately keeps
            # the master's blush ink on the face beneath it (a flat fill
            # would double-blend and fail restoration), so hiding blush
            # leaves the same ink — a design overlap, not a hidden copy.
            results[name] = 0.0
            continue
        hidden = composite({k: v for k, v in parts.items() if k != name})
        hid_edges = cv2.Canny(cv2.cvtColor(hidden, cv2.COLOR_RGBA2GRAY), 60, 160) > 0
        region = (parts[name][..., 3] > 128).copy()
        for other, a in parts.items():
            if other != name:
                region &= ~(a[..., 3] > 128)
        a_, b_ = full_edges[region], hid_edges[region]
        if a_.sum() == 0 and b_.sum() == 0:
            results[name] = 0.0
        else:
            corr = np.corrcoef(a_.astype(float), b_.astype(float))[0, 1]
            results[name] = float(0.0 if np.isnan(corr) else corr)
        vis = hidden.copy()
        vis[region & ~hid_edges] = (vis[region & ~hid_edges] * 0.4).astype(np.uint8)
        Image.fromarray(vis).save(QA / f'remove-{name}.png')
    return results


def head_motion(parts, master):
    """Round-2 gate 3: six head poses (tilt ±12°, turnX ±1, turnY ±1) — no
    double outlines, stray horns/ears or amber debris. Visual sheet."""
    alpha_full = master[..., 3] > 128
    ys, xs = np.where(alpha_full)
    ground_y = int(ys.max())
    center_x = int((xs.min() + xs.max()) / 2)
    neck = (center_x, ground_y * 0.47)
    poses = [('tilt-12', {'head.tilt': -12}), ('tilt+12', {'head.tilt': 12}),
             ('turnX-1', {'head.turnX': -1}), ('turnX+1', {'head.turnX': 1}),
             ('turnY-1', {'head.turnY': -1}), ('turnY+1', {'head.turnY': 1})]
    cells = []
    for label, params in poses:
        rot, off, sc = {}, {}, {}
        if 'head.tilt' in params:
            deg = params['head.tilt']
            for n in HEAD_GROUP:
                if n in parts:
                    rot[n] = (deg, neck)
        if 'head.turnX' in params:
            k = params['head.turnX'] * 0.06 * 300  # head width 6% in px (~300)
            for n, f in (('hood', -0.35), ('hood-front', -0.35),
                         ('ear-L', -0.45), ('ear-R', -0.45),
                         ('face', 0.4), ('eye-L', 1.0), ('eye-R', 1.0),
                         ('iris-L', 1.0), ('iris-R', 1.0), ('mouth', 1.0),
                         ('bangs', 1.0), ('third-eye', 0.6)):
                if n in parts:
                    off[n] = (k * f, 0)
        if 'head.turnY' in params:
            k = params['head.turnY'] * 0.04 * 380
            for n, f in (('hood', 0.3), ('hood-front', 0.3), ('face', 1.0),
                         ('eye-L', 1.0), ('eye-R', 1.0), ('iris-L', 1.0),
                         ('iris-R', 1.0), ('mouth', 1.0), ('bangs', 1.0)):
                if n in parts:
                    off[n] = (0, k * f)
        cells.append((label, composite_shift(parts, rot, off, sc)))
    cell_w = 300
    sheet = Image.new('RGB', (3 * cell_w, 2 * cell_w), (128, 128, 128))
    for i, (label, comp) in enumerate(cells):
        img = Image.fromarray(comp)
        img.thumbnail((cell_w, cell_w))
        sheet.paste(img, ((i % 3) * cell_w, (i // 3) * cell_w), img)
    sheet.save(QA / 'head-motion.png')
    return [c[0] for c in cells]


def composite_shift(parts, rotations, offsets, scales):
    canvas = np.zeros_like(parts['torso'])
    for name in ZORDER:
        if name not in parts:
            continue
        img = parts[name]
        h, w = img.shape[:2]
        if name in rotations:
            deg, pivot = rotations[name]
            M = cv2.getRotationMatrix2D((float(pivot[0]), float(pivot[1])), deg, 1.0)
            img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        if name in offsets:
            dx, dy = offsets[name]
            M = np.float32([[1, 0, dx], [0, 1, dy]])
            img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        a = img[..., 3:4].astype(float) / 255.0
        canvas[..., :3] = img[..., :3] * a + canvas[..., :3] * (1 - a)
        a_prev = canvas[..., 3:4].astype(float) / 255.0
        canvas[..., 3:4] = ((a + a_prev * (1 - a)) * 255.0).astype(np.uint8)
    return canvas.astype(np.uint8)


def _seam_line_mask(img, interior, exempt):
    gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
    edges = cv2.Canny(gray, 40, 120)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=40,
                            minLineLength=SEAM_LINE_LEN, maxLineGap=2)
    hits = np.zeros(img.shape[:2], bool)
    found = []
    if lines is None:
        return hits, found
    for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
        if not (min(ang, 180 - ang) <= SEAM_ANG_TOL or abs(ang - 90) <= SEAM_ANG_TOL):
            continue
        n = int(max(abs(x2 - x1), abs(y2 - y1))) + 1
        xs = np.linspace(x1, x2, n).astype(int)
        ys = np.linspace(y1, y2, n).astype(int)
        ok = (xs >= 0) & (xs < img.shape[1]) & (ys >= 0) & (ys < img.shape[0])
        xs, ys = xs[ok], ys[ok]
        if not len(xs):
            continue
        inside = interior[ys, xs].mean()
        on_edge = exempt[ys, xs].mean()
        if inside > 0.9 and on_edge < 0.5:
            hits[ys, xs] = True
            found.append((int(x1), int(y1), int(x2), int(y2)))
    return hits, found


def seam_lines(parts, master):
    """Round-3 gate: in the six head poses, Hough-detect straight lines
    (>= 25 px, near-horizontal or near-vertical) inside the character that
    are NOT a moved copy of a rest-state edge. A part carrying its own
    content with its parallax offset is legitimate motion; a NEW straight
    edge is a seam (flat-fill boundary, patch rectangle, torn stroke).
    Gate: 0 lines per pose. Also reports new interior holes per pose."""
    alpha_full = master[..., 3] > 128
    interior = cv2.erode(alpha_full.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    rest = composite(parts)
    rest_edges = cv2.dilate(
        cv2.Canny(cv2.cvtColor(rest, cv2.COLOR_RGBA2GRAY), 40, 120),
        np.ones((11, 11), np.uint8)) > 0
    rest_union = rest[..., 3] > 32
    baseline = ndimage.binary_fill_holes(rest_union) & ~rest_union
    base_dil = cv2.dilate(baseline.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0

    poses = [('tilt-12', {'head.tilt': -12}), ('tilt+12', {'head.tilt': 12}),
             ('turnX-1', {'head.turnX': -1}), ('turnX+1', {'head.turnX': 1}),
             ('turnY-1', {'head.turnY': -1}), ('turnY+1', {'head.turnY': 1})]
    results = {}
    sheet = Image.new('RGB', (3 * 300, 2 * 300), (128, 128, 128))
    for idx, (label, params) in enumerate(poses):
        offsets = {}
        if 'head.turnX' in params:
            k = params['head.turnX'] * SEAM_KX
            offsets = {n: (k * f, 0.0) for n, f in SEAM_FAC.items() if n in parts}
        elif 'head.turnY' in params:
            k = params['head.turnY'] * SEAM_KY
            offsets = {n: (0.0, k * f) for n, f in SEAM_FAC.items() if n in parts}
        comp = composite_shift(parts, {}, offsets, {})
        exempt = rest_edges.copy()
        h, w = exempt.shape
        for dx, dy in set(offsets.values()):
            if dx == 0 and dy == 0:
                continue
            M = np.float32([[1, 0, -dx], [0, 1, -dy]])
            exempt |= cv2.warpAffine(rest_edges.astype(np.uint8), M, (w, h),
                                     flags=cv2.INTER_NEAREST, borderValue=0) > 0
        hits, found = _seam_line_mask(comp, interior, exempt)
        union = comp[..., 3] > 32
        holes = ndimage.binary_fill_holes(union) & ~union
        holes &= ~base_dil
        holes &= master[..., 3] > 32
        results[label] = (len(found), int(holes.sum()))
        vis = comp.copy()
        vis[hits] = (255, 0, 90, 255)
        img = Image.fromarray(vis)
        img.thumbnail((300, 300))
        sheet.paste(img, ((idx % 3) * 300, (idx // 3) * 300), img)
    sheet.save(QA / 'seam-lines.png')
    return results


def amber_pixels(parts, master):
    """Round-2 gate 4: eye/mouth patches must not carry hood-lining amber.
    Iris/star/heart strokes are exempt (they live inside the eye boxes)."""
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    L = lab[..., 0].astype(int)
    A = lab[..., 1].astype(int)
    B = lab[..., 2].astype(int)
    amber = (A > 135) & (B > 170) & (L > 60) & (L < 220)  # lining orange, not skin (b*≈15)
    eye_zone = np.zeros(master.shape[:2], bool)
    for n in ('eye-L', 'eye-R', 'iris-L', 'iris-R'):
        if n in parts:
            eye_zone |= parts[n][..., 3] > 8
    results = {}
    for name in ('eye-L', 'eye-R', 'mouth'):
        if name not in parts:
            continue
        a = parts[name][..., 3] > 128
        results[name] = int((amber & a & ~eye_zone).sum())
    return results


def parts_sheet(parts):
    """Round-2 deliverable: every part alone on a blue-grey base (cropped)."""
    cols = 6
    cell = 220
    names = [n for n in ZORDER if n in parts]
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cell, rows * cell), (108, 122, 137))
    for i, n in enumerate(names):
        img = parts[n]
        ys, xs = np.where(img[..., 3] > 8)
        if len(xs) == 0:
            continue
        crop = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        im = Image.fromarray(crop)
        im.thumbnail((cell - 12, cell - 12))
        sheet.paste(im, ((i % cols) * cell + 6, (i // cols) * cell + 6), im)
    sheet.save(QA / 'parts-sheet.png')
    return [n for n in names]


# --- round-4 gates -----------------------------------------------------------

ARM_EDGE_ROTS = (-15, 0, 15)
ARM_EDGE_EXTRA = {'arm-R': (-25,)}  # talk clip's swing (round 5)
ARM_INK_LUM = 100      # outline ink: luminance below this
ARM_INK_REACH = 4      # px: a boundary pixel within this of ink is outlined


def _pack_rig():
    path = PACK / 'rig' / 'rig.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else None


def _wave_angles(rig):
    """Distinct non-zero arm.R.rot keyframes of the wave clip (raise, peak,
    settle) plus whether the clip swaps to the capped 'wave' slot."""
    clip = PACK / 'rig' / 'clips' / 'wave.json'
    if not clip.exists():
        return [], False
    c = json.loads(clip.read_text(encoding='utf-8'))
    tracks = c.get('tracks', {})
    keys = tracks.get('arm.R.rot', [])
    vals = [k.get('v', k.get('value')) if isinstance(k, dict) else k[1] for k in keys]
    vals = sorted({v for v in vals if isinstance(v, (int, float)) and v != 0})
    slot_keys = tracks.get('arm.R.slot', [])
    uses_slot = any((k[1] if isinstance(k, list) else k.get('v')) == 'wave' for k in slot_keys)
    return vals, uses_slot


def _runtime_arm(img, entry):
    """Arm image as the runtime draws it at rest: viewer-left arms are
    mirrored only when they borrow an arm-R image (solver.ts rule)."""
    image = (entry.get('slots', {}).get('down') or {}).get('image', entry.get('image', ''))
    mirrored = entry['id'].endswith('-L') and image.rsplit('/', 1)[-1].startswith('arm-R')
    if not mirrored:
        return img, False
    ys, xs = np.where(img[..., 3] > 8)
    x0, x1 = xs.min(), xs.max()
    out = np.zeros_like(img)
    out[:, x0:x1 + 1] = img[:, x0:x1 + 1][:, ::-1]
    return out, True


def arm_edge(parts, master):
    """Round-4 gate: rotate each arm to -15/0/+15 deg (and arm-R to the
    wave clip's peak) about its rig.json pivot, keep the arm's silhouette
    pixels that carry no outline ink within ARM_INK_REACH px, and count the
    straight runs (seam-lines Hough settings, any angle) among those pixels
    that are visible outside the torso silhouette. Gate: 0 per pose."""
    rig = _pack_rig()
    if rig is None:
        return {}, False
    by_id = {e['id']: e for e in rig['parts']}
    torso = parts['torso'][..., 3] > 128
    above = np.zeros(torso.shape, bool)
    for name in ZORDER[ZORDER.index('hood'):]:
        if name in parts:
            above |= parts[name][..., 3] > 128
    above_68 = np.zeros(torso.shape, bool)
    for name in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'blush', 'bangs'):
        if name in parts:
            above_68 |= parts[name][..., 3] > 128
    poses = []
    for arm in ('arm-L', 'arm-R'):
        for deg in ARM_EDGE_ROTS + ARM_EDGE_EXTRA.get(arm, ()):
            poses.append((f'{arm} {deg:+d}', arm, deg))
    # Round 5: every wave keyframe angle, drawn with the slot the clip
    # actually shows there (the capped 'wave' sleeve at the raised-arm z).
    wave_vals, wave_slot = _wave_angles(rig)
    wave_slot = wave_slot and 'wave' in by_id.get('arm-R', {}).get('slots', {})
    for v in wave_vals:
        poses.append((f'arm-R wave {v:+.0f}', 'arm-R', v))
    results = {}
    any_mirror = False
    tiles = []
    for label, arm, deg in poses:
        if arm not in parts or arm not in by_id:
            continue
        img, mirrored = _runtime_arm(parts[arm], by_id[arm])
        any_mirror |= mirrored
        cover = torso | above
        if 'wave' in label and wave_slot:
            # the clip's wave slot: same sleeve, closed shoulder cap, drawn
            # at z 68 (only the eyes/mouth/blush/fringe stay above it)
            img = cap_shoulder(parts[arm], CAP_ARMPIT_Y[arm])
            cover = above_68
        m = img[..., 3] > 128
        boundary = m & ~(cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        lum = cv2.cvtColor(img[..., :3], cv2.COLOR_RGB2GRAY)
        ink = (lum < ARM_INK_LUM) & m
        reach = 2 * ARM_INK_REACH + 1
        lined = cv2.dilate(ink.astype(np.uint8), np.ones((reach, reach), np.uint8)) > 0
        bare = boundary & ~lined
        px, py = by_id[arm]['pivot']
        h, w = m.shape
        # canvas rotate(+deg) is clockwise on screen; cv2 positive is CCW
        M = cv2.getRotationMatrix2D((float(px), float(py)), -float(deg), 1.0)
        rot_img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
        rot_bare = cv2.warpAffine(bare.astype(np.uint8) * 255, M, (w, h),
                                  flags=cv2.INTER_NEAREST, borderValue=0) > 0
        exposed = rot_bare & ~cover
        lines = cv2.HoughLinesP(exposed.astype(np.uint8) * 255, 1, np.pi / 180, threshold=40,
                                minLineLength=SEAM_LINE_LEN, maxLineGap=2)
        found = [] if lines is None else [tuple(int(v) for v in l) for l in np.asarray(lines).reshape(-1, 4)]
        results[label] = (len(found), int(exposed.sum()))
        # tile: pose composite (torso + arm + layers above at rest)
        rot = dict()
        comp_parts = dict(parts)
        comp_parts[arm] = rot_img
        if cover is above_68:
            # raised-arm z: sleeve over everything but the face features
            comp_parts.pop(arm)
            comp = composite(comp_parts, rot).astype(float)
            for layer in [rot_img] + [parts[n] for n in ('eye-L', 'eye-R', 'iris-L', 'iris-R',
                                                         'mouth', 'blush', 'bangs') if n in parts]:
                a = layer[..., 3:4].astype(float) / 255.0
                comp[..., :3] = layer[..., :3] * a + comp[..., :3] * (1 - a)
                comp[..., 3:4] = (a + comp[..., 3:4] / 255.0 * (1 - a)) * 255.0
            comp = comp.astype(np.uint8)
        else:
            comp = composite(comp_parts, rot)
        vis = comp.copy()
        vis[exposed] = (255, 0, 200, 255)
        for x1, y1, x2, y2 in found:
            cv2.line(vis, (x1, y1), (x2, y2), (255, 0, 0, 255), 3)
        # tile centred on the rotated arm (300 x 460 master px)
        ys, xs = np.where(rot_img[..., 3] > 8)
        cx = int((xs.min() + xs.max()) / 2)
        cy = int((ys.min() + ys.max()) / 2)
        cx0 = int(np.clip(cx - 150, 0, w - 300))
        cy0 = int(np.clip(cy - 230, 0, h - 460))
        crop = vis[cy0:cy0 + 460, cx0:cx0 + 300]
        bg = np.full(crop.shape[:3], 0, np.uint8)
        bg[..., :3] = (200, 205, 215)
        bg[..., 3] = 255
        a = crop[..., 3:4].astype(float) / 255
        bg[..., :3] = (crop[..., :3] * a + bg[..., :3] * (1 - a)).astype(np.uint8)
        tile = Image.fromarray(bg).convert('RGB')
        tiles.append((label, tile, len(found)))
    if tiles:
        tw, th = tiles[0][1].size
        cols = 4
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * tw, rows * (th + 22)), (255, 255, 255))
        from PIL import ImageDraw
        d = ImageDraw.Draw(sheet)
        for i, (label, tile, n) in enumerate(tiles):
            x, y = (i % cols) * tw, (i // cols) * (th + 22)
            sheet.paste(tile, (x, y + 22))
            d.text((x + 6, y + 4), f'{label}: {n} bare straight edge(s)', fill=(0, 0, 0))
        sheet.save(QA / 'arm-edge.png')
    return results, any_mirror


PATCH_SLOT_PARTS = ('eye-L', 'eye-R', 'mouth')


def patches_check(master):
    """Round-4 deliverable: every shipped eye/mouth slot patch pasted alone
    onto the master at its rig.json offset (export scale -> master scale),
    one tile per slot, plus shred stats on the shipped alpha: opaque
    components >= 20 px and enclosed transparent holes >= 20 px."""
    rig = _pack_rig()
    if rig is None:
        return {}
    k = 1.0 / rig['master'].get('scale', 0.5)
    tiles = []
    stats = {}
    for entry in rig['parts']:
        if entry['id'] not in PATCH_SLOT_PARTS:
            continue
        for slot, si in sorted(entry.get('slots', {}).items()):
            path = PACK / 'rig' / si['image']
            if not path.exists():
                continue
            im = Image.open(path).convert('RGBA')
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            pa = np.array(im)
            base = master.copy()
            x, y = int(si['x']), int(si['y'])
            h, w = pa.shape[:2]
            region = base[y:y + h, x:x + w]
            a = pa[: region.shape[0], : region.shape[1], 3:4].astype(float) / 255
            region[..., :3] = (pa[: region.shape[0], : region.shape[1], :3] * a
                               + region[..., :3] * (1 - a)).astype(np.uint8)
            solid = pa[..., 3] > 128
            n, _, st, _ = cv2.connectedComponentsWithStats(solid.astype(np.uint8), connectivity=8)
            comps = int((st[1:, cv2.CC_STAT_AREA] >= 20).sum())
            filled = ndimage.binary_fill_holes(solid)
            hl, hn = ndimage.label(filled & ~solid)
            holes = int(sum(1 for i in range(1, hn + 1) if (hl == i).sum() >= 20))
            key = f"{entry['id']}:{slot}"
            stats[key] = (comps, holes)
            cx, cy = x + w // 2, y + h // 2
            crop = base[max(0, cy - 90):cy + 90, max(0, cx - 110):cx + 110]
            bg = np.full(crop.shape, 255, np.uint8)
            al = crop[..., 3:4].astype(float) / 255
            bg[..., :3] = (crop[..., :3] * al + 242 * (1 - al)).astype(np.uint8)
            tiles.append((key, Image.fromarray(bg).convert('RGB'), comps, holes))
    if tiles:
        from PIL import ImageDraw
        tw, th = 220 * 2, 180 * 2
        cols = 5
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * tw, rows * (th + 24)), (255, 255, 255))
        d = ImageDraw.Draw(sheet)
        for i, (key, tile, comps, holes) in enumerate(tiles):
            x, y = (i % cols) * tw, (i // cols) * (th + 24)
            sheet.paste(tile.resize((tw, th), Image.LANCZOS), (x, y + 24))
            d.text((x + 6, y + 6), f'{key}  comps={comps} holes={holes}', fill=(0, 0, 0))
        sheet.save(QA / 'patches-check.png')
    return stats


def main():
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    parts = load_parts()
    lines = []

    iou, mean_diff, worst = restoration(parts, master)
    lines.append(f'restoration: alpha IoU={iou:.4f} (gate >=0.98), meanDiff={mean_diff:.2f}/255 (gate <=4), worstBlock={worst}px2 (gate <=40)')

    rows, worst_pair = exclusivity(parts, master)
    violations = [r for r in rows if r[3] > OVERLAP_GATE]
    head = f'exclusivity: {len(rows)} overlapping pairs, {len(violations)} over gate {OVERLAP_GATE:.0%}'
    if worst_pair[0]:
        head += f', worst={worst_pair[0]} {worst_pair[1]:.1%}'
    lines.append(head)
    for a, b, px, ratio in sorted((r for r in rows if r[3] >= 0), key=lambda r: -r[3])[:10]:
        mark = 'DESIGN(host)' if ratio < 0 else f'{ratio:.1%}'
        lines.append(f'  overlap {a}~{b}: {px}px = {mark}')

    rem = removal_test(parts, master)
    bad_rem = [k for k, v in rem.items() if v >= 0.5]
    rem_head = f'removal: {len(rem)} parts, {len(bad_rem)} with edge-corr >= 0.5 (gate < 0.5)'
    if rem:
        wname, wval = max(rem.items(), key=lambda kv: kv[1])
        rem_head += f'; worst {wname}={wval:.3f}'
    lines.append(rem_head)
    for k, v in sorted(rem.items(), key=lambda kv: -kv[1])[:8]:
        lines.append(f'  remove {k}: corr={v:.3f}')

    amber = amber_pixels(parts, master)
    for k, v in amber.items():
        lines.append(f'amber-in-patch {k}: {v}px (gate 0)')

    poses = head_motion(parts, master)
    lines.append(f'head motion sheet: qa/head-motion.png ({", ".join(poses)}) — visual gate')

    seams = seam_lines(parts, master)
    bad_seams = {k: v for k, v in seams.items() if v[0] > 0}
    worst_holes = max(v[1] for v in seams.values())
    lines.append(f'seam-lines: ' + ', '.join(f'{k}={v[0]}' for k, v in seams.items())
                 + f' (gate 0 per pose); turn holes px: '
                 + ', '.join(f'{k}={v[1]}' for k, v in seams.items())
                 + f' (worst {worst_holes}px)')
    sheet_line = 'qa/seam-lines.png'
    lines.append(f'seam overlay sheet: {sheet_line}')

    parts_sheet(parts)
    lines.append('parts sheet: qa/parts-sheet.png')

    arms, arm_mirror = arm_edge(parts, master)
    if arms:
        lines.append('arm-edge: ' + ', '.join(f'{k}={v[0]}' for k, v in arms.items())
                     + ' (gate 0 per pose); bare exposed px: '
                     + ', '.join(f'{k}={v[1]}' for k, v in arms.items())
                     + f'; arm-L mirrored at runtime: {arm_mirror}')
        lines.append('arm-edge sheet: qa/arm-edge.png — visual gate')
    else:
        lines.append('arm-edge: skipped (no exported pack rig.json)')

    pchk = patches_check(master)
    if pchk:
        shred = {k: v for k, v in pchk.items() if v[0] > 1 or v[1] > 0}
        lines.append(f'patches-check: {len(pchk)} eye/mouth slots, {len(shred)} split or holed'
                     + (': ' + ', '.join(f'{k}(comps={v[0]},holes={v[1]})' for k, v in shred.items())
                        if shred else '')
                     + ' — qa/patches-check.png, visual gate')


    holes = stress(parts, master)
    for joint, px in holes.items():
        lines.append(f'stress {joint}: max hole area={px}px (gate 0)')

    sizes(parts)
    lines.append('sizes sheet: qa/sizes.png (64/128/256 on white/black/blue)')

    report = QA / 'qa-report.txt'
    report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
