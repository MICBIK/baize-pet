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
import json
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
# Sleeve polygons. Below the armpit the inner edge follows the torso side of
# the master's own sleeve seam ink (read per 5 px row from master.png), so the
# sleeve keeps its closed outline and carries no torso cloth: round 3 cut it
# with a straight vertical line ~15 px inside the torso, and that outline-less
# strip (with a pocket fragment) swung out as a white "blade" whenever the
# arm rotated. Above the armpit the sleeve has no seam (raglan shoulder); the
# cut there stays inside the torso / under the hood.
ARM_L = [  # left sleeve: shoulder top -> outer edge -> cuff -> inner seam
    (285, 512), (225, 540), (195, 620), (205, 700), (230, 752), (313, 756),
    (315, 750), (321, 740), (336, 734), (335, 720), (339, 710), (341, 690),
    (346, 670), (349, 650), (353, 630), (357, 610), (359, 590), (360, 580),
    (350, 560), (300, 528),
]
ARM_R = [  # right sleeve: same reading of the right seam
    (585, 512), (645, 540), (675, 620), (665, 700), (640, 752), (546, 756),
    (545, 745), (543, 735), (541, 725), (538, 710), (537, 700), (535, 690),
    (532, 680), (530, 670), (528, 660), (526, 650), (524, 640), (522, 630),
    (521, 620), (519, 610), (518, 600), (516, 585), (525, 560), (570, 528),
]
# Armpit rows: below these the sleeve seam is the arm's own outline, so the
# shoulder extension (torso cloth riding the arm) stops here.
ARMPIT_Y = {'arm-L': 580, 'arm-R': 585}
CUFF_BOTTOM_Y = 752  # hands hang below this row
TORSO = [  # hoodie body between the sleeve seams, collar to hem
    (300, 505), (570, 505), (588, 560), (588, 700), (570, 762), (300, 762),
    (283, 700), (283, 560),
]
# Body side line under the viewer-left sleeve: the side-seam ink of the
# arms-behind variant (median dark pixel per row, master px), shoulder to
# hem. The torso back-fill stops here (round 5). The viewer-right sleeve
# needs no cut: its variant seam runs along the sleeve's own inner seam, so
# a cut there opened a background slit whenever the arm swung out (talk).
BODY_SIDE = {
    'L': [(334, 548), (331, 570), (326, 590), (322, 610), (316, 630), (307, 655),
          (302, 675), (297, 690), (296, 710), (294, 730), (294, 770)],
}
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
    # round 6: the claim includes the rim ink's own anti-aliased fringe —
    # only within 2 px of the rim core (L < 60). A wide L<110 band over the
    # 25 px near_rim zone also swallowed dark hair strands and crease
    # shadows well inside the opening, which every part then released and
    # nobody claimed (zero-alpha pockets that bled background on swings).
    rim_core = (L < 60) & face_open & near_rim & alpha
    rim_sel = (rim_core
               | ((L < 110) & face_open & alpha
                  & cv2.dilate(rim_core.astype(np.uint8),
                               np.ones((5, 5), np.uint8)).astype(bool)))

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

    # round 6: the master's anti-aliased fringe (alpha 8..128) belongs to
    # nobody — every claim cuts at alpha>128, so the AA ring between two
    # parts stays unowned. When the parts move apart the ring detaches from
    # the outline and the half-scale resample renders it as faint grey dots
    # (round-6 seam probe, turnY). Assign each fringe pixel to its nearest
    # claim (upper layers win ties) and carry the master's own RGBA there.
    fringe = (master[..., 3] > 8) & ~alpha & ~acc
    if fringe.any():
        names = [p for p in Z_DESC if p in claim]
        best = np.full((H, W), np.inf)
        fringe_owner = np.zeros((H, W), np.int32)
        for idx, pid in enumerate(names):
            dist = cv2.distanceTransform((claim[pid] == 0).astype(np.uint8),
                                         cv2.DIST_L2, 3) + idx * 0.9
            closer = dist < best
            best[closer] = dist[closer]
            fringe_owner[closer] = idx
        for idx, pid in enumerate(names):
            take = fringe & (fringe_owner == idx)
            if not take.any():
                continue
            claim[pid] |= take
            images[pid][take] = master[take]
        print(f'AA fringe assigned: {int(fringe.sum())} px')

    # --- round-6 rule-B rebuilds ---------------------------------------------
    # Every hidden region must carry what should be there when the covering
    # layer moves away, sampled from the master — no flat fills, no ghost
    # copies (round-6 diagnosis 01/04).
    #
    # claims of parts that render above face/hood (third-eye and the outer
    # joints excluded from above_face: their fills ride the hood/face below)
    above_face = np.zeros((H, W), bool)
    above_hood = np.zeros((H, W), bool)
    for pid in ('bangs', 'iris-L', 'iris-R', 'eye-L', 'eye-R', 'mouth',
                'blush', 'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R'):
        if pid in claim:
            above_hood |= claim[pid]
            if pid != 'third-eye' and pid not in ('ear-L', 'ear-R', 'horn-L', 'horn-R'):
                above_face |= claim[pid]
    #
    # R6-1 hood: rebuild the lining inside the opening. Seeds = the master's
    # genuinely visible lining pixels (strict amber selector: skin stays
    # out); everything else inside the opening is inpainted from them
    # (TELEA r15) and blurred once (sigma 6, inpainted pixels only); alpha
    # 255 throughout — no transparent holes. The rim ink stays untouched.
    # Every pixel that is visible at rest keeps the master's own RGB
    # (principle A): visible-at-rest = not covered by the head stack's
    # opaque alpha — plus the master-lining pixels the leftover pass handed
    # to the face (their face copies are cleared below instead), except
    # under the feature patches where master amber is iris/lash content.
    head_fill = np.zeros((H, W), bool)
    for pid in ('face', 'bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R',
                'mouth', 'blush', 'third-eye'):
        if pid in claim:
            head_fill |= claim[pid]
    feature_claims = np.zeros((H, W), bool)
    for pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'third-eye'):
        if pid in claim:
            feature_claims |= claim[pid]
    amber_strict = (A > 135) & (B > 170) & alpha
    # R7-2.3: HOOD_OPENING is generated by ink-line hole filling ONLY — the
    # barrier is the rim ink (closed to bridge hairline gaps; the head-stack
    # claims bridge the wide top gap where the fringe crosses the rim) plus
    # the hood's own claim. No rectangle, polygon or bbox takes part, so the
    # round-6 rectangular liner bumps at the opening's two top corners (D1)
    # fall OUTSIDE the mask and keep the master's own shell pixels.
    rim_closed = cv2.morphologyEx(rim_core.astype(np.uint8), cv2.MORPH_CLOSE,
                                  np.ones((7, 7), np.uint8)).astype(bool)
    # the barrier is the rim ink + the head stack ONLY — the hood's own
    # claim must NOT join it, or fill_holes swallows the whole dome and the
    # "opening" balloons to every hood pixel (R7-2.3: the boundary is the
    # rim ink's inner edge, nothing else)
    opening_full = ndimage.binary_fill_holes(rim_closed | head_fill)
    # include the master's SEMI-alpha pixels (8..128): split_parts claims
    # alpha>128 only, so the rim's anti-aliased fringe belonged to nobody,
    # left a ring of zero alpha inside the opening and bled background
    # whenever the warped silhouette sampled it. The mask is the FULL
    # interior bounded by the rim ink's inner edge (the visible lining ring
    # around the face included) — qa_pack's P2/P6 audit this region.
    hood_opening = (opening_full & ~rim_sel & (master[..., 3] > 8))
    # the fill barrier bridges the rim gaps with the head-stack claims, so
    # above the top rim arc the opening overshoots into shell white (the
    # fill leaks through the ear-root gaps). Shell-white pixels inside the
    # overshoot die here: the interior is lining/face-stack only, and the
    # rim's own ink separates the two — no straight-corner bands survive
    # (R7-2.3: a smooth ink-bounded curve, checked visually below).
    lab_all = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    shell_sel = ((lab_all[..., 0] > 217)
                 & (np.sqrt((lab_all[..., 1] - 128) ** 2
                            + (lab_all[..., 2] - 128) ** 2) < 12) & alpha)
    # (head_fill was built above for the fill barrier; face-stack claims
    # keep their own white hair inside the opening. NO shell rejection here:
    # the master's hood interior above the head IS shell-white fabric, and
    # cutting it out of the opening starves the TELEA rebuild of its top
    # seeds — the round-6 D1 amber bands came from exactly that starvation.)
    # keep only the components that hold the master's own visible lining
    # beside the face claim — the dome pocket enclosed between the fringe
    # wisp and the third-eye almond is shell, not lining (R7-2.3: the
    # boundary stays ink-generated; this only rejects disconnected pockets)
    lbl_o, n_o = ndimage.label(hood_opening)
    if n_o > 1:
        ring_seed = (amber_strict & ~feature_claims
                     & cv2.dilate(claim['face'].astype(np.uint8),
                                  np.ones((7, 7), np.uint8)).astype(bool))
        keep_lbl = np.unique(lbl_o[ring_seed & hood_opening])
        keep_lbl = keep_lbl[keep_lbl > 0]
        hood_opening = np.isin(lbl_o, keep_lbl) if len(keep_lbl) else np.zeros_like(hood_opening)
    Image.fromarray((hood_opening * 255).astype(np.uint8)).save(
        ART / 'qa' / 'hood-opening.png')
    cover_up = np.zeros((H, W), bool)
    # blush is NOT a rest-pose renderer (opacityParam 'blush' defaults 0) —
    # its loose SAM claim also steals the side-hair strands beside both
    # cheeks, so counting it here would rebuild those strands as lining
    for pid in ('face', 'bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R',
                'mouth', 'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R'):
        if pid in claim:
            cover_up |= claim[pid] & (master[..., 3] > 128)
    # the rebuild covers the WHOLE interior including the face-stack claim
    # footprints (they hide the lining at rest; when the face slides away —
    # turnX/Y parallax — the lining must be there or the composite shows
    # see-through holes inside the opening, qa turn holes 3086 px without it)
    opening_fill = hood_opening.copy()
    # every VISIBLE pixel inside the opening keeps the master's own RGBA —
    # the interior carries the lining ring AND the shell-white/crease
    # gradient of the hood's inner face above the head (the master paints
    # white fabric up there, not amber — a lining-only seed set TELEA-filled
    # the top amber, the round-6 D1 bands). Hidden pixels (under the face
    # stack) are TELEA-filled from the spatially nearest visible material:
    # the top fills shell white, the sides fill lining, and a head turn
    # never exposes amber over shell nor shell over lining.
    keep = opening_fill & ~cover_up
    seed_sel = keep
    need = opening_fill & cover_up
    hood_bgr = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2BGR)
    # hidden pixels copy their NEAREST VISIBLE hood-layer pixel that is not
    # outline ink (the hood claim already carries the master's own shell,
    # crease and lining pixels everywhere it is visible; ink pixels must not
    # seed or the fill turns black). Seeds are NOT limited to the opening:
    # the top band's shell white lies outside the fill barrier's reach, and
    # the hidden pixels under the face stack need it as their material.
    hood_seed = (((images['hood'][..., 3] > 8) | opening_fill)
                 & (master[..., 3] > 8) & (L > 100) & ~cover_up)
    dist_o, (iy_o, ix_o) = ndimage.distance_transform_edt(
        ~hood_seed, return_indices=True)
    # hidden pixels whose MASTER pixel is bright fabric/skin copy the
    # master itself (the hood interior's own white above the head, and the
    # face-stack's skin — both legitimate rule-B content when the stack
    # slides); everything else copies its nearest non-ink visible pixel.
    # White HAIR claims (the face/bangs claims' white selector) do NOT count
    # as bright master: their rule-B content is the LINING the hair hides
    # (the round-6 D1 side-hair copy), so they take the nearest lining.
    white_master = alpha & ~amber & ~skin & ~dark
    hair_white_claims = np.zeros((H, W), bool)
    for pid in ('face', 'bangs'):
        if pid in claim:
            hair_white_claims |= claim[pid] & white_master
    chroma_m = np.sqrt(((A - 128) ** 2 + (B - 128) ** 2))
    # the interior-white band of the hood sits ABOVE the face opening's rim
    # (master rows < 262 here); below it, white face-claim pixels hide
    # LINING (the side-hair copy of round-6 D1) — so only the top band
    # copies its own white and the sides take the nearest lining.
    bright_m = ((L > 180) & (chroma_m < 16) & alpha
                & ~(hair_white_claims & (np.arange(H)[:, None] >= 262)))
    take_self = need & bright_m
    take_near = need & ~bright_m
    images['hood'][..., :3][take_self] = master[..., :3][take_self]
    images['hood'][..., :3][take_near] = master[..., :3][iy_o[take_near], ix_o[take_near]]
    if os.environ.get('BAIZE_TRACE'):
        for _yy, _xx in ((243, 300), (286, 435)):
            print(f'[trace] after rebuild: ({_xx},{_yy}) '
                  f'back={images["hood"][_yy, _xx].tolist()} '
                  f'dist={float(dist_o[_yy, _xx]):.1f} '
                  f'seed={master[iy_o[_yy, _xx], ix_o[_yy, _xx]].tolist()}')
    # keep pixels the hood does not own yet: copy the master (they become
    # visible the moment the face's lining chips below are cleared)
    own_missing = keep & (images['hood'][..., 3] < 8)
    images['hood'][..., :3][own_missing] = master[..., :3][own_missing]
    images['hood'][..., 3][opening_fill] = 255
    provenance[opening_fill] = 2
    # forbidden content check (rule: no white / skin / hair in the rebuild)
    # R7-2: the round-6 hood "edge skirt" (master pixels dilated 24 px into
    # every cover_up area) is DELETED — cover_up includes the ear/horn/
    # third-eye claims, so the skirt copied whole ears, horns and the third
    # eye back into the hood (round-7 D4: hood ∩ ear claim = 100%). The
    # swing-gap coverage it provided is now the socket underlays plus the
    # dome-completion white/arc of R7-2. The torso skirt below is kept.
    torso_a = images['torso'][..., 3]
    torso_solid = torso_a >= 250
    skirt_t = (cv2.dilate(torso_solid.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
               & ~torso_solid & (claim['hood'] & (master[..., 3] > 128)))
    if skirt_t.any():
        _d2, (iy2, ix2) = ndimage.distance_transform_edt(~torso_solid, return_indices=True)
        images['torso'][..., :3][skirt_t] = images['torso'][..., :3][iy2[skirt_t], ix2[skirt_t]]
        images['torso'][..., 3][skirt_t] = 255
    print(f'edge skirt: torso {int(skirt_t.sum())} px (hood skirt retired in R7-2)')

    # R7-1: the round-6 "shell band" master-pixel copy is retired with the
    # polygon that defined it — the band above the true rim is plain hood
    # shell, owned by the visible-at-rest FRONT layer after the split below
    # (R7-2 constraint: master-pixel continuation bands may only write the
    # front layer or the hood's own master region, never ear/horn coverage).
    # R7-2 note: the rebuild is no longer lining-only (the master's own
    # hood-interior white above the head is legitimate content), so the
    # round-6 "forbidden white" counter no longer applies here.
    print(f'hood interior rebuild: opening {int(hood_opening.sum())} px, '
          f'rebuilt {int(need.sum())} px (TELEA from visible master pixels)')

    # fringe root band: round 3 copied fringe pixels onto the hood along the
    # hairline so sliding fringe would not tear a gap there. Round 6 drops
    # it: those hair pixels sit INSIDE the opening, where rule B demands
    # lining only, and the P2 exposure gate flagged them as white streaks in
    # the lining. The fringe's travel is covered by the face's inpainted
    # fill (inside the opening) and the bhood shell underlay (outside it).
    bangs_a = claim['bangs'] & alpha
    bhood_core = bangs_a & ~face_open
    bhood_ring = (dilate_mask(bhood_core, int(DRIFT_BANGS_HOOD) + 6)
                  & ~face_open & alpha & ~above_hood)
    underlay(images['hood'], bhood_core, bhood_ring, (250, 250, 250), F=4)

    # R6-1 face: fills under the fringe / eye / mouth patches. The round-3
    # flat fills (skin_rgb, 250-white) failed the round-6 exposure gate
    # (dE <= 10 vs the master's local material): vacated strips showed flat
    # white over shaded hair strands and flat skin over eyelid shading.
    # Rebuild: inpaint the hidden areas from the master's own skin / hair
    # pixels, light blur on the filled pixels only. The zone is clipped to
    # the face's own material reach (never over the rim ink or the lining)
    # and to pixels hidden at rest (under the patches' footprints).
    face_sil = fskin.copy()  # master skin inside the hood opening
    face_sil |= white & face_open  # the side hair inside the opening too
    for pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
        if pid in claim:
            face_sil |= claim[pid]
    # close small gaps (eye-white rims, lashes) without filling the hair
    face_sil = ndimage.binary_closing(face_sil, structure=np.ones((7, 7), bool))
    face_reach = dilate_mask(face_sil, 6)
    fill_zone = ((slot_zone | (bangs_a & face_open)) & face_reach & alpha
                 & ~claim['hood'] & ~rim_sel)
    face_seeds = ((skin | (white & face_open)) & alpha & ~fill_zone
                  & ~claim['hood'] & ~rim_sel)
    ffill = cv2.inpaint(hood_bgr, (~face_seeds).astype(np.uint8) * 255, 8,
                        cv2.INPAINT_TELEA)
    ffill = cv2.cvtColor(ffill, cv2.COLOR_BGR2RGB).astype(np.float32)
    ffill = cv2.GaussianBlur(ffill, (0, 0), 3)
    fimg = images['face']
    # R6-3: the fringe's semi-alpha strand edges blend with whatever lies
    # beneath — an inpainted approximation there shows as a bright line at
    # half scale. Pixels covered only PARTIALLY by the fringe keep the
    # master's own RGBA (the blend then equals master exactly); the inpaint
    # fill runs only where the fringe covers fully.
    b_a = images['bangs'][..., 3]
    full_cover = b_a >= 200
    fpaint = (fill_zone & ((fimg[..., 3] < 8) | (provenance == 2))
              & (full_cover | slot_zone))
    fimg[..., :3][fpaint] = ffill[fpaint].astype(np.uint8)
    fimg[..., 3][fpaint] = 255
    provenance[fpaint] = 2
    fpaint_semi = (fill_zone & (fimg[..., 3] < 8) & ~full_cover
                   & (b_a > 8) & ~slot_zone)
    fimg[..., :3][fpaint_semi] = master[..., :3][fpaint_semi]
    fimg[..., 3][fpaint_semi] = master[..., 3][fpaint_semi]
    # face coverage repair: pixels of face material (skin / white hair)
    # inside the opening that no rest-pose renderer owns — the blush SAM
    # claim steals the side-hair strands beside both cheeks and renders
    # nothing there (opacityParam 0 at rest), so the face carries the
    # master's own pixels for them (principle A: exact copy, no repaint).
    cover_rest = np.zeros((H, W), bool)
    for pid in ('bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
        if pid in claim:
            cover_rest |= claim[pid] & (master[..., 3] > 128)
    repair = (face_reach & (skin | (white & face_open)) & alpha
              & ~cover_rest & ~claim['hood'] & ~rim_sel
              & (fimg[..., 3] < 8))
    fimg[..., :3][repair] = master[..., :3][repair]
    fimg[..., 3][repair] = np.maximum(master[..., 3][repair], 200)
    provenance[repair] = 1
    # face: master-lining pixels never belong to the face (rule B) — clear
    # them so the hood's lining (master RGB kept above) shows instead. This
    # is what removes the lining chips that rode the face on every slide.
    chip = claim['face'] & amber_strict & face_open & ~feature_claims
    images['face'][..., 3][chip] = 0
    claim['face'] &= ~chip
    print(f'face fill: {int(fpaint.sum())} px inpainted, '
          f'{int(chip.sum())} px lining chips cleared, '
          f'{int(repair.sum())} px coverage repair')
    # occlusion mask for export_pack.clean_face_part (steps 2/3 restricted
    # to areas hidden at rest under bangs / eyes / mouth)
    occl = np.zeros((H, W), np.uint8)
    for pid in ('bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
        if pid in claim:
            occl[claim[pid]] = 255
    Image.fromarray(occl).save(ART / 'qa' / 'face-occluded.png')

    # hood: white socket under the third-eye (factor 0.6 slides ~21 px over
    # the hood) — round 2 left it empty, so the open patch exposed holes.
    shell_rgb = (249, 243, 240)
    te_core = claim['third-eye'] & alpha
    te_ring = (dilate_mask(te_core, int(DRIFT_THIRDEYE_HOOD) + 6) & alpha
               & ~above_hood)
    # Round-5: the almond's outermost anti-aliased outline pixels fall
    # outside the third-eye claim and stayed in the hood as real ink; when
    # the eye drifts (~21 px relative) they showed as a broken dark outline
    # beside it (the "tear" in think). Repaint that rim as opaque shell.
    # Integration fix: only the outline INK is repainted, and that ink moves
    # to the third-eye part. The ring also held the hood's own soft shading
    # under the lower lid; whitening ink and shading in the hood broke
    # restoration (a 145 px2 block under the eye at rest).
    te_lum = cv2.cvtColor(images['hood'][..., :3], cv2.COLOR_RGB2GRAY)
    te_rim = (dilate_mask(te_core, 4) & ~te_core & alpha & ~above_hood
              & (images['hood'][..., 3] > 0) & (te_lum < 140))
    # ...and the ink itself moves onto the third eye, so the rest pose keeps
    # it and it rides with the eye instead of tearing away from it
    images['third-eye'][..., :3][te_rim] = master[..., :3][te_rim]
    images['third-eye'][..., 3][te_rim] = master[..., 3][te_rim]
    images['hood'][..., :3][te_rim] = shell_rgb
    images['hood'][..., 3][te_rim] = 255
    underlay(images['hood'], te_core, te_ring, shell_rgb, F=4)

    # --- R7-1: split the hood into BACK (hood, z50) and FRONT (hood-front,
    # z85) layers (task book R7-1). The front owns every hood pixel that is
    # VISIBLE AT REST (not covered by any upper part's claim): shell white,
    # the outer outline, the opening's inner rim ink and the shell around
    # the third-eye base — master 中静止时可见的全部兜帽外壳像素. The back
    # keeps everything hidden at rest: the lining inside the opening, the
    # dome completion under the ears/horns, the socket white and the shell
    # continuation bands under the front's own edges. The two pixel sets are
    # disjoint (both derived from one image); the face/bangs/ear/horn
    # transition bands painted further below deliberately overlap the front
    # (衔接带 exception in the task book).
    cover_rest = np.zeros((H, W), bool)
    for pid in ('face', 'bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R',
                'mouth', 'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R'):
        if pid in claim:
            cover_rest |= claim[pid]
    hood_a_img = images['hood'][..., 3] > 8
    # front = visible-at-rest SHELL: outside the opening interior (all of
    # it — the lining ring included — belongs to the back, task book R7-1)
    # and not covered by any upper part at rest. The ears' swing ring
    # (60 px, the P3 behind-ear band) stays in the BACK layer: the ear (z55)
    # renders under the front (z85), so a swung ear would expose the front's
    # plain shell and hide the back's dome arc — the arc must be what shows.
    ear_swing = np.zeros((H, W), bool)
    for pid in ('ear-L', 'ear-R'):
        if pid in claim:
            ear_swing |= dilate_mask(claim[pid] & alpha, 60)
    front_mask = hood_a_img & ~cover_rest & ~hood_opening & ~ear_swing
    images['hood-front'] = np.zeros_like(master)
    images['hood-front'][..., :3][front_mask] = images['hood'][..., :3][front_mask]
    images['hood-front'][..., 3][front_mask] = images['hood'][..., 3][front_mask]
    # the back layer keeps its pixels for now — the socket underlays below
    # still paint on it; the FINAL mutual-exclusion wipe runs after every
    # hood write (R7-4 section) so underlay rings never duplicate the front
    claim['hood-front'] = front_mask
    print(f'hood split: front {int(front_mask.sum())} px visible-at-rest, '
          f'back {int((images["hood"][..., 3] > 8).sum())} px hidden')

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
    # R6-4 probe note: the master amber across the hood hem (with its dark
    # trim) is the HOOD's own artwork — the torso under it is the white
    # shell (visible at y>=502), so the round-2 white median IS the correct
    # rule-B content here. An amber re-fill experiment painted the hood's
    # hem colours into the torso and was reverted.
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
        # Round 5: the variant draws its own arms behind the back, so the
        # copied block reached past the body's side line into the variant's
        # sleeve. An inward arm-L swing (walk -10, any -15) exposed that
        # outline-less white wedge beside the shoulder. Keep only the body
        # side of the variant's side-seam ink (BODY_SIDE, read per row from
        # the variant), so a swinging arm uncovers background there instead.
        ys_i, xs_i = np.mgrid[0:H, 0:W]
        for side, pts in BODY_SIDE.items():
            py = np.array([p[1] for p in pts], float)
            px = np.array([p[0] for p in pts], float)
            line_x = np.interp(ys_i[:, 0], py, px)[:, None]
            outward = (xs_i < line_x - 3) if side == 'L' else (xs_i > line_x + 3)
            outward &= (ys_i >= py[0]) & claim[f'arm-{side}']
            fill &= ~outward
        images['torso'][fill] = behind[fill]; provenance[fill] = 4
        print(f'torso occlusion back-fill: {int(fill.sum())} px')
        string_fill = (claim['string-L'] | claim['string-R']) & torso_zone & ~claim['torso']
        # R6-4: master content crossing the strings' claims (the zipper
        # tape) stays master — the string's own AA blends with it, and the
        # old blanket inpaint replaced the tape's amber under the strings,
        # which showed as a lighter edge whenever the string's AA let it
        # through. The guard only spares pixels that already carry torso
        # content: where the torso is still empty the protected pixels are
        # rule-B holes (the cord's own ink/amber in the master) and must be
        # filled like the rest of the claim — P2 swing poses showed the
        # background straight through them.
        protected = (((A > 110) & (B > 140)) | (L < 100)) & alpha
        string_fill &= ~(protected & (images['torso'][..., 3] > 0))

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

    # --- R6-4: torso clean-up under the arms ---------------------------------
    # (1) isolated ink blocks: torso ink (L<100) in components smaller than
    # 200 px that do not touch the main outline AND where the master shows
    # no ink are stray fragments of the old fills — delete and inpaint
    # cloth. Master ink (the hem, the zipper pull, the pocket trims) is
    # kept unconditionally.
    # (2) the strings' +-25 deg sweep zone must be cloth only: torso pixels
    # inside it where the master shows cloth but the torso carries anything
    # else (the grey ghost blobs the string inpaint pulled from ink) are
    # re-inpainted from cloth-only seeds.
    # (3) the collar carries no transparent holes within 30 px below the
    # hood.
    # (4) the side-seam ink from armpit to hem (BODY_SIDE + mirror), drawn
    # at 4x supersampling with the master's hem ink colour/width, hidden
    # under the arms at rest.
    t_lab = cv2.cvtColor(images['torso'][..., :3], cv2.COLOR_RGB2LAB).astype(int)
    t_ink = (t_lab[..., 0] < 100) & (images['torso'][..., 3] > 128)
    n_ink, lbl_ink, st_ink, _ = cv2.connectedComponentsWithStats(
        t_ink.astype(np.uint8), connectivity=8)
    del_mask = np.zeros((H, W), bool)
    if n_ink > 1:
        main_lbl = 1 + int(np.argmax(st_ink[1:, cv2.CC_STAT_AREA]))
        main_grow = dilate_mask(lbl_ink == main_lbl, 6)
        for i in range(1, n_ink):
            if i == main_lbl or st_ink[i, cv2.CC_STAT_AREA] >= 200:
                continue
            comp = lbl_ink == i
            if (comp & main_grow).any():
                continue  # touches the main outline
            if (comp & (L < 100) & alpha).any():
                continue  # master has ink there: master content, keep
            del_mask |= comp
    if del_mask.any():
        cloth_seed = ((t_lab[..., 0] >= 185) & (images['torso'][..., 3] > 128)
                      & ~del_mask)
        cloth_src = cv2.inpaint(
            cv2.cvtColor(images['torso'][..., :3], cv2.COLOR_RGB2BGR),
            (~cloth_seed).astype(np.uint8) * 255, 8, cv2.INPAINT_TELEA)
        images['torso'][..., :3][del_mask] = cv2.cvtColor(
            cloth_src, cv2.COLOR_BGR2RGB)[del_mask]
        images['torso'][..., 3][del_mask] = 255
        provenance[del_mask] = 4
    print(f'torso isolated ink deleted: {int(del_mask.sum())} px')

    # (2) string sweep cleanup: the strings sweep +-25 deg at runtime; every
    # torso pixel in the sweep where the master shows cloth but the torso
    # carries a ghost blob is re-inpainted from cloth-only seeds
    m_white_cloth = ((L > 216)
                     & ((A - 128) ** 2 + (B - 128) ** 2 < 144)
                     & (master[..., 3] > 128))
    for sid in ('string-L', 'string-R'):
        s_claim = claim[sid] & alpha
        ys_s, xs_s = np.where(s_claim)
        pv = (float(xs_s.mean()), float(ys_s.mean()))
        sweep = np.zeros((H, W), bool)
        for deg in (-25, 25):
            M = cv2.getRotationMatrix2D(pv, deg, 1.0)
            w = cv2.warpAffine(s_claim.astype(np.uint8) * 255, M, (W, H),
                               flags=cv2.INTER_NEAREST, borderValue=0)
            sweep |= w > 0
        sweep |= s_claim
        sweep = dilate_mask(sweep, 4)
        ghost = (sweep & (images['torso'][..., 3] > 128) & m_white_cloth
                 & ~((t_lab[..., 0] > 216)
                     & ((t_lab[..., 1] - 128) ** 2 + (t_lab[..., 2] - 128) ** 2 < 144)))
        if ghost.any():
            cseed = ((t_lab[..., 0] >= 185) & (images['torso'][..., 3] > 128) & ~ghost)
            csrc = cv2.inpaint(cv2.cvtColor(images['torso'][..., :3], cv2.COLOR_RGB2BGR),
                               (~cseed).astype(np.uint8) * 255, 8, cv2.INPAINT_TELEA)
            images['torso'][..., :3][ghost] = cv2.cvtColor(csrc, cv2.COLOR_BGR2RGB)[ghost]
            images['torso'][..., 3][ghost] = 255
            provenance[ghost] = 4
        print(f'{sid} sweep cleanup: {int(ghost.sum())} px')

    # (3) collar: no transparent holes within 30 px of the hood bottom
    hood_bottom_y = int(np.where(claim['hood'].any(axis=1))[0].max())
    collar_band = np.zeros((H, W), bool)
    collar_band[max(0, hood_bottom_y - 30):hood_bottom_y + 30, :] = True
    t_solid = images['torso'][..., 3] > 8
    t_holes = ndimage.binary_fill_holes(t_solid) & ~t_solid & collar_band
    if t_holes.any():
        images['torso'][..., :3][t_holes] = torso_rgb
        images['torso'][..., 3][t_holes] = 255
        provenance[t_holes] = 3
        print(f'collar holes filled: {int(t_holes.sum())} px')

    # (4) side-seam ink, armpit to hem: BODY_SIDE per-row medians + mirror,
    # drawn at 4x supersampling with the master's hem ink colour/width and
    # hidden under the arms at rest
    hem_ink_sel = (L < 100) & alpha & (np.arange(H)[:, None] > 740)
    hem_rgb = (39, 24, 14)
    if hem_ink_sel.any():
        hem_rgb = tuple(int(c) for c in np.median(master[..., :3][hem_ink_sel], axis=0))
    hem_width = 7
    from scipy.interpolate import splprep, splev
    S4 = 4
    for side in ('L', 'R'):
        path = [(x if side == 'L' else 2 * 435 - x, y) for x, y in BODY_SIDE['L']]
        arr = np.array(path, float)
        tck, _ = splprep([arr[:, 0], arr[:, 1]], s=len(arr) * 2.0)
        u = np.linspace(0, 1, 300)
        xs_s, ys_s = splev(u, tck)
        x_lo = int(max(0, min(xs_s.min(), 870 - xs_s.max())) - 12)
        x_hi = int(min(W, max(xs_s.max(), 870 - xs_s.min())) + 12)
        y_lo = int(max(0, ys_s.min() - 12))
        y_hi = int(min(H, ys_s.max() + 12))
        cw, ch = (x_hi - x_lo) * S4, (y_hi - y_lo) * S4
        canvas4 = np.zeros((ch, cw, 3), np.uint8)
        p4 = np.column_stack([(xs_s - x_lo) * S4, (ys_s - y_lo) * S4]).astype(np.int32)
        cv2.polylines(canvas4, [p4], False, hem_rgb, thickness=hem_width * S4,
                      lineType=cv2.LINE_AA)
        down = cv2.resize(canvas4, (x_hi - x_lo, y_hi - y_lo),
                          interpolation=cv2.INTER_AREA)
        ink_strength = down.max(axis=2) > 40
        ink_mask = np.zeros((H, W), bool)
        ink_mask[y_lo:y_hi, x_lo:x_hi] = ink_strength > 0
        ink_mask &= (claim['arm-L'] | claim['arm-R'])  # hidden at rest
        ink_mask &= alpha & (images['torso'][..., 3] > 8)
        take_ink = ink_mask & ~((L < 100) & alpha)  # not over master ink
        images['torso'][..., :3][take_ink] = np.array(hem_rgb, np.uint8)
        images['torso'][..., 3][take_ink] = 255
        provenance[take_ink] = 1
    print('torso side-seam ink drawn (hidden under the arms at rest)')

    # arm: shoulder extension into the body — take the torso part's own
    # pixels there (same cloth colour at rest, plausible when the arm lifts)
    ext_used = np.zeros((H, W), bool)
    for arm, other_arm in (('arm-L', 'arm-R'), ('arm-R', 'arm-L')):
        grow = cv2.dilate(claim[arm].astype(np.uint8), cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (51, 51))).astype(bool)
        ext = grow & torso_zone & alpha & ~claim[arm] & ~claim[other_arm] & ~claim['torso'] & ~claim['hood'] & ~claim['string-L'] & ~claim['string-R']
        # the whole band stays reserved (other parts' extensions keep their
        # round-3 reach), but the arm only TAKES the shoulder band: below the
        # armpit the seam ink closes the sleeve and any torso strip past it
        # would swing out as an outline-less edge
        ext_used |= ext
        ext = ext.copy()
        ext[ARMPIT_Y[arm]:, :] = False
        # only real torso cloth rides the arm (no collar sweep / lining fill)
        take = ext & (images['torso'][..., 3] > 8) & (provenance != 3) & (provenance != 2)
        images[arm][take] = images['torso'][take]
        provenance[take] = 1
        # rest of the band stays empty: the arm renders above the torso, and
        # a flat patch there would be visible at rest over the master's ink
        # the sleeve has no amber trim: amber pixels on it are pocket tips
        # where the pocket meets the seam — they belong to the torso (which
        # draws them at rest) and would ride the arm as loose orange chips
        hsv = cv2.cvtColor(images[arm][..., :3], cv2.COLOR_RGB2HSV)
        chip = ((images[arm][..., 3] > 8) & (hsv[..., 0] >= 5) & (hsv[..., 0] <= 30)
                & (hsv[..., 1] > 110) & (hsv[..., 2] > 110))
        # plus its anti-aliased fringe (still visibly tinted); rows above the
        # cuff bottom only — the hand's warm shading below must stay
        chip |= dilate_mask(chip, 1) & (images[arm][..., 3] > 8) & (hsv[..., 1] > 60)
        chip[CUFF_BOTTOM_Y:, :] = False
        images[arm][chip] = 0
        claim[arm] &= ~chip
        images['torso'][chip] = master[chip]
        claim['torso'] |= chip
        provenance[chip] = 0
        print(f'{arm}: dropped {int(chip.sum())} px of pocket chips')

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
    # ear root band 15 px (round 6 R6-2): the ear's copied band into the
    # hood must stay short so its straight cut edge swings only inside the
    # hood's shell at +-20 deg and never shows as a bare edge
    EXT_RADIUS = {
        'tail': 30, 'leg-L': 40, 'leg-R': 40, 'ear-L': 22, 'ear-R': 22,
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
    # hood-front is the visible half of the hood's own territory (R7-1
    # split), not an independent claim — the joint bands must be free to
    # grow into it (the ear root hides under the front layer).
    all_others = {p: m for p, m in claim.items() if p != 'hood-front'}
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
            # away. The horn (z86, sewn on the hood FRONT) carries a copy of
            # the master's own pixels in a ring around its claim: at rest it
            # hides under the hood's identical pixels; when the hood slides
            # the ring keeps the junction content instead of exposing
            # background. R7-1 caps the ring at 10 px (角根 ≤ 10 px).
            h_core = claim[pid] & alpha
            grow = dilate_mask(h_core, 10) & alpha & ~above_hood & ~claim[pid]
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
            if pid in ('ear-L', 'ear-R') and 'hood-front' in images:
                # R7-1: the ear root's band copies the hood BACK layer — the
                # ear (z55) renders over the back (z50), so the swung-ear cut
                # edge must carry the back's own pixels (shell white AND the
                # dome outline ink P3 polices). The front layer owns no
                # pixels inside the ear swing ring.
                host_img = images['hood']
            host_edges = cv2.Canny(cv2.cvtColor(host_img[..., :3], cv2.COLOR_RGB2GRAY), 60, 160)
            host_edges = cv2.dilate(host_edges, np.ones((5, 5), np.uint8)) > 0
            # only the host's REAL pixels may ride a moving part: the torso
            # collar fill (provenance 3) covers the hood's swing and the hood
            # lining fill (2) is synthetic — swung out by a string/eye they
            # would show as detached wedges
            if pid in ('ear-L', 'ear-R'):
                # the ear's copy runs up to the hood's own ink (no edge
                # exclusion): a cut through the shell 5 px before the ink
                # resampled into faint grey dots at half scale (round-6
                # seam probe); a cut ON the ink blends dark over dark
                take = (ext & (host_img[..., 3] > 8)
                        & (provenance != 3) & (provenance != 2))
            else:
                take = (ext & (host_img[..., 3] > 8) & ~host_edges
                        & (provenance != 3) & (provenance != 2))
            images[pid][take] = host_img[take]; provenance[take] = 1

    # R6-2: enclosed alpha holes inside the ears (the fluff's transparent
    # gaps, round-6 diagnosis 05) get the master's own fluff pixels. (The
    # white socket underlay moved AFTER the R7-2 rewrite: it must paint only
    # what the rewrite leaves empty, or it whites out the dome outline ink
    # the rewrite restores — P3 0.73.)
    alpha8 = master[..., 3] > 8
    for e in ('ear-L', 'ear-R'):
        e_img = images[e]
        e_solid = e_img[..., 3] > 8
        e_holes = ndimage.binary_fill_holes(e_solid) & ~e_solid & (master[..., 3] > 128)
        e_img[..., :3][e_holes] = master[..., :3][e_holes]
        e_img[..., 3][e_holes] = 255
        if e_holes.any():
            print(f'{e}: filled {int(e_holes.sum())} internal alpha holes')

    # Round-5: horn-base anti-alias specks. A few tiny horn-amber islands
    # (<40 px) stay in the hood under the horn bases; the hood slides
    # -0.35k under the static horns on turn, so they surfaced as amber
    # dashes beside the right horn. Drop them from the hood.
    hood_img = images['hood']
    hlab = cv2.cvtColor(hood_img[..., :3], cv2.COLOR_RGB2LAB).astype(int)
    horn_amber = (hlab[..., 1] > 135) & (hlab[..., 2] > 150) & (hood_img[..., 3] > 0)
    n_c, lbl_c, st_c, _ = cv2.connectedComponentsWithStats(horn_amber.astype(np.uint8), connectivity=8)
    horn_zone = dilate_mask(claim['horn-L'] | claim['horn-R'], 20)
    for i in range(1, n_c):
        speck = lbl_c == i
        if st_c[i, cv2.CC_STAT_AREA] < 40 and (speck & horn_zone).any():
            hood_img[..., 3][speck] = 0

    # --- R7-2: clean the hood BACK layer (task book R7-2) ---------------------
    # After the split the back may carry ONLY: lining inside HOOD_OPENING,
    # the dome completion (white + the R6-2 arc ink) under the ear/horn rest
    # coverage, and shell white under the front layer. Every ear/horn/eye
    # pixel the round-6 passes wrote back into the hood dies here.
    master_gray = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2GRAY)
    master_dark = master_gray < 110
    # strictly hidden at rest = an upper part renders alpha >= 200 there
    cover_strict = np.zeros((H, W), bool)
    for pid in ('face', 'bangs', 'eye-L', 'eye-R', 'iris-L', 'iris-R',
                'mouth', 'third-eye', 'ear-L', 'ear-R', 'horn-L', 'horn-R'):
        if pid in images:
            cover_strict |= images[pid][..., 3] > 200
    back_a = images['hood'][..., 3] > 8
    back_lab = cv2.cvtColor(images['hood'][..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
    back_white = ((back_lab[..., 0] > 217)
                  & (np.sqrt((back_lab[..., 1] - 128) ** 2
                             + (back_lab[..., 2] - 128) ** 2) < 12) & back_a)

    def inpaint_from(img, zone, seeds, radius=6):
        """Fill `zone` by copying each pixel from its NEAREST seed pixel
        (distance transform with indices). cv2.inpaint's TELEA on a large
        zone blends across material boundaries and pulled grey/black sludge
        into the rewritten bands (round-7 exclusivity 'other' colours);
        nearest-seed copying keeps every material pure and spatially
        consistent. `seeds` must be a mask of img's own good pixels."""
        dist, (iy, ix) = ndimage.distance_transform_edt(~seeds, return_indices=True)
        take = zone & np.isfinite(dist)
        img[..., :3][take] = img[iy[take], ix[take], :3]
        img[..., 3][take] = 255

    # (1) delete the ear copies (R7-2.1) and the horn copies (R7-2.2): the
    # ear's inner amber, fur white and outline ink die INSIDE the ear/horn
    # body (12 px around the master's own amber core); the hood's own pixels
    # in the claim's fringe (shell white + the dome outline ink crossing the
    # ear root) KEEP the master's RGBA — the ear swing exposes exactly them,
    # and P3 demands the outline (the round-6 skirt copied them as a side
    # effect; deleting it wholesale broke P3 to 0.72).
    ear_cov = (claim['ear-L'] | claim['ear-R']) & alpha
    horn_cov = (claim['horn-L'] | claim['horn-R']) & alpha
    cov_eh = ear_cov | horn_cov
    amber_core = ((A > 128) & (B > 140) & (L > 60) & (L < 220) & alpha) & cov_eh
    # whiten the ear/horn CONTENT (amber, fur, rim) but KEEP the ink in the
    # claim's boundary band: there the master's ear outline IS the hood
    # outline's continuation (the ear root's ink joins the dome outline),
    # so a swung ear exposes a hood edge, not an ink-less white cut (P3) —
    # while the amber/fur body (the D4 ear copy) is fully deleted.
    edge_band = (dilate_mask(cov_eh, 3)
                 & ~(cv2.erode(cov_eh.astype(np.uint8),
                               np.ones((31, 31), np.uint8)).astype(bool)))
    edge_ink_keep = master_dark & edge_band & cov_eh
    whiten = cov_eh & cover_strict & back_a & ~edge_ink_keep
    if whiten.any():
        inpaint_from(images['hood'], whiten, back_white & ~dilate_mask(cov_eh, 2))
    # the ear claim's own pixels are EMPTY in the back (exclusive assignment
    # gave them to the ear) — the socket underlay then painted plain white
    # over the dome outline ink that crosses the ear tip (P3 0.73). Fill the
    # empty claim band from the master: inside the edge band the master IS
    # the hood outline + shell white; outside it, the ear body gets white.
    ear_empty = cov_eh & cover_strict & (images['hood'][..., 3] < 8)
    # restore the master's hood ink + shell white in the edge band, but the
    # ear's own AMBER (the visible-at-rest lining colour of the ear rim)
    # dies even there — D4's "not a single amber pixel" rule.
    amber_edge = ((A > 135) & (B > 170) & alpha)
    ear_empty_keep = ear_empty & edge_band & ~amber_edge
    ear_empty_white = ear_empty & ~ear_empty_keep
    if ear_empty_keep.any():
        images['hood'][..., :3][ear_empty_keep] = master[..., :3][ear_empty_keep]
        images['hood'][..., 3][ear_empty_keep] = 255
    if ear_empty_white.any():
        images['hood'][..., :3][ear_empty_white] = (250, 250, 250)
        images['hood'][..., 3][ear_empty_white] = 255
    print(f'R7-2 ear/horn copy rewrite: {int(whiten.sum())} px -> hood white, '
          f'{int(ear_empty_keep.sum())} px empty-band master restored, '
          f'{int(ear_empty_white.sum())} px empty-body whitened')
    if os.environ.get('BAIZE_TRACE'):
        for _pt in ((256, 656), (260, 652), (266, 646)):
            _yy, _xx = _pt
            print(f'[trace] ear-empty ({_xx},{_yy}): keep={bool(ear_empty_keep[_yy, _xx])} '
                  f'white={bool(ear_empty_white[_yy, _xx])} band={bool(edge_band[_yy, _xx])} '
                  f'cov={bool(cov_eh[_yy, _xx])} strict={bool(cover_strict[_yy, _xx])} '
                  f'dark={bool(master_dark[_yy, _xx])} '
                  f'back_before={images["hood"][_yy, _xx].tolist()} '
                  f'after={images["hood"][_yy, _xx].tolist()}')
    if os.environ.get('BAIZE_TRACE'):
        print(f'[trace] after whiten: back={images["hood"][243, 300].tolist()}')

    # (2) R6-2 dome arc: the hood outline's continuation behind each ear and
    # horn base. The dome outline is a smooth near-circular arc — fit a
    # circle (Kasa least squares) to the outline's own flanking ink and
    # stroke the arc across the coverage's angular range at 4x supersampling
    # (P3 behind-ear coverage).
    # the dome outline only — the opening's rim ink is 40+ px away from the
    # ears and would bend the fit across the shell
    ink_own = master_dark & claim['hood'] & ~dilate_mask(hood_opening, 12)
    ink_rgb = np.median(master[..., :3][ink_own], axis=0) if ink_own.any() else np.array([52, 40, 34])
    wd = cv2.distanceTransform(ink_own.astype(np.uint8), cv2.DIST_L2, 3)
    ink_half = float(np.median(wd[ink_own & (wd > 0)])) if (ink_own & (wd > 0)).any() else 2.5
    arc_total = 0
    arc_fits = {}
    for pid in ('ear-L', 'ear-R', 'horn-L', 'horn-R'):
        cov = claim[pid] & alpha
        near = ink_own & dilate_mask(cov, 55) & ~dilate_mask(cov, 5)
        ys_p, xs_p = np.where(near)
        if len(ys_p) < 30:
            print(f'R7-2 arc {pid}: skipped ({len(ys_p)} flanking ink px)')
            continue
        fx = xs_p.astype(float)
        fy = ys_p.astype(float)
        am = np.column_stack([fx, fy, np.ones(len(fx))])
        bv = fx ** 2 + fy ** 2
        sol, *_ = np.linalg.lstsq(am, bv, rcond=None)
        ccx, ccy = sol[0] / 2, sol[1] / 2
        rad = float(np.sqrt(max(1e-6, sol[2] + ccx ** 2 + ccy ** 2)))
        if not (30 <= rad <= 4000):
            print(f'R7-2 arc {pid}: degenerate fit r={rad:.0f}')
            continue
        arc_fits[pid] = [round(ccx, 2), round(ccy, 2), round(rad, 2)]
    for pid in ('ear-L', 'ear-R', 'horn-L', 'horn-R'):
        cov = claim[pid] & alpha
        if pid not in arc_fits:
            print(f'R7-2 arc {pid}: skipped (no fit)')
            continue
        ccx, ccy, rad = arc_fits[pid]
        ys_c, xs_c = np.where(cov)
        ang_c = np.arctan2(ys_c - ccy, xs_c - ccx)
        # angular wrap: when the coverage spans +-pi (the fitted centre sits
        # below the ear), a naive linspace would sweep the WRONG way round
        # the circle and draw a broken dash instead of the arc
        if ang_c.max() - ang_c.min() > np.pi:
            ang_c = np.where(ang_c < 0, ang_c + 2 * np.pi, ang_c)
        a_lo, a_hi = float(ang_c.min()), float(ang_c.max())
        pad_a = 0.06
        u = np.linspace(a_lo - pad_a, a_hi + pad_a, 600)
        xs_s = ccx + rad * np.cos(u)
        ys_s = ccy + rad * np.sin(u)
        x_lo = int(max(0, min(xs_s.min(), 0) - 12))
        x_hi = int(min(W, max(xs_s.max(), W) + 12))
        y_lo = int(max(0, min(ys_s.min(), 0) - 12))
        y_hi = int(min(H, max(ys_s.max(), H) + 12))
        S4 = 4
        canvas4 = np.zeros(((y_hi - y_lo) * S4, (x_hi - x_lo) * S4, 3), np.uint8)
        p4 = np.column_stack([(xs_s - x_lo) * S4,
                              (ys_s - y_lo) * S4]).astype(np.int32)
        cv2.polylines(canvas4, [p4], False, tuple(int(c) for c in ink_rgb),
                      thickness=max(1, int(round(2 * ink_half + 1)) * S4),
                      lineType=cv2.LINE_AA)
        down = cv2.resize(canvas4, (x_hi - x_lo, y_hi - y_lo),
                          interpolation=cv2.INTER_AREA)
        strength = down.max(axis=2) >= 30
        arc_mask = np.zeros((H, W), bool)
        arc_mask[y_lo:y_hi, x_lo:x_hi] = strength
        # inside the coverage the master's own dark pixels are the EAR/HORN
        # copies being deleted — the arc paints over the whitened content;
        # outside it the hood's own outline ink is never overwritten
        paint = (arc_mask & dilate_mask(cov, 3) & back_a
                 & (~master_dark | cov) & (master[..., 3] > 8))
        if os.environ.get('BAIZE_ARC_DEBUG'):
            print(f'  [arc dbg {pid}] near={len(ys_p)} r={rad:.0f} c=({ccx:.0f},{ccy:.0f}) '
                  f'strength={int(strength.sum())} '
                  f'mask∩cov3={int((arc_mask & dilate_mask(cov, 3)).sum())} '
                  f'+back_a={int((arc_mask & dilate_mask(cov, 3) & back_a).sum())} '
                  f'+notdark={int(paint.sum())}')
        images['hood'][..., :3][paint] = np.array(ink_rgb, np.uint8)
        images['hood'][..., 3][paint] = 255
        arc_total += int(paint.sum())
        print(f'R7-2 arc {pid}: {int(paint.sum())} px inked')
    print(f'R7-2 dome arc total: {arc_total} px')
    if arc_fits:
        (ART / 'qa' / 'arc-fit.json').write_text(
            json.dumps(arc_fits) + '\n', encoding='utf-8')

    # (3) lining only inside the opening (R7-2.4): hair-white pixels the
    # rebuild could not touch (face-stack claim positions) get rewritten to
    # lining from the back's own lining seeds. Refined round-7: only white
    # regions that connect to NO shell white outside the opening are
    # side-hair copies (their component lives inside the rim ink barrier);
    # the hood interior's own shell-white gradient above the head connects
    # across the ear roots to the outer shell and must survive — the master
    # paints it, and a head turn must expose shell there, not amber.
    back_lining = (back_lab[..., 1] > 135) & (back_lab[..., 2] > 170) & back_a
    hairwhite_b = ((back_lab[..., 0] > 217)
                   & (np.sqrt((back_lab[..., 1] - 128) ** 2
                              + (back_lab[..., 2] - 128) ** 2) < 12) & back_a)
    white_master = alpha & ~amber & ~skin & ~dark
    lbl_w, n_w = ndimage.label(white_master)
    touch_out = np.zeros(n_w + 1, bool)
    if n_w:
        touch_out[np.unique(lbl_w[white_master & ~hood_opening])] = True
    enclosed_white = np.zeros((H, W), bool)
    if n_w:
        for i in np.unique(lbl_w[hairwhite_b & hood_opening]):
            if i > 0 and not touch_out[i]:
                enclosed_white |= lbl_w == i
    hw_fix = (hairwhite_b & enclosed_white & cover_strict)
    if hw_fix.any():
        inpaint_from(images['hood'], hw_fix, back_lining & ~dilate_mask(hw_fix, 2))
    print(f'R7-2 hair-white in opening rewritten: {int(hw_fix.sum())} px')
    if os.environ.get('BAIZE_TRACE'):
        print(f'[trace] after hw_fix: back={images["hood"][243, 300].tolist()}')

    # (4) third-eye socket (R7-4.2): smooth hood white within 14 px of the
    # eye's rest coverage (the parallax headroom 0.95*kx*0.6 + margin); no
    # socket ink, shading or AA fringe survives in the hood layers — the
    # eye's own outline rides third-eye.png (te_rim above) and moves with
    # it, so the rest composite is unchanged while a turnY slide exposes
    # clean white instead of the socket's dashed fringe.
    te_front = images.get('hood-front')
    te_socket = dilate_mask(te_core, 14) & back_a
    if te_socket.any():
        inpaint_from(images['hood'], te_socket, back_white & ~dilate_mask(te_socket, 2))
    if te_front is not None:
        # the FRONT layer is visible at rest wherever the eye part does not
        # cover it (P1: rest composite = master) — only the band the eye's
        # own riding ink actually hides (the 4 px te_rim ring) may be
        # whitened; the 4-14 px ring keeps the master's shading.
        fs_a = te_front[..., 3] > 8
        te_socket_f = dilate_mask(te_core, 4) & fs_a & ~te_core
        if te_socket_f.any():
            fw = cv2.cvtColor(te_front[..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
            fw_white = ((fw[..., 0] > 217)
                        & (np.sqrt((fw[..., 1] - 128) ** 2
                                   + (fw[..., 2] - 128) ** 2) < 12) & fs_a)
            inpaint_from(te_front, te_socket_f, fw_white & ~dilate_mask(te_socket_f, 2))
    print(f'R7-4 third-eye socket whitened: back {int(te_socket.sum())} px, '
          f'front {int((te_socket_f if te_front is not None else 0).sum()) if te_front is not None else 0} px')

    # --- R7-3: clean the face -------------------------------------------------
    fimg = images['face']
    face_px = fimg[..., 3] > 0
    # pixels the face carries exactly as the master drew them stay untouched
    # (principle A: visible rest content must equal the master)
    unchanged = ((np.abs(fimg[..., :3].astype(np.int16)
                         - master[..., :3].astype(np.int16)).max(axis=2) <= 3)
                 & (fimg[..., 3] == master[..., 3]) & (master[..., 3] > 128))
    # (1) eye/mouth sockets (R7-3.1): the union of ALL slot footprints + 8 px
    slot_hard = np.zeros((H, W), bool)
    for pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
        if pid in claim:
            slot_hard |= claim[pid] & alpha
    patches_report = ART / 'patches' / 'patches-report.json'
    if patches_report.exists():
        rep = json.loads(patches_report.read_text(encoding='utf-8'))
        for name, r in sorted(rep.items()):
            if name.startswith('third-eye'):
                continue
            sides = ('L', 'R') if 'L' in r else (None,)
            for side in sides:
                src = ROOT / (r[side]['image'] if side else r['image'])
                ox, oy = r[side]['offset'] if side else r['offset']
                if not src.exists():
                    continue
                p = np.array(Image.open(src).convert('RGBA'))
                ph, pw = p.shape[:2]
                x0, y0 = int(ox), int(oy)
                x1, y1 = min(W, x0 + pw), min(H, y0 + ph)
                if x1 <= x0 or y1 <= y0:
                    continue
                slot_hard[y0:y1, x0:x1] |= p[:y1 - y0, :x1 - x0, 3] > 8
    socket_zone = dilate_mask(slot_hard, 8)
    allowed_ink = (master_dark & ~dilate_mask(slot_hard, 2)) | unchanged
    socket_fix = socket_zone & face_px & ~allowed_ink
    face_lab = cv2.cvtColor(fimg[..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
    face_skin = ((face_lab[..., 2] >= 133) & (face_lab[..., 0] >= 185) & face_px)
    if socket_fix.any():
        # seeds = the MASTER's own visible skin around the footprints (the
        # face's flat fills are globally constant and their dE against the
        # local skin gradient fails P2's eye->face rows; master skin carries
        # the local gradient)
        master_skin = ((lab[..., 2] >= 133) & (lab[..., 0] >= 185)
                       & alpha & ~slot_hard & ~claim['hood'] & ~rim_sel)
        inpaint_from(fimg, socket_fix, master_skin & ~dilate_mask(socket_fix, 2), radius=6)
    print(f'R7-3 socket residues rewritten: {int(socket_fix.sum())} px')
    # transparency inside the slot footprints: the round-6 fill zone cut at
    # master alpha > 128, so every patch footprint's anti-aliased rim kept
    # face alpha < 128 — P2 (eye -> face) reads those as see-through when
    # the patch slides. Inpaint them opaque from the surrounding skin.
    trans_fix = slot_hard & (fimg[..., 3] < 128) & (master[..., 3] > 8)
    if trans_fix.any():
        inpaint_from(fimg, trans_fix, face_skin & ~dilate_mask(trans_fix, 2), radius=6)
    print(f'R7-3 slot-footprint transparency filled: {int(trans_fix.sum())} px')

    # (2) under the fringe (R7-3.2): the master's visible forehead skin
    # defines a skin band (extended 25 px up); everything above is hair.
    # No large-radius inpaint — skin fills from skin seeds, hair fills by
    # copying the nearest visible hair pixel (strand shading carried), and
    # the two bands feather 4 px at their boundary.
    bangs_a = claim['bangs'] & alpha
    refill = ((bangs_a & face_open) & face_px & ~socket_zone & ~unchanged)
    skin_vis = skin & face_open & ~claim['bangs'] & alpha
    top_skin = np.full(W, H + 1, np.int32)
    ys_sk, xs_sk = np.where(skin_vis)
    if len(ys_sk):
        np.minimum.at(top_skin, xs_sk, ys_sk)
    yy_grid = np.arange(H)[:, None]
    skin_band = refill & (top_skin < H)[None, :] & (yy_grid >= (top_skin[None, :] - 25))
    hair_band = refill & ~skin_band
    # master's visible hair (neutral tone incl. shaded strands)
    hair_vis = (L > 170) & (((A - 128) ** 2 + (B - 128) ** 2) < 16 ** 2) & alpha
    if refill.any():
        # hair fill first (into a temp), then skin fill, then feather
        hair_fill_rgb = fimg[..., :3].copy()
        dist_h, (iy_h, ix_h) = ndimage.distance_transform_edt(
            (~hair_vis) | dilate_mask(refill, 2), return_indices=True)
        take_h = refill & (dist_h <= 25)
        hair_fill_rgb[take_h] = master[..., :3][iy_h[take_h], ix_h[take_h]]
        if skin_band.any():
            inpaint_from(fimg, skin_band, skin_vis & ~dilate_mask(refill, 2), radius=6)
        w = cv2.GaussianBlur((skin_band * 255).astype(np.uint8), (9, 9), 2).astype(np.float32) / 255.0
        blend = (fimg[..., :3].astype(np.float32) * w[..., None]
                 + hair_fill_rgb.astype(np.float32) * (1 - w[..., None]))
        fimg[..., :3][refill] = blend[refill].astype(np.uint8)
        fimg[..., 3][refill] = 255
    print(f'R7-3 under-fringe refill: {int(refill.sum())} px '
          f'(skin band {int(skin_band.sum())}, hair band {int(hair_band.sum())})')

    # (3) R7-1.3 transition bands: face and bangs grow 18 px past their top
    # and side edges INTO the front layer's territory, painted as hair
    # (nearest visible hair within 25 px, strand shading carried). The band
    # rides its own part, so a turnY +1 face drop (~9 px) still leaves the
    # hair tips pressed under the front layer. Restricted to the hood's
    # inner-rim ink neighbourhood (the task book's 顶边、两侧边 along the
    # opening) — a blanket front_mask reach painted chin/neck rows as hair.
    band_total = 0
    for pid in ('face', 'bangs'):
        cl = claim[pid] & alpha
        band = (dilate_mask(cl, 18) & dilate_mask(rim_sel, 14) & ~cl
                & ~rim_sel & front_mask & ~above_hood & (master[..., 3] > 8))
        dist_h2, (iy_h2, ix_h2) = ndimage.distance_transform_edt(
            (~hair_vis) | dilate_mask(band, 2), return_indices=True)
        take_b = band & (dist_h2 <= 25)
        if take_b.any():
            images[pid][..., :3][take_b] = master[..., :3][iy_h2[take_b], ix_h2[take_b]]
            images[pid][..., 3][take_b] = 255
            band_total += int(take_b.sum())
    print(f'R7-1 transition bands (face+bangs): {band_total} px hair')

    # --- R7-4.1: third-eye alpha cutoff ---------------------------------------
    # The alpha stops at the eye outline's outer edge: at most a 2 px AA
    # transition survives, and any BRIGHT semi-alpha speck outside the solid
    # core (the white halo / dashed ring of D5) dies outright.
    te_img = images['third-eye']
    te_core_solid = te_img[..., 3] >= 200
    te_dist = cv2.distanceTransform((~te_core_solid).astype(np.uint8), cv2.DIST_L2, 3)
    te_gray = cv2.cvtColor(te_img[..., :3], cv2.COLOR_RGB2GRAY)
    te_halo = ((~te_core_solid) & (te_img[..., 3] > 0) & (te_dist >= 1)
               & (te_gray > 150))
    te_far = (~te_core_solid) & (te_img[..., 3] > 0) & (te_dist > 2)
    te_cut = te_halo | te_far
    te_img[..., 3][te_cut] = 0
    print(f'R7-4 third-eye alpha cutoff: {int(te_cut.sum())} px cleared '
          f'(halo {int(te_halo.sum())}, far {int(te_far.sum())})')

    # hood: an "ear socket" of flat hood white under each ear — footprint
    # plus a 60 px swing ring, feathered 3 px (R6-2). R7: this runs AFTER the
    # R7-2 rewrite so it paints only what the rewrite leaves empty (the ear
    # body's whitened interior); the dome outline ink the rewrite restores
    # (claim fringe, alpha 255) is not touched by the underlay's alpha<8
    # rule. The ring stays inside claim['hood'] — outside it lies the page
    # background, and socket white there blew the composite silhouette past
    # the master's and left an ink-less white edge for P3.
    for e in ('ear-L', 'ear-R'):
        e_core = claim[e] & alpha
        e_ring = dilate_mask(e_core, 60) & alpha8 & ~above_hood & claim['hood']
        underlay(images['hood'], e_core, e_ring, (250, 250, 250), F=3)

    # --- R7-1 final mutual exclusion ------------------------------------------
    # Every hood write (lining rebuild, socket underlays, whiten, arc, hair
    # bands) is done: pixels visible at rest belong ONLY to the front layer
    # now (同一位置只能属于其中一层, task book R7-1.1).
    wipe = front_mask & (images['hood'][..., 3] > 0)
    images['hood'][..., 3][wipe] = 0
    claim['hood'] &= ~front_mask
    print(f'R7-1 final mutual exclusion: {int(wipe.sum())} px wiped from back '
          f'(front {int((images["hood-front"][..., 3] > 8).sum())} px, '
          f'back {int((images["hood"][..., 3] > 8).sum())} px)')
    if os.environ.get('BAIZE_TRACE'):
        print(f'[trace] after wipe: back={images["hood"][243, 300].tolist()} '
              f'front={images["hood-front"][243, 300].tolist()}')
        for _pt in ((256, 656), (260, 652)):
            _yy, _xx = _pt
            print(f'[trace] wipe-check ({_xx},{_yy}): back='
                  f'{images["hood"][_yy, _xx].tolist()} in_front_mask='
                  f'{bool(front_mask[_yy, _xx])}')

    # --- QA sheet + write -----------------------------------------------------
    rng = np.random.default_rng(11)
    overlay = master[..., :3].copy()
    overlay_ids = list(Z_DESC) + ['hood-front']
    for pid in overlay_ids:
        m = claim.get(pid)
        if m is None or not m.any():
            continue
        color = rng.integers(70, 255, 3)
        for c in range(3):
            overlay[..., c][m] = (0.45 * overlay[..., c][m] + 0.55 * color[c]).astype(np.uint8)
    Image.fromarray(overlay).save(ART / 'qa' / 'segmentation-round2.png')

    Image.fromarray((provenance * 60).astype(np.uint8)).save(ART / 'qa' / 'provenance.png')
    DST_NEW = ART / 'parts-ext-new'
    if DST_NEW.exists():
        shutil.rmtree(DST_NEW)
    DST_NEW.mkdir(parents=True)
    for pid in overlay_ids:
        if pid not in images:
            continue
        Image.fromarray(images[pid]).save(DST_NEW / f'{pid}.png', optimize=True)
        own_px = int(claim[pid].sum()) if pid in claim else int((images[pid][..., 3] > 8).sum())
        print(f'{pid}: {own_px} px own')

    if DST.exists():
        old = ART / 'parts-ext-round1'
        if old.exists():
            shutil.rmtree(old)
        shutil.move(str(DST), str(old))
    shutil.move(str(DST_NEW), str(DST))
    print('parts-ext replaced (round-1 kept at parts-ext-round1)')


if __name__ == '__main__':
    main()
