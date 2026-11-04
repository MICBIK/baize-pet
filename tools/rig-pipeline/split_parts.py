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
import shutil
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
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
COLLAR_BAND = (300, 468, 580, 545)   # torso collar extension (<=30px + rim)


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
    masks['face'] = (fskin | (white & face_open & ~taken) | (slot_zone & face_open)) & alpha

    # hood: everything head-zone outside the face opening (shell + lining +
    # rim ink), minus what upper head parts already claimed
    masks['hood'] = head_zone & alpha & (ink | amber) & ~face_open

    # arms: sleeve polygon ink; torso: body polygon ink
    masks['arm-L'] = arm_l_zone & alpha & ink & ~taken
    masks['arm-R'] = arm_r_zone & alpha & ink & ~taken
    masks['torso'] = torso_zone & alpha & (ink | amber) & ~taken & ~arm_l_zone & ~arm_r_zone

    # --- exclusive assignment, upper z first --------------------------------
    claim = {k: v.copy() for k, v in masks.items()}
    claim.update({k: v.copy() for k, v in kept.items()})
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
        if pid == 'face':
            # the face carries flat skin under the eye/mouth slots — never a
            # copy of the slot ink above it (removal gate would catch that)
            m = m & ~slot_zone
            img[..., :3][m] = master[..., :3][m]
            img[..., 3][m] = 255
            img[..., :3][slot_zone & claim[pid]] = skin_rgb
            img[..., 3][slot_zone & claim[pid]] = 255
            provenance[slot_zone & claim[pid]] = 2
        else:
            img[..., :3][m] = master[..., :3][m]
            img[..., 3][m] = 255
        images[pid] = img

    def flat(img, m, rgb, tag=1):
        img[..., :3][m] = rgb
        img[..., 3][m] = 255
        provenance[m & (img[..., 3] > 8)] = tag

    def inpaint_band(img, m, radius=5):
        band = (m & alpha).astype(np.uint8) * 255
        src = img.copy()
        src[..., 3][band > 0] = 255
        out = cv2.inpaint(cv2.cvtColor(src, cv2.COLOR_RGBA2BGRA), band, radius, cv2.INPAINT_TELEA)
        ok = m & alpha
        img[..., :3][ok] = cv2.cvtColor(out, cv2.COLOR_BGRA2RGBA)[..., :3][ok]
        img[..., 3][ok] = 255

    # hood: amber lining everywhere the face stack sits (head turns reveal
    # lining, never a face copy). Line the whole face opening.
    lining_zone = face_open & alpha & ~claim['face'] & ~claim['bangs'] & ~claim['hood']
    lining_zone |= face_open & alpha & claim['face'] & ~slot_zone  # under skin/hair
    lining_zone &= ~fskin  # lining never covers real skin (neck/cheeks)
    lining_zone &= alpha
    flat(images['hood'], lining_zone, lining_rgb, tag=2)

    # face: flat skin under the eye/mouth slots
    flat(images['face'], slot_zone & face_open & ~claim['face'], skin_rgb, tag=2)

    # torso: collar band (flat hoodie white) where hood/strings cover it
    collar = np.zeros((H, W), bool)
    collar[COLLAR_BAND[1]:COLLAR_BAND[3], COLLAR_BAND[0]:COLLAR_BAND[2]] = True
    collar &= alpha & ~claim['torso'] & ~claim['hood'] & ~claim['face'] & ~claim['mouth'] & ~claim['blush'] & ~claim['eye-L'] & ~claim['eye-R'] & ~claim['string-L'] & ~claim['string-R']
    torso_rgb = np.median(master[..., :3][claim['torso']], axis=0) if claim['torso'].any() else np.array([250, 250, 250])
    flat(images['torso'], collar, torso_rgb, tag=3)
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

    # hood: an "ear socket" of flat hood white under each ear root — the ear
    # outline pixels belong to the ear part, so swinging the ear would expose
    # a hole at the root; the socket shows the hood surface instead (A4: ear
    # root extends >=15px into the hood, and the hood keeps a surface there)
    for e in ('ear-L', 'ear-R'):
        # the whole ear footprint: at rest the ear (z55) covers it, and when
        # the ear swings the hood surface shows instead of a hole
        flat(images['hood'], claim[e] & alpha & ~claim['hood'], (250, 250, 250), tag=2)

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
