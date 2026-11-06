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
    # the fill barrier is the TRUE opening boundary: the rim ink (closed to
    # bridge hairline gaps; the fringe claims bridge the wide top gap) plus
    # the head stack. A polygon-complement barrier overshot the true rim at
    # the top corner by ~10 px and the rebuild's lining surfaced there as an
    # amber bar whenever the fringe slid down (turnY).
    rim_closed = cv2.morphologyEx(rim_core.astype(np.uint8), cv2.MORPH_CLOSE,
                                  np.ones((21, 21), np.uint8)).astype(bool)
    opening_full = ndimage.binary_fill_holes(head_fill | claim['hood'] | rim_closed)
    # include the master's SEMI-alpha pixels (8..128): split_parts claims
    # alpha>128 only, so the rim's anti-aliased fringe belonged to nobody,
    # left a ring of zero alpha inside the opening and bled background
    # whenever the warped silhouette sampled it
    hood_opening = (opening_full & face_open & ~rim_sel
                    & (master[..., 3] > 8))
    # the polygon overshoots the true rim's top by ~10 px in places; the
    # band between the polygon edge and the rim is SHELL continuation (the
    # master shows shell white there) — rebuilding it as lining surfaced an
    # amber bar with a straight bottom edge on every turnY. Exclude the band
    # above each column's topmost rim-ink pixel.
    rim_top = np.full(W, H + 1, np.int32)
    ys_rim, xs_rim = np.where(rim_core)
    if len(ys_rim):
        np.minimum.at(rim_top, xs_rim, ys_rim)
    poly_top = np.full(W, H + 1, np.int32)
    ys_p, xs_p = np.where(face_open)
    if len(ys_p):
        np.minimum.at(poly_top, xs_p, ys_p)
    yy_grid = np.arange(H)[:, None]
    # only columns whose topmost rim pixel IS the top arc (near the
    # polygon's top edge) get clipped; under the fringe the topmost rim
    # pixel is the chin's bottom arc and clipping would erase the column
    has_top_rim = (rim_top <= H) & (np.abs(rim_top - poly_top) < 60)
    shell_band = (face_open & has_top_rim[None, :]
                  & (yy_grid < rim_top[None, :] + 2))
    hood_opening &= ~shell_band
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
    keep = hood_opening & ~cover_up
    keep |= hood_opening & amber_strict & ~feature_claims
    seed_sel = amber_strict & hood_opening & ~cover_up & ~feature_claims
    need = hood_opening & ~keep
    hood_bgr = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2BGR)
    filled = cv2.inpaint(hood_bgr, (~seed_sel).astype(np.uint8) * 255, 15,
                         cv2.INPAINT_TELEA)
    filled = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB).astype(np.float32)
    filled = cv2.GaussianBlur(filled, (0, 0), 6)
    images['hood'][..., :3][need] = filled[need].astype(np.uint8)
    # keep pixels the hood does not own yet: copy the master (they become
    # visible the moment the face's lining chips below are cleared)
    own_missing = keep & (images['hood'][..., 3] < 8)
    images['hood'][..., :3][own_missing] = master[..., :3][own_missing]
    images['hood'][..., 3][hood_opening] = 255
    provenance[hood_opening] = 2
    # forbidden content check (rule: no white / skin / hair in the rebuild)
    # hood edge skirt: 3 px of opaque hood content extending past the
    # silhouette wherever that silhouette segment is hidden under the face
    # stack at rest. When the head swings, the warped silhouette's bilinear
    # interpolation band would otherwise sample zeros and bleed background
    # through the cheek edge; with the skirt it blends hood content. The
    # rest composite is unchanged (the skirt is hidden at rest).
    hood_a = images['hood'][..., 3]
    hood_solid = hood_a >= 250
    # 24 px = the silhouette's own travel at tilt +-12 (rotation arc at the
    # cheek radius); the warped edge's interpolation band must always land
    # on skirt content, never on zeros. Dome side only (outside the opening
    # polygon): the colour is the master's own pixel — the round-3 fringe
    # root band's rule, widened — a nearest-solid extension here dragged
    # lining amber up into the shell and drew a straight bar on turnY.
    # Inside the polygon the rebuild already fills every pocket opaquely.
    skirt = (cv2.dilate(hood_solid.astype(np.uint8),
                        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (49, 49))).astype(bool)
             & ~hood_solid & cover_up & ~face_open & (master[..., 3] > 8))
    if skirt.any():
        images['hood'][..., :3][skirt] = master[..., :3][skirt]
        images['hood'][..., 3][skirt] = 255
    torso_a = images['torso'][..., 3]
    torso_solid = torso_a >= 250
    skirt_t = (cv2.dilate(torso_solid.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
               & ~torso_solid & (claim['hood'] & (master[..., 3] > 128)))
    if skirt_t.any():
        _d2, (iy2, ix2) = ndimage.distance_transform_edt(~torso_solid, return_indices=True)
        images['torso'][..., :3][skirt_t] = images['torso'][..., :3][iy2[skirt_t], ix2[skirt_t]]
        images['torso'][..., 3][skirt_t] = 255
    print(f'edge skirt: hood {int(skirt.sum())} px, torso {int(skirt_t.sum())} px')

    # the shell band (between the polygon's top edge and the true rim) is
    # shell continuation, not lining: carry the master's own pixels, solid
    # where the fringe covers them at rest, so the fringe's travel exposes
    # shell white instead of zero-alpha pockets
    paint_band = shell_band & (master[..., 3] > 8)
    images['hood'][..., :3][paint_band] = master[..., :3][paint_band]
    solid_band = paint_band & cover_up
    images['hood'][..., 3][solid_band] = 255
    print(f'shell band: {int(paint_band.sum())} px carried, '
          f'{int(solid_band.sum())} px solidified')

    chk = cv2.cvtColor(images['hood'][..., :3], cv2.COLOR_RGB2LAB).astype(int)
    white_sel = (chk[..., 0] > 217) & (
        np.sqrt((chk[..., 1] - 128) ** 2 + (chk[..., 2] - 128) ** 2) < 12)
    skin_sel = (chk[..., 2] >= 133) & (chk[..., 0] >= 185)
    bad_rebuild = int((need & (white_sel | skin_sel)).sum())
    print(f'hood lining rebuild: opening {int(hood_opening.sum())} px, '
          f'rebuilt {int(need.sum())} px, forbidden-content {bad_rebuild} px')

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
    fpaint = fill_zone & ((fimg[..., 3] < 8) | (provenance == 2))
    fimg[..., :3][fpaint] = ffill[fpaint].astype(np.uint8)
    fimg[..., 3][fpaint] = 255
    provenance[fpaint] = 2
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
        'tail': 30, 'leg-L': 40, 'leg-R': 40, 'ear-L': 15, 'ear-R': 15,
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
        # R6-2: enclosed alpha holes inside the ear (the fluff's transparent
        # gaps, round-6 diagnosis 05) get the master's own fluff pixels
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
