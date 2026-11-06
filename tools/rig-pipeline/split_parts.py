#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Round-2 re-segmentation (rework P0-1): every part owns only its own pixels.

Why: round 1 assigned leftover silhouette pixels to the nearest part (to pass
the restoration gate) and extend_parts copied master pixels into extension
bands — together, lower layers kept a full hidden copy of the head (torso
held 256k px including the whole face; arm-L had 7k px). Colour-connected
components alone cannot separate white-on-white regions (hood/hair merge,
sleeve/body merge), so this script uses hand-read polygons from qa/grid.png
as spatial partition plus colour constraints, keeps the round-1 masks for
the small well-isolated parts, assigns every pixel to exactly ONE part
(upper z first), and completes occluded regions with flat lining / skin /
inpaint / the registered arms-behind variant (task book A4 + A5).

Extension bands paint the part's own body colour (never the master's
pixels). Output overwrites parts-ext/; round 1 is kept at parts-ext-round1/.
"""
import os
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
SRC = ART / 'parts-full'
DST = ART / 'parts-ext'
BEHIND = ART / 'registered/v-arms-behind-3.png'

KEEP = [
    'tail', 'leg-L', 'leg-R', 'shorts', 'string-L', 'string-R', 'horn-L',
    'horn-R', 'ear-L', 'ear-R', 'third-eye', 'bangs', 'eye-L', 'eye-R',
    'iris-L', 'iris-R', 'mouth', 'blush',
]
# Exclusive assignment order: highest z claims first (iris before eye!).
Z_DESC = [
    'bangs', 'iris-L', 'iris-R', 'eye-L', 'eye-R', 'mouth', 'blush',
    'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R', 'face', 'hood',
    'string-L', 'string-R', 'arm-L', 'arm-R', 'torso', 'shorts', 'leg-L',
    'leg-R', 'tail',
]

# Polygons read off qa/grid.png (master px, 854x1188). Coordinates clockwise.
FACE_OPEN = [  # hood inner rim: face + surrounding hair live inside
    (295, 240), (272, 320), (270, 390), (295, 455), (330, 488), (400, 500),
    (470, 500), (545, 483), (580, 450), (600, 385), (598, 315), (575, 250),
]
ARM_L = [  # left sleeve: shoulder top -> outer edge -> cuff -> inner seam
    (285, 512), (225, 540), (195, 620), (205, 700), (230, 752), (330, 756),
    (348, 740), (352, 650), (345, 560), (300, 528),
]
ARM_R = [  # right sleeve, mirrored about the body axis (~x 435)
    (585, 512), (645, 540), (675, 620), (665, 700), (640, 752), (540, 756),
    (522, 740), (518, 650), (525, 560), (570, 528),
]
TORSO = [  # hoodie body between the sleeve seams, collar to hem
    (300, 505), (570, 505), (588, 560), (588, 700), (570, 762), (300, 762),
    (283, 700), (283, 560),
]
HEAD_ZONE_Y = 548      # everything above belongs to head parts
COLLAR_BAND = (283, 462, 588, 580)   # torso collar fill zone (hood swing + feather)
# Slot patch rectangles (extract_patches boxes + 12 px margin, master px).
# The face carries flat skin under them so a sliding patch never exposes
# lining or holes (round-3 seam fix).
PATCH_RECTS = {
    'eye-L': (308, 338, 432, 437),
    'eye-R': (428, 338, 552, 437),
    'mouth': (388, 428, 470, 482),
}
# Worst-case relative drift (master px) between two layers at |param| = 1,
# from the solver parallax factors (hood -0.35, face 0.4, eyes/bangs 1.0,
# third-eye 0.6) with kx = 368*0.06, ky = 300*0.04.
DRIFT_BANGS_FACE = 0.6 * 368 * 0.06     # ~13.2
DRIFT_BANGS_HOOD = 1.35 * 368 * 0.06    # ~29.8
DRIFT_THIRDEYE_HOOD = 0.95 * 368 * 0.06  # ~21.0


def poly_mask(shape, pts):
    m = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m.astype(bool)


def load_rgba(p):
    return np.array(Image.open(p).convert('RGBA'))


def main():
    master = load_rgba(ART / 'master.png')
    H, W = master.shape[:2]
    alpha = master[..., 3] > 128
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    L = lab[..., 0].astype(int)
    A = lab[..., 1].astype(int)
    B = lab[..., 2].astype(int)

    amber = (A > 128) & (B > 140) & (L > 60) & (L < 220) & alpha
    skin = (B >= 133) & (L >= 185) & alpha
    dark = (L < 80) & alpha
    white = alpha & ~amber & ~skin & ~dark

    kept = {pid: load_rgba(SRC / f'{pid}.png')[..., 3] > 8 for pid in KEEP}
    taken = np.zeros((H, W), bool)
    for m in kept.values():
        taken |= m

    head_zone = np.zeros((H, W), bool)
    head_zone[:HEAD_ZONE_Y] = True

    face_open = poly_mask((H, W), FACE_OPEN)
    arm_l_zone = poly_mask((H, W), ARM_L)
    arm_r_zone = poly_mask((H, W), ARM_R)
    torso_zone = poly_mask((H, W), TORSO)
    ink = white | dark  # colour patches any part may claim

    # The hood's own rim stroke crosses the face-opening polygon boundary.
    # Leftover assignment used to split it between hood (outside) and
    # whatever was nearest (inside) — during a head turn the two halves
    # drift apart (0.75*kx ≈ 16 px) and the stroke tears. Claim the inner
    # half for the hood so the whole stroke rides one layer. Lining (L≈73)
    # stays excluded; this is the dark outline ink only (L<60).
    near_rim = cv2.dilate((~face_open).astype(np.uint8),
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (51, 51))).astype(bool)
    rim_sel = (L < 60) & face_open & near_rim & alpha

    # The zipper pull + tape ride the TORSO (they are jacket hardware). The
    # round-2 split cut them at the head-zone boundary y=548, so the pull's
    # top half rode the hood and tore away from the tape on every head turn
    # (amber line fragments at the chest).
    zipper_sel = np.zeros((H, W), bool)
    zipper_sel[513:712, 410:465] = True
    zipper_sel &= (amber | (L < 60)) & alpha

    # reference colours
    head_ink = head_zone & alpha & ~taken
    lining_sel = amber & head_ink
    lining_rgb = np.median(master[..., :3][lining_sel], axis=0) if lining_sel.any() else np.array([219, 149, 71])
    fskin = skin & face_open & ~taken
    skin_rgb = np.median(master[..., :3][fskin], axis=0) if fskin.any() else np.array([248, 229, 215])
    print(f'lining {lining_rgb.astype(int)}  skin {skin_rgb.astype(int)}')

    # face: skin inside the opening + hair (white inside the opening) + the
    # slot regions get a flat skin fill so the face owns what sits above it
    slot_region = np.zeros((H, W), bool)
    # blush stays OUT: the face keeps the master's blush pixels there and the
    # translucent blush part overlays the same colour (a flat skin fill here
    # would show through the translucent blush and fail restoration)
    for pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
        slot_region |= kept[pid]
    # no dilation: the face fill must not bleed over the eye-white rim —
    # that rim belongs to the eye part's outline, and a skin-coloured ring
    # painted over it fails restoration
    slot_zone = slot_region
    masks = {}
    masks['face'] = ((fskin | (white & face_open & ~taken) | (slot_zone & face_open))
                     & alpha & ~rim_sel)

    # torso: body polygon ink + the zipper pull, minus sleeves
    masks['torso'] = (torso_zone & alpha & (ink | amber) & ~taken
                      & ~arm_l_zone & ~arm_r_zone) | (zipper_sel & ~taken)
    # hood: never claims zipper hardware
    masks['hood'] = ((head_zone & alpha & (ink | amber) & ~face_open)
                     | (rim_sel & ~taken)) & ~zipper_sel

    # arms: sleeve polygon ink
    masks['arm-L'] = arm_l_zone & alpha & ink & ~taken
    masks['arm-R'] = arm_r_zone & alpha & ink & ~taken

    # --- exclusive assignment, upper z first --------------------------------
    claim = {k: v.copy() for k, v in masks.items()}
    claim.update({k: v.copy() for k, v in kept.items()})
    # The hood's rim stroke crosses the opening boundary through several
    # claims (mouth/bangs SAM masks overlap it); every part but the hood
    # releases those pixels so the stroke rides ONE layer and never tears.
    for pid in claim:
        if pid != 'hood':
            claim[pid] &= ~rim_sel
    acc = np.zeros((H, W), bool)
    for pid in Z_DESC:
        if pid not in claim:
            continue
        claim[pid] &= ~acc
        acc |= claim[pid]
    leftover = alpha & ~acc
    if leftover.any():
        # upper layers win leftovers (small index = high z = small handicap)
        names = [p for p in Z_DESC if p in claim]
        best = np.full((H, W), np.inf)
        owner = np.zeros((H, W), np.int32)
        for idx, pid in enumerate(names):
            dist = cv2.distanceTransform((claim[pid] == 0).astype(np.uint8), cv2.DIST_L2, 3)
            dist = dist + idx * 0.9
            closer = dist < best
            best[closer] = dist[closer]
            owner[closer] = idx
        for idx, pid in enumerate(names):
            claim[pid] |= leftover & (owner == idx)
        print(f'leftover claimed: {int(leftover.sum())} px')

    # --- paint ---------------------------------------------------------------
    images = {}
    provenance = np.zeros((H, W), np.uint8)  # 0 claim 1 ext 2 lining 3 collar 4 backfill
    for pid in Z_DESC:
        img = np.zeros_like(master)
        m = claim[pid].copy()
        # Keep the master's own alpha on claimed pixels: round 2 flattened
        # every part edge to 255, destroying the artwork's anti-aliased
        # edges — invisible at rest, but each moved edge turned into a hard
        # ghost line during head turns.
        if pid == 'face':
            # the face carries flat skin under the eye/mouth slots — never a
            # copy of the slot ink above it (removal gate would catch that)
            m = m & ~slot_zone
            img[..., :3][m] = master[..., :3][m]
            img[..., 3][m] = master[..., 3][m]
            img[..., :3][slot_zone & claim[pid]] = skin_rgb
            img[..., 3][slot_zone & claim[pid]] = 255
            provenance[slot_zone & claim[pid]] = 2
        else:
            img[..., :3][m] = master[..., :3][m]
            img[..., 3][m] = master[..., 3][m]
        images[pid] = img

    def flat(img, m, rgb, tag=1):
        img[..., :3][m] = rgb
        img[..., 3][m] = 255
        provenance[m & (img[..., 3] > 8)] = tag

    def dilate_mask(m, r):
        return cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))).astype(bool)

    def close_to(ref, m, tol=30):
        """Master pixels within tol of ref — underlays may only extend over
        pixels where the flat colour is indistinguishable from the master's
        own (keeps the restoration composite clean at rest)."""
        d = np.sqrt(((master[..., :3].astype(float) - np.array(ref, float)) ** 2).sum(axis=2))
        return m & (d < tol)

    def underlay(img, core, ring, rgb, F, tag=5):
        """Round-3 feathered underlay: flat rgb (or an HxWx3 colour FIELD —
        pass a 3-channel array) on the TRANSPARENT pixels of the target image
        only (real ink stays), soft >=F px edge so an exposed underlay
        boundary is never a hard straight line. The blur tail is clipped to
        the zone: a leak beyond it would sit on pixels nothing covers and
        show as an amber/white bar once the covering part moves away."""
        zone = (core | ring).astype(np.uint8)
        a = cv2.GaussianBlur(zone * 255, (2 * F + 1, 2 * F + 1), 0)
        a = np.maximum(a, core.astype(np.uint8) * 255)
        paint = (a > 0) & (img[..., 3] < 8) & (zone > 0)
        if isinstance(rgb, np.ndarray) and rgb.ndim == 3:
            img[..., :3][paint] = rgb[paint]
        else:
            img[..., :3][paint] = rgb
        img[..., 3][paint] = a[paint]
        provenance[paint] = tag

    def inpaint_band(img, m, radius=5):
        band = (m & alpha).astype(np.uint8) * 255
        src = img.copy()
        src[..., 3][band > 0] = 255
        out = cv2.inpaint(cv2.cvtColor(src, cv2.COLOR_RGBA2BGRA), band, radius, cv2.INPAINT_TELEA)
        ok = m & alpha
        img[..., :3][ok] = cv2.cvtColor(out, cv2.COLOR_BGRA2RGBA)[..., :3][ok]
        img[..., 3][ok] = 255

    # --- round-3 feathered underlays ------------------------------------------
    # Every layer that moves relative to a neighbour gets a soft underlay on
    # the layer beneath, sized to the worst-case relative drift, so a turn
    # exposes soft fills instead of holes and hard straight edges.
    rect_zone = np.zeros((H, W), bool)
    for r in PATCH_RECTS.values():
        rect_zone[r[1]:r[3], r[0]:r[2]] = True
    rect_grow = dilate_mask(rect_zone, 8)
    # claims of parts that render above face/hood and must never be covered
    above_face = np.zeros((H, W), bool)
    above_hood = np.zeros((H, W), bool)
    for pid in ('bangs', 'iris-L', 'iris-R', 'eye-L', 'eye-R', 'mouth',
                'blush', 'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R'):
        if pid in claim:
            above_hood |= claim[pid]
            if pid != 'third-eye' and pid not in ('ear-L', 'ear-R', 'horn-L', 'horn-R'):
                above_face |= claim[pid]

    # hood: amber lining under the WHOLE face stack (face slides 0.75*kx
    # relative to the hood — round 2 lined only part of it, and the polygon
    # boundary showed as a hard edge). Feathered 4 px; painted only on
    # transparent hood pixels so the rim ink stays real. The fill colour is
    # a per-pixel blend amber<->shell-white driven by the master's own
    # lining likelihood: a flat global median against the master's local
    # fade produced tonal steps that read as straight lines when exposed.
    amber_m = (A > 110) & (B > 140) & alpha
    shell_m = close_to((249, 243, 240), alpha, tol=18)
    w_am = cv2.GaussianBlur(amber_m.astype(float), (31, 31), 0)
    w_sh = cv2.GaussianBlur(shell_m.astype(float), (31, 31), 0)
    denom = np.maximum(w_am + w_sh, 1e-6)
    lining_field = (np.clip(w_am / denom, 0, 1)[..., None]
                    * np.array(lining_rgb, float)
                    + (1 - np.clip(w_am / denom, 0, 1))[..., None]
                    * np.array((249, 243, 240), float))
    lining_core = face_open & alpha & ~claim['bangs'] & ~claim['hood']
    lining_core |= face_open & alpha & claim['face'] & ~claim['bangs']
    lining_core |= rect_grow & face_open & alpha & ~claim['bangs']
    lining_core &= ~rim_sel
    lining_ring = (dilate_mask(lining_core, 20) & face_open & alpha
                   & ~claim['bangs'] & ~claim['hood'] & ~rim_sel & ~above_face)
    underlay(images['hood'], lining_core, lining_ring, lining_field, F=4, tag=2)

    # under-fringe fill: the fringe (bangs, factor 1.0) slides 13 px over the
    # face and 30 px over the hood; without a fill its vacated strips are
    # transparent holes. White under the fringe area, feathered 4 px.
    bangs_a = claim['bangs'] & alpha
    # NOTE: rings intentionally do NOT exclude the bangs claim — the fill
    # rides the lower layer (+0.4k / -0.35k), so the claim's own vacated
    # strips (fringe moves 1.0k) must stay covered; the underlay paint rule
    # (transparent target pixels only) keeps real ink safe.
    bface_core = bangs_a & face_open & ~claim['hood']
    # The ring ignores face_open (the hood's own shell strips above the
    # opening vacate when IT moves, and only this ring on the face covers
    # them) but NOT the colour clip: the face renders above the hood, so a
    # white ring over the hood's dark rim ink would be visible at rest.
    bface_ring = (dilate_mask(bface_core, int(DRIFT_BANGS_FACE) + 6) & alpha
                  & close_to((250, 250, 250), alpha, tol=45) & ~above_face)
    underlay(images['face'], bface_core, bface_ring, (250, 250, 250), F=4)
    bhood_core = bangs_a & ~face_open
    bhood_ring = (dilate_mask(bhood_core, int(DRIFT_BANGS_HOOD) + 6) & ~face_open & alpha
                  & ~above_hood)
    underlay(images['hood'], bhood_core, bhood_ring, (250, 250, 250), F=4)
    # fringe root band: the hood carries a copy of the fringe's own pixels
    # along its top edge (the fringe pixels within 14 px of the shell side).
    # At rest it hides under the identical bangs pixels; when the fringe
    # slides with its parallax (up to 0.75*kx over the hood) the hair ROOTS
    # stay tucked under the rim instead of tearing a gap along the hairline.
    root_band = bangs_a & dilate_mask(~face_open, 14) & alpha
    root_band &= ~bhood_core  # shell-side pixels are already the hood's own
    images['hood'][..., :3][root_band] = master[..., :3][root_band]
    images['hood'][..., 3][root_band] = 255
    provenance[root_band] = 1

    # face: flat skin under the eye/mouth slot patches (patches slide 0.6*kx
    # over the face) — existing slot flat plus the patch rectangles grown
    # 8 px, ring only over skin-like master pixels, feathered 4 px.
    flat(images['face'], slot_zone & face_open & ~claim['face'], skin_rgb, tag=2)
    skin_core = rect_grow & face_open & alpha & ~claim['bangs'] & ~claim['hood']
    skin_ring = (dilate_mask(skin_core, 10) & face_open & alpha & ~claim['bangs']
                 & ~claim['hood'] & ~above_face)
    underlay(images['face'], skin_core, skin_ring, skin_rgb, F=4)

    # hood: white socket under the third-eye (factor 0.6 slides ~21 px over
    # the hood) — round 2 left it empty, so the open patch exposed holes.
    shell_rgb = (249, 243, 240)
    te_core = claim['third-eye'] & alpha
    te_ring = (dilate_mask(te_core, int(DRIFT_THIRDEYE_HOOD) + 6) & alpha
               & ~above_hood)
    underlay(images['hood'], te_core, te_ring, shell_rgb, F=4)

    # torso: collar fill under the hood's bottom edge and its travel (turnY
    # parallax + breath lift + tilt swing ~12 px) — round 2 filled a hard
    # rectangle whose bottom edge showed as a straight line when the hood
    # moved. Feathered 4 px, painted under the hood claim too. Colour is
    # the WHITE cloth median: the all-ink median carries outline pixels and
    # reads as a grey line against the shell.
    torso_white = claim['torso'] & white
    torso_rgb = (np.median(master[..., :3][torso_white], axis=0) if torso_white.any()
                 else np.array([250, 250, 250]))
    band = np.zeros((H, W), bool)
    band[COLLAR_BAND[1]:COLLAR_BAND[3], COLLAR_BAND[0]:COLLAR_BAND[2]] = True
    # core = the hood's own bottom footprint dilated over its full ±18° tilt
    # swing (~45 px at the far corners) — the round-2 rectangle covered less
    # than the sweep and a wedge of background showed on every tilt.
    hood_bottom = claim['hood'] & (np.arange(H)[:, None] >= 495)
    sweep = dilate_mask(hood_bottom, 45) & band
    collar_core = (sweep & alpha & ~claim['torso'] & ~claim['arm-L'] & ~claim['arm-R']
                   & ~claim['string-L'] & ~claim['string-R'] & ~claim['face']
                   & ~claim['mouth'] & ~claim['blush'] & ~claim['eye-L'] & ~claim['eye-R'])
    collar_ring = (dilate_mask(collar_core, 8) & band & alpha & ~claim['torso']
                   & ~claim['arm-L'] & ~claim['arm-R'] & ~claim['string-L']
                   & ~claim['string-R'] & ~claim['face'] & ~claim['mouth']
                   & ~claim['blush'] & ~claim['eye-L'] & ~claim['eye-R'])
    underlay(images['torso'], collar_core, collar_ring, torso_rgb, F=4, tag=3)
    # torso: back-fill behind the arms from the arms-behind variant (the
    # variant has no arms, so its pixels there are true torso cloth). The
    # strings exist in the variant too, so under the strings we inpaint
    # instead — copying variant pixels would smuggle a string copy.
    if BEHIND.exists():
        behind = load_rgba(BEHIND)
        if behind.shape[:2] != (H, W):
            behind = cv2.resize(behind, (W, H), interpolation=cv2.INTER_LANCZOS4)
        occ = (claim['arm-L'] | claim['arm-R']) & torso_zone
        fill = occ & (behind[..., 3] > 24) & ~claim['torso']
        images['torso'][fill] = behind[fill]; provenance[fill] = 4
        print(f'torso occlusion back-fill: {int(fill.sum())} px')
        string_fill = (claim['string-L'] | claim['string-R']) & torso_zone & ~claim['torso']

        def inpaint_band(img, m, radius=5):
            band = (m & alpha).astype(np.uint8) * 255
            ok = m & alpha
            # inpaint takes 3-channel BGR: fill the band from surrounding RGB
            src = img[..., :3].copy()
            src[ok] = 0
            out = cv2.inpaint(cv2.cvtColor(src, cv2.COLOR_RGB2BGR), band, radius, cv2.INPAINT_TELEA)
            img[..., :3][ok] = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)[ok]
            img[..., 3][ok] = 255
            provenance[ok] = 4
        inpaint_band(images['torso'], string_fill)
        print(f'torso string inpaint: {int(string_fill.sum())} px')

    # arm: shoulder extension into the body — take the torso part's own
    # pixels there (same cloth colour at rest, plausible when the arm lifts)
    ext_used = np.zeros((H, W), bool)
    for arm, other_arm in (('arm-L', 'arm-R'), ('arm-R', 'arm-L')):
        grow = cv2.dilate(claim[arm].astype(np.uint8), cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (51, 51))).astype(bool)
        ext = grow & torso_zone & alpha & ~claim[arm] & ~claim[other_arm] & ~claim['torso'] & ~claim['hood'] & ~claim['string-L'] & ~claim['string-R']
        take = ext & (images['torso'][..., 3] > 8)
        images[arm][take] = images['torso'][take]
        provenance[take] = 1
        # rest of the band stays empty: the arm renders above the torso, and
        # a flat patch there would be visible at rest over the master's ink
        ext_used |= ext

    # joint extension bands for the kept parts: they may grow ONLY into their
    # host part's territory (A4 "grow under what covers you"), taking the
    # host's pixels there — but never the host's outline ink (no hidden
    # copies), so flat host colour is safer where the host has structure.
    HOSTS = {
        'tail': 'shorts', 'leg-L': 'shorts', 'leg-R': 'shorts',
        'ear-L': 'hood', 'ear-R': 'hood', 'horn-L': 'hood', 'horn-R': 'hood',
        'string-L': 'torso', 'string-R': 'torso', 'third-eye': 'hood',
        'bangs': 'face', 'eye-L': 'face', 'eye-R': 'face', 'mouth': 'face',
    }
    EXT_RADIUS = {
        'tail': 30, 'leg-L': 40, 'leg-R': 40, 'ear-L': 35, 'ear-R': 35,
        'horn-L': 8, 'horn-R': 8, 'string-L': 6, 'string-R': 6,
        'third-eye': 6, 'eye-L': 6, 'eye-R': 6, 'mouth': 6,
    }  # bangs has no joint of its own — it rides the head group
    # flat colours per host territory (host cloth medians)
    shorts_rgb = np.median(master[..., :3][claim['shorts']], axis=0) if claim['shorts'].any() else np.array([60, 60, 65])
    HOST_FLAT = {
        'shorts': tuple(int(c) for c in shorts_rgb),
        'hood': (250, 250, 250),
        'torso': tuple(int(c) for c in torso_rgb),
        'face': tuple(int(c) for c in skin_rgb),
        'bangs': (250, 250, 250),  # hair root white, not skin
    }
    all_others = {p: m for p, m in claim.items()}
    for pid, radius in EXT_RADIUS.items():
        host = HOSTS[pid]
        grow = cv2.dilate(claim[pid].astype(np.uint8), cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))).astype(bool)
        ext = grow & alpha & ~claim[pid] & claim[host] & ~ext_used
        for other, m in all_others.items():
            if other != pid and other != host:
                ext &= ~m
        ext_used |= ext
        if pid in ('leg-L', 'leg-R', 'tail'):
            # growing under a structured host: flat colour only (trouser /
            # tail fur) — copying host pixels would smuggle its outline
            flat(images[pid], ext, HOST_FLAT['shorts'] if pid.startswith('leg') else (255, 255, 255), tag=1)
        elif pid in ('horn-L', 'horn-R'):
            # horns never move, but the HOOD does (turn parallax): the sliver
            # between a horn and the hood outline opens when the hood slides
            # away. The horn (z above hood) carries a copy of the master's
            # own pixels in a 12 px ring around its claim: at rest it hides
            # under the hood's identical pixels; when the hood slides the
            # ring keeps the junction content instead of exposing background.
            # Copying the host's pixels is the A4 "grow under what covers
            # you" pattern; the removal gate is not implicated because the
            # hood still draws the same pixels on top.
            h_core = claim[pid] & alpha
            grow = dilate_mask(h_core, 12) & alpha & ~above_hood & ~claim[pid]
            img = images[pid]
            img[..., :3][grow] = master[..., :3][grow]
            img[..., 3][grow] = np.maximum(master[..., 3][grow], 180)
            provenance[grow] = 1
        else:
            # the part renders ABOVE its host: the extension must be
            # pixel-identical to the host at rest — copy only flat host
            # pixels and leave the outline band empty (the host shows there
            # both at rest and when the joint swings)
            host_img = images[host]
            host_edges = cv2.Canny(cv2.cvtColor(host_img[..., :3], cv2.COLOR_RGB2GRAY), 60, 160)
            host_edges = cv2.dilate(host_edges, np.ones((5, 5), np.uint8)) > 0
            take = ext & (host_img[..., 3] > 8) & ~host_edges
            images[pid][take] = host_img[take]; provenance[take] = 1

    # hood: an "ear socket" of flat hood white under each ear — footprint
    # plus a 60 px swing ring (the ear tip sweeps ~0.34x its radius at ±20°,
    # well past the 14 px the round-2 socket covered), feathered 3 px. The
    # ring also covers the outline's sub-claim anti-aliased fringe (master
    # alpha 8..127): the claim stops at alpha>128, and a swung-away ear
    # exposed those pixels as bright slivers. The paint rule keeps real ink.
    alpha8 = master[..., 3] > 8
    for e in ('ear-L', 'ear-R'):
        e_core = claim[e] & alpha
        e_ring = dilate_mask(e_core, 60) & alpha8 & ~above_hood
        underlay(images['hood'], e_core, e_ring, (250, 250, 250), F=3)

    # --- QA sheet + write -----------------------------------------------------
    rng = np.random.default_rng(11)
    overlay = master[..., :3].copy()
    for pid in Z_DESC:
        m = claim[pid]
        color = rng.integers(70, 255, 3)
        for c in range(3):
            overlay[..., c][m] = (0.45 * overlay[..., c][m] + 0.55 * color[c]).astype(np.uint8)
    Image.fromarray(overlay).save(ART / 'qa' / 'segmentation-round2.png')

    Image.fromarray((provenance * 60).astype(np.uint8)).save(ART / 'qa' / 'provenance.png')
    DST_NEW = ART / 'parts-ext-new'
    if DST_NEW.exists():
        shutil.rmtree(DST_NEW)
    DST_NEW.mkdir(parents=True)
    for pid in Z_DESC:
        Image.fromarray(images[pid]).save(DST_NEW / f'{pid}.png', optimize=True)
        print(f'{pid}: {int(claim[pid].sum())} px own')

    if DST.exists():
        old = ART / 'parts-ext-round1'
        if old.exists():
            shutil.rmtree(old)
        shutil.move(str(DST), str(old))
    shutil.move(str(DST_NEW), str(DST))
    print('parts-ext replaced (round-1 kept at parts-ext-round1)')


if __name__ == '__main__':
    main()
