#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Round-6 pack-level QA gates (task book 五): run ON THE EXPORTED PACK
(characters/baize-b3/rig/rig.json + parts/*.png — never parts-ext), with
transforms taken from packages/rig's own solver via pose_dump.mjs (Python
never re-implements parallax or rotation).

P1  static pack restoration  — rest composite vs master (LANCZOS 0.5x)
P2  exposure-band check      — every upper->lower pair, per-pose exposed
                               pixels must look like what the lower layer
                               should carry there
P3  behind-ear hood outline  — ear sweep, outline ink coverage
P4  thin bright lines        — composite-brighter-than-master streaks

All thresholds are constants at the top of this file; none may be tuned to
pass. Results -> demo/rig-art/qa/pack-report.txt (+ pack-diff.png,
exposure-*.png, ear-sweep.png, thin-lines.png).

Usage: demo/rig-art/.venv/bin/python tools/rig-pipeline/qa_pack.py
"""
import json
import os
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
QA = ART / 'qa'
QA.mkdir(parents=True, exist_ok=True)
PACK = ROOT / 'characters/baize-b3'
MASTER = ART / 'master.png'

# --- thresholds (round-6 task book section 5; never tune to pass) -----------
BG = (118, 138, 160)          # composite background (pack native scale)
SCALE = 0.5                   # pack native scale
P1_DIFF = 40                  # per-pixel max-channel diff counted as wrong
P1_TOTAL_MAX = 150            # gate: diff pixels outside the ink band
P1_BLOCK_MAX = 12             # gate: largest connected wrong block (px)
CHEEK_L = (280, 360, 380, 470)   # master px boxes (x0, x1, y0, y1)
CHEEK_R = (480, 560, 360, 450)
CHEEK_BLOCK_MAX = 4           # no connected wrong block >= 4 px inside a box
COVER_A = 0.5                 # "covered" = stacked upper alpha >= 0.5
DE_LINING = 15.0              # dE vs local master lining (hood opening)
DE_WHITE = 10.0               # dE vs local master hood shell white
DE_SKIN = 10.0                # dE vs local master skin / hair (face)
DE_CLOTH = 10.0               # dE vs local master torso cloth white
INK_GRAY = 120                # composite gray below this counts as outline ink
AA_EXEMPT_PX = 2              # isolated AA specks exempt from P2
AA_EXEMPT_RATIO = 0.003       # ... up to 0.3% of the pair's exposed area
P3_RADIUS = 30.0              # pack px (= 60 master px) around ear pivots
P3_INK_REACH = 1.5            # pack px (= 3 master px) ink proximity
P3_COVER_MIN = 0.98           # gate: outlined share of ear-region outline
P3_WHITE_L = 85.0             # bare-white outline pixel: L* above
P3_WHITE_C = 12.0             # ...and chroma below
P4_DIFF = 12                  # composite-brighter-than-master luminance
P4_W_MAX = 2                  # pack px: component short side
P4_L_MIN = 8                  # pack px: component long side
REF_RADIUS = 20                # pack px: "nearby same-material" sample reach;
                               # 12 missed the lining crease's own visible
                               # segments (same tone, along the ring)
TURN_COMBOS = [(tx, ty) for tx in (-1, 0, 1) for ty in (-1, 0, 1)
               if not (tx == 0 and ty == 0)]
EAR_ANGLES = (-20, -10, 6, 12)          # P2 ear poses
EAR_SWEEP_ANGLES = (-20, -10, 0, 6, 12)  # P3 ear sweep
ARM_L_ANGLES = (-15, -10, 10, 15)       # clip range +- the +-15 probe
ARM_R_ANGLES = ((-116, 'wave'), (-25, None), (-15, None), (10, None), (15, None))

# --- round-7 gates (task book 分层角色第7轮修复提示词.md section 四) ---------
# P2 judges the LOWER part's own RGBA at every exposed pixel; P6 audits the
# part PNGs directly; P7 is the extreme-pose contact sheet (manual read);
# P8 keeps the viewer honest vs this composer. All thresholds constant.
COMBO_POSE = ('combo7', {'head.tilt': -12, 'head.turnX': 1,
                         'ear.L.rot': -20, 'ear.R.rot': 12})
EXTREME_POSES = [  # the ten poses of r7-diag/01, same order
    ('rest', {}), ('tiltm12', {'head.tilt': -12}), ('tiltp12', {'head.tilt': 12}),
    ('turnXm', {'head.turnX': -1}), ('turnXp', {'head.turnX': 1}),
    ('turnYm', {'head.turnY': -1}), ('turnYp', {'head.turnY': 1}),
    ('earm20', {'ear.L.rot': -20, 'ear.R.rot': -20}),
    ('earp12', {'ear.L.rot': 12, 'ear.R.rot': 12}),
    ('combo', COMBO_POSE[1]),   # shot file name follows the acceptance script
]
P8_CSS = 1600                 # #pet css size shoot_p8.cjs renders at
P8_BG = (242, 242, 242)       # viewer .bg-white (#f2f2f2)
P8_HEAD_BOX = (150, 60, 720, 548)   # master px region for the mean-abs diff
P8_DIFF_MAX = 6.0             # gate: head-region mean abs diff viewer vs composer
P6_PATCH_MARGIN = 8           # face socket audit ring (R7-3.1)
P6_DARK_MAX = 150             # dark pixel luminance gate (R7-3.1 / D5)
P6_MUD_L = (55.0, 82.0)       # mud band (R7-3.2)
P6_MUD_C = (6.0, 25.0)
P6_MUD_DE = 12.0
P6_AMBER_HUE = (15.0, 50.0)   # HSV degrees, saturation > P6_AMBER_SAT
P6_AMBER_SAT = 0.35
P6_LINING_OUTER = 3           # px beyond HOOD_OPENING where lining must be 0
P6_HAIRCUT_L = 85.0           # hair-white L* inside the opening (R7-2.4)
P6_HAIRCUT_C = 12.0
P6_TE_CLEAR = 3               # third-eye alpha cutoff distance (R7-4.1)
P6_DOME_BOTTOM_Y = 498        # hood dome above, hem trim artwork below
ARC_PROX = 4                  # hood ink allowed within 4 px of hood-own ink

# FACE_OPEN polygon (master px) — the hood opening (from split_parts.py).
FACE_OPEN = [
    (295, 240), (272, 320), (270, 390), (295, 455), (330, 488), (400, 500),
    (470, 500), (545, 483), (580, 450), (600, 385), (598, 315), (575, 250),
]
# Torso cloth region (master px box) for the P2 cloth reference field.
TORSO_BOX = (270, 460, 600, 780)


def load_rgba(p):
    return np.array(Image.open(p).convert('RGBA'))


def fill_holes(mask):
    return ndimage.binary_fill_holes(mask)


def poly_mask_half(shape, pts):
    m = np.zeros(shape[:2], np.uint8)
    half = [(round(x * SCALE), round(y * SCALE)) for x, y in pts]
    cv2.fillPoly(m, [np.array(half, np.int32)], 1)
    return m.astype(bool)


class PackQA:
    def __init__(self):
        self.rig = json.loads((PACK / 'rig' / 'rig.json').read_text(encoding='utf-8'))
        self.master_full = load_rgba(MASTER)
        mw = round(self.rig['master']['width'] * SCALE)
        mh = round(self.rig['master']['height'] * SCALE)
        self.size = (mw, mh)
        # master composited over the pack background at half scale
        half = Image.fromarray(self.master_full).resize((mw, mh), Image.LANCZOS)
        half = np.array(half)
        a = half[..., 3:4].astype(np.float32) / 255.0
        self.master_rgb = (half[..., :3] * a + np.array(BG, np.float32) * (1 - a)).astype(np.uint8)
        self.master_a = half[..., 3]
        # P1/P4 exclusion band: dark ink + ALPHA contour (the silhouette edge,
        # not every internal stroke), 5x5 dilated
        gray = cv2.cvtColor(self.master_rgb, cv2.COLOR_RGB2GRAY)
        ink = (gray < 110).astype(np.uint8)
        alpha_edge = cv2.Canny((self.master_a > 128).astype(np.uint8) * 255, 40, 120)
        band = cv2.dilate(ink | alpha_edge, np.ones((5, 5), np.uint8))
        self.band = band > 0
        self.opening = self._load_opening()
        self._imgs = {}
        self._warp_cache = {}
        self.build_claim_fields()

    def _load_opening(self):
        """HOOD_OPENING at pack scale. Round 7: the ink-bounded mask the
        split pipeline saves (qa/hood-opening.png, master px); the round-6
        polygon stays only as a fallback when the file is missing."""
        path = ART / 'qa' / 'hood-opening.png'
        if path.exists():
            m = np.array(Image.open(path).convert('L')) > 127
            return cv2.resize(m.astype(np.float32), self.size,
                              interpolation=cv2.INTER_AREA) > 0.01
        return poly_mask_half((self.size[1], self.size[0]), FACE_OPEN)

    def build_claim_fields(self):
        """Master-scale part claims (parts-ext alpha>8) downscaled to pack
        space, and the two ink allowances of the P2 validators:
        - face_ink_ok: master brow/lash ink outside the eye/mouth patch
          claims (R7-3.1 exception),
        - hood_ink_ok: the hood's OWN master ink (dome outline, hem trim,
          rim stroke) — never ink inside ear/horn/eye claims, which can only
          be hidden copies (round-7 D4)."""
        master_gray = cv2.cvtColor(self.master_rgb, cv2.COLOR_RGB2GRAY)
        ink = master_gray < 110
        claims = {}
        for pid in ('ear-L', 'ear-R', 'horn-L', 'horn-R', 'third-eye',
                    'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'face', 'bangs'):
            p = ART / 'parts-ext' / f'{pid}.png'
            if not p.exists():
                continue
            a = np.array(Image.open(p).convert('RGBA'))[..., 3]
            claims[pid] = cv2.resize((a > 8).astype(np.float32), self.size,
                                     interpolation=cv2.INTER_AREA) > 0.01

        def dil(m, r):
            return cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))).astype(bool)

        patch_union = np.zeros_like(ink)
        hood_other = np.zeros_like(ink)
        for pid, m in claims.items():
            if pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
                patch_union |= m
            if pid in ('ear-L', 'ear-R', 'horn-L', 'horn-R', 'third-eye',
                       'eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth', 'bangs'):
                hood_other |= m
        self.face_ink_ok = dil(ink & ~dil(patch_union, 2), 2)
        self.hood_ink_ok = dil(ink & ~dil(hood_other, 2), ARC_PROX // 2)

    # --- parts & poses ------------------------------------------------------
    def part_img(self, rel):
        if rel not in self._imgs:
            self._imgs[rel] = load_rgba(PACK / 'rig' / rel)
        return self._imgs[rel]

    def dump_poses(self, poses):
        self.poses_json = poses
        pj = QA / 'pack-poses.json'
        dj = QA / 'pack-poses-dump.json'
        pj.write_text(json.dumps(poses))
        subprocess.run(
            ['node', str(ROOT / 'tools/rig-pipeline/pose_dump.mjs'),
             '--rig', 'characters/baize-b3/rig/rig.json',
             '--poses', str(pj.relative_to(ROOT)), '--out', str(dj.relative_to(ROOT))],
            cwd=ROOT, check=True, capture_output=True, text=True)
        dump = json.loads(dj.read_text(encoding='utf-8'))
        self.dump = {p['name']: p['parts'] for p in dump['poses']}
        return self.dump

    def warp(self, pose_name, idx):
        """One part rendered at pack scale under the solver's transform."""
        key = (pose_name, idx)
        if key in self._warp_cache:
            return self._warp_cache[key]
        p = self.dump[pose_name][idx]
        img = self.part_img(p['image'])
        if p.get('mirrored'):
            img = img[:, ::-1].copy()
        th = np.deg2rad(p['rotDeg'])
        c, s = np.cos(th), np.sin(th)
        R = np.array([[c, -s], [s, c]])          # canvas rotate matrix (y-down)
        S = np.array([[p['scaleX'], 0.0], [0.0, p['scaleY']]])
        rest = np.array([p['restX'], p['restY']], np.float64)
        pv = np.array(p['pivot'], np.float64)
        sp = np.array(p['scalePivot'], np.float64)
        d = np.array([p['dx'], p['dy']], np.float64)
        # master space: q = S(R(p - pv) + pv + d - sp) + sp, p = rest + 2(u, v)
        # pack space:  dst = 0.5 q  ->  L = S R, t = 0.5 (S(R(rest-pv)+pv+d-sp)+sp)
        L = S @ R
        t = 0.5 * (S @ (R @ (rest - pv) + pv + d - sp) + sp)
        M = np.float32([[L[0, 0], L[0, 1], t[0]], [L[1, 0], L[1, 1], t[1]]])
        h, w = self.size[1], self.size[0]
        out = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR,
                             borderValue=(0, 0, 0, 0))
        self._warp_cache[key] = out
        return out

    def compose(self, pose_name, bg=None):
        """Composite one pose over BG (or an explicit background). Returns
        rgb uint8, alpha f32, owner i32."""
        h, w = self.size[1], self.size[0]
        rgb = np.zeros((h, w, 3), np.float32)
        rgb[..., 0], rgb[..., 1], rgb[..., 2] = bg if bg is not None else BG
        alpha = np.zeros((h, w), np.float32)
        owner = np.full((h, w), -1, np.int32)
        for idx, p in enumerate(self.dump[pose_name]):
            if p['opacity'] <= 0:
                continue
            wr = self.warp(pose_name, idx)
            a = wr[..., 3].astype(np.float32) / 255.0
            m = a > 0
            rgb[m] = wr[..., :3][m].astype(np.float32) * a[m, None] + rgb[m] * (1 - a[m, None])
            alpha = a + alpha * (1 - a)
            owner[a >= 0.5] = idx
        return rgb.clip(0, 255).astype(np.uint8), alpha, owner

    # --- P1 -----------------------------------------------------------------
    def p1(self, rest):
        comp_rgb, comp_a, _ = rest
        diff = np.abs(comp_rgb.astype(np.int16) - self.master_rgb.astype(np.int16)).max(axis=2)
        bad = (diff > P1_DIFF) & ~self.band
        lbl, n = ndimage.label(bad)
        sizes = ndimage.sum(bad, lbl, range(1, n + 1)).astype(int) if n else np.array([0])
        worst = int(sizes.max()) if n else 0
        vis = self.master_rgb.copy()
        vis[bad] = (255, 0, 255)
        Image.fromarray(vis).save(QA / 'pack-diff.png')
        res = {'total': int(bad.sum()), 'blocks': int(n), 'worst_block': worst}
        for name, box in (('left', CHEEK_L), ('right', CHEEK_R)):
            x0, x1, y0, y1 = [round(v * SCALE) for v in box]
            sub = bad[y0:y1, x0:x1]
            slbl, sn = ndimage.label(sub)
            ssizes = ndimage.sum(sub, slbl, range(1, sn + 1)).astype(int) if sn else np.array([])
            res[f'{name}_box_px'] = int(sub.sum())
            res[f'{name}_box_blocks'] = int(sn)
            res[f'{name}_box_worst'] = int(ssizes.max()) if sn else 0
            res[f'{name}_box_ge4'] = int((ssizes >= CHEEK_BLOCK_MAX).sum()) if sn else 0
        return res

    # --- material reference (P2): min dE over nearby same-material master ----
    def _lab(self, rgb_u8):
        return cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2LAB).astype(np.float32)

    def build_fields(self):
        mlab = self._lab(self.master_rgb)
        L, A, B = mlab[..., 0], mlab[..., 1], mlab[..., 2]
        opa = self.master_a > 128
        # cv2 8-bit LAB: a/b are OFFSET by +128, not scaled — chroma must
        # subtract the offset (the missing -128 emptied white/hair and made
        # "lining" match every warm pixel incl. skin)
        chroma = np.sqrt((A - 128) ** 2 + (B - 128) ** 2)
        lining = (A > 135) & (B > 170) & opa
        white = (L > P3_WHITE_L * 2.55) & (chroma < P3_WHITE_C) & opa
        skin = (B >= 133) & (L >= 185) & opa
        # hair incl. its shaded strands: neutral tone, no lining amber
        hair = (L > 170) & (chroma < 16) & opa
        tx = np.zeros_like(opa)
        x0, y0, x1, y1 = TORSO_BOX
        tx[round(y0 * SCALE):round(y1 * SCALE), round(x0 * SCALE):round(x1 * SCALE)] = True
        # torso cloth incl. its grey shadows (white-only missed shaded folds
        # and flagged the collar's own shading as non-cloth)
        cloth = opa & tx & (L > 130) & (chroma < 25)
        self.master_lab = self._lab(self.master_rgb)
        self.sel_lining = lining
        self.sel_white = white
        self.sel_skin = skin
        self.sel_hair = hair
        self.sel_cloth = cloth

    def _min_de(self, comp_lab, sel):
        """Per-pixel dE(composite, master) minimised over the same-material
        master pixels within REF_RADIUS — the faithful reading of the task
        book's "dE vs nearby same-material colour". A blurred field mixed
        the lining's light and crease tones and flagged correct content."""
        de = np.sqrt(((comp_lab - self.master_lab) ** 2).sum(axis=2))
        de = np.where(sel, de, 1e4).astype(np.float32)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * REF_RADIUS + 1, 2 * REF_RADIUS + 1))
        return cv2.erode(de, k)

    # --- P2 (round-7 rewrite): audit the LOWER part's own RGBA ---------------
    # Round 6 judged the composite colour, so a lower layer hiding copies of
    # upper artwork passed whenever the copies looked plausible. Round 7
    # reads the lower part's own pixel at every exposed position instead
    # (task book section 四 P2 table); the torso rows stay composite-based
    # ("同第 6 轮").
    def _pose_set(self, *groups):
        turn_names = [f'turn{tx}{ty}' for tx, ty in TURN_COMBOS]
        tilt12 = ['tiltp12', 'tiltm12']
        ear_poses = [f'ear{v}tx{tx}' for v in EAR_ANGLES for tx in (-1, 1)]
        sets = {
            'head': turn_names + tilt12 + [COMBO_POSE[0]],
            'ear': ear_poses + [COMBO_POSE[0]],
            'arm_l': [f'armL{v}' for v in ARM_L_ANGLES],
            'arm_r': [f'armR{v}' for v, _ in ARM_R_ANGLES],
            'string_l': ['stringLm25', 'stringLp25'],
            'string_r': ['stringRm25', 'stringRp25'],
            'tilt18': ['tilt18p', 'tilt18m'],
            'turn_y': ['turnYm1', 'turnYp1'],
        }
        return sum((sets[g] for g in groups), [])

    def _dump_index(self, pose, pid):
        ids = [p['id'] for p in self.dump[pose]]
        return ids.index(pid) if pid in ids else None

    def _hood_stack(self, pose):
        """Warped RGBA stacks of the hood back and (post-split) front layers."""
        bi = self._dump_index(pose, 'hood')
        fi = self._dump_index(pose, 'hood-front')
        back = self.warp(pose, bi) if bi is not None else None
        front = self.warp(pose, fi) if fi is not None else None
        return back, front

    def _hood_own(self, pose):
        """Top-most hood layer's own RGBA at every pack pixel: the front
        layer (z 85) above the back (z 50); transparent where neither has
        content."""
        back, front = self._hood_stack(pose)
        if front is None:
            return back
        fa = front[..., 3:4].astype(np.float32) / 255.0
        own = back.copy()
        m = (fa[..., 0] >= COVER_A)[..., None]
        own = np.where(m, front, own)
        return own

    def _expose(self, pose, upper_rest_i, upper_i, lower_wraps):
        """Exposed band of one pair in one pose + the lower's closed
        silhouette (round-6 semantics, kept verbatim)."""
        covered_rest = self.warp('rest', upper_rest_i)[..., 3] >= int(COVER_A * 255)
        covered_pose = self.warp(pose, upper_i)[..., 3] >= int(COVER_A * 255)
        exposed = covered_rest & ~covered_pose
        stack = lower_wraps[0][..., 3].astype(np.float32)
        for w in lower_wraps[1:]:
            stack = np.maximum(stack, w[..., 3].astype(np.float32))
        stack = stack / 255.0
        sil = fill_holes(stack > 32 / 255.0)
        sil &= cv2.erode(sil.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) \
            | (stack >= COVER_A)
        return exposed & sil

    def _validator_fields(self, own_rgb):
        """LAB / gray / chroma / min-dE fields for one lower part's own pixels."""
        lab = self._lab(own_rgb)
        gray = cv2.cvtColor(own_rgb, cv2.COLOR_RGB2GRAY)
        chroma = np.sqrt((lab[..., 1] - 128) ** 2 + (lab[..., 2] - 128) ** 2)
        return {
            'lab': lab, 'gray': gray, 'chroma': chroma,
            'de_l': self._min_de(lab, self.sel_lining),
            'de_w': self._min_de(lab, self.sel_white),
            'de_s': self._min_de(lab, self.sel_skin),
            'de_h': self._min_de(lab, self.sel_hair),
        }

    def _viol_hair_skin(self, f):
        """bangs->face: face's own pixel must be hair or skin (R7-3.2 dE);
        lining colour, transparent, mud and ink are violations (master brow /
        lash ink outside the patch claims is allowed, R7-3.1 exception)."""
        hair_ok = f['de_h'] <= 12.0
        skin_ok = f['de_s'] <= 10.0
        lining = (f['lab'][..., 1] > 135) & (f['lab'][..., 2] > 170)
        mud = ((f['lab'][..., 0] >= P6_MUD_L[0] * 2.55)
               & (f['lab'][..., 0] <= P6_MUD_L[1] * 2.55)
               & (f['chroma'] >= P6_MUD_C[0]) & (f['chroma'] <= P6_MUD_C[1])
               & (f['de_h'] > P6_MUD_DE) & (f['de_s'] > P6_MUD_DE))
        return (f['a'] < 128) | lining | mud | (f['ink'] & ~self.face_ink_ok) \
            | ~(hair_ok | skin_ok | (f['ink'] & self.face_ink_ok))

    def _viol_skin_bright(self, f):
        """eye/iris/mouth patch -> face: skin dE<=10, luminance>=150; any dark
        pixel or transparency is a violation (R7-3.1)."""
        return (f['a'] < 128) | (f['gray'] < P6_DARK_MAX) | (f['de_s'] > DE_SKIN)

    def _viol_hood_exposure(self, f, opening):
        """face -> hood layers. Inside the opening: lining dE<=15, hair-white
        and ink are violations. Outside: hood white dE<=10 or the hood's own
        (dome/hem) master ink."""
        inside = opening
        lining_ok = f['de_l'] <= DE_LINING
        hairwhite = (f['lab'][..., 0] > P6_HAIRCUT_L * 2.55) & (f['chroma'] < P6_HAIRCUT_C)
        in_viol = (f['a'] < 128) | ~lining_ok | hairwhite | (f['ink'] & ~self.hood_ink_ok)
        out_viol = (f['a'] < 128) | ((f['de_w'] > DE_WHITE) & ~(f['ink'] & self.hood_ink_ok))
        return np.where(inside, in_viol, out_viol).astype(bool)

    def _viol_hood_white(self, f, dark_gate=False):
        """ear/horn/third-eye -> hood layers: hood white dE<=10 or the hood's
        own ink; ear/horn rows flag any other ink (copy outlines), the
        third-eye row flags ANY dark pixel (D5 socket line)."""
        white_ok = f['de_w'] <= DE_WHITE
        ink_ok = f['ink'] & self.hood_ink_ok
        viol = (f['a'] < 128) | ~(white_ok | ink_ok)
        if dark_gate:
            viol |= f['gray'] < P6_DARK_MAX
        return viol

    def _viol_front_over(self, f):
        """hood-front -> face/bangs: violations are transparency and lining
        colour (the exposed band is the face/bangs hair extension)."""
        lining = (f['lab'][..., 1] > 135) & (f['lab'][..., 2] > 170)
        return (f['a'] < 128) | lining

    def _viol_cloth(self, comp, comp_alpha, exposed):
        """arm/string/hood -> torso: same judgement as round 6 (composite
        colour against the torso cloth field)."""
        comp_lab = self._lab(comp)
        de_c = self._min_de(comp_lab, self.sel_cloth)
        gray = cv2.cvtColor(comp, cv2.COLOR_RGB2GRAY)
        ink = gray < INK_GRAY
        trans = exposed & (comp_alpha < COVER_A)
        return exposed & (trans | ((de_c > DE_CLOTH) & ~ink))

    def p2(self, rest):
        spec = [
            ('bangs', 'face', self._pose_set('head'), 'hair_skin', False),
            ('eye-L', 'face', self._pose_set('head'), 'skin_bright', False),
            ('eye-R', 'face', self._pose_set('head'), 'skin_bright', False),
            ('iris-L', 'face', self._pose_set('head'), 'skin_bright', False),
            ('iris-R', 'face', self._pose_set('head'), 'skin_bright', False),
            ('mouth', 'face', self._pose_set('head'), 'skin_bright', False),
            ('face', 'hood', self._pose_set('head'), 'hood_exposure', False),
            ('hood-front', 'face', self._pose_set('head'), 'front_over', False),
            ('hood-front', 'bangs', self._pose_set('head'), 'front_over', False),
            ('ear-L', 'hood', self._pose_set('ear'), 'hood_white', False),
            ('ear-R', 'hood', self._pose_set('ear'), 'hood_white', False),
            ('horn-L', 'hood', self._pose_set('head'), 'hood_white', False),
            ('horn-R', 'hood', self._pose_set('head'), 'hood_white', False),
            ('third-eye', 'hood', self._pose_set('head'), 'hood_white', True),
            ('arm-L', 'torso', self._pose_set('arm_l'), 'cloth', False),
            ('arm-R', 'torso', self._pose_set('arm_r'), 'cloth', False),
            ('string-L', 'torso', self._pose_set('string_l'), 'cloth', False),
            ('string-R', 'torso', self._pose_set('string_r'), 'cloth', False),
            ('hood', 'torso', self._pose_set('tilt18', 'turn_y'), 'cloth', False),
        ]
        comp_cache = {}
        for pose in set(sum([s[2] for s in spec], [])) | {'rest'}:
            comp_cache[pose] = self.compose(pose)

        report = []
        for upper, lower, pose_names, kind, dark_gate in spec:
            ui_rest = self._dump_index('rest', upper)
            if ui_rest is None:
                report.append({
                    'pair': f'{upper}->{lower}', 'poses': len(pose_names),
                    'exposed': 0, 'violations': 0, 'exempt': 0, 'over_cap': 0,
                    'worst_pose': 'N/A (part absent)', 'worst_pose_viol': 0,
                })
                continue
            worst_pose, worst_px = '', -1
            total_exposed, total_exempt = 0, 0
            total_viol = 0
            tiles = []
            for pose in pose_names:
                ui = self._dump_index(pose, upper)
                if ui is None:
                    continue
                lower_wraps = []
                if lower == 'hood':
                    back, front = self._hood_stack(pose)
                    if back is None:
                        continue
                    lower_wraps = [w for w in (back, front) if w is not None]
                else:
                    li = self._dump_index(pose, lower)
                    if li is None:
                        continue
                    lower_wraps = [self.warp(pose, li)]
                exposed = self._expose(pose, ui_rest, ui, lower_wraps)
                if not exposed.any():
                    continue
                if kind == 'cloth':
                    comp, comp_alpha, _ = comp_cache[pose]
                    viol = self._viol_cloth(comp, comp_alpha, exposed)
                else:
                    if lower == 'hood':
                        own = self._hood_own(pose)
                    else:
                        own = lower_wraps[0]
                    f = self._validator_fields(own[..., :3].astype(np.uint8))
                    f['a'] = own[..., 3]
                    f['ink'] = f['gray'] < INK_GRAY
                    if kind == 'hood_exposure':
                        v = self._viol_hood_exposure(f, self.opening)
                    elif kind == 'hood_white':
                        v = self._viol_hood_white(f, dark_gate)
                    elif kind == 'front_over':
                        v = self._viol_front_over(f)
                    elif kind == 'skin_bright':
                        v = self._viol_skin_bright(f)
                    else:
                        v = self._viol_hair_skin(f)
                    viol = exposed & v
                # AA exemption: isolated <=2 px components, up to the ratio cap
                lbl, n = ndimage.label(viol)
                if n:
                    sizes = ndimage.sum(viol, lbl, range(1, n + 1)).astype(int)
                    small = np.isin(lbl, np.where(sizes <= AA_EXEMPT_PX)[0] + 1)
                    exempt = int(small.sum())
                    viol = viol & ~small
                else:
                    exempt = 0
                total_exposed += int(exposed.sum())
                total_exempt += exempt
                total_viol += int(viol.sum())
                if int(viol.sum()) > worst_px:
                    worst_px = int(viol.sum())
                    worst_pose = pose
                comp, _, _ = comp_cache[pose]
                tiles.append((pose, comp.copy(), exposed.copy(), viol.copy()))
            # ratio cap: exempt beyond 0.3% of exposed area count as violations
            over = max(0, total_exempt - int(AA_EXEMPT_RATIO * total_exposed))
            total_viol += over
            report.append({
                'pair': f'{upper}->{lower}', 'poses': len(pose_names),
                'exposed': total_exposed, 'violations': total_viol,
                'exempt': total_exempt, 'over_cap': over,
                'worst_pose': worst_pose, 'worst_pose_viol': worst_px,
            })
            self._exposure_sheet(upper, lower, tiles)
        return report

    def _exposure_sheet(self, upper, lower, tiles):
        if not tiles:
            return
        tw = 240
        cols = min(5, len(tiles))
        rows = (len(tiles) + cols - 1) // cols
        h, w = self.size[1], self.size[0]
        th = round(tw * h / w)
        sheet = Image.new('RGB', (cols * tw, rows * (th + 14)), (255, 255, 255))
        from PIL import ImageDraw
        d = ImageDraw.Draw(sheet)
        for i, (pose, comp, exposed, viol) in enumerate(tiles):
            vis = comp.copy()
            vis[exposed & ~viol] = (255, 235, 140)
            vis[viol] = (255, 0, 255)
            im = Image.fromarray(vis).resize((tw, th), Image.LANCZOS)
            x, y = (i % cols) * tw, (i // cols) * (th + 14)
            sheet.paste(im, (x, y + 14))
            d.text((x + 4, y + 2), f'{pose} viol={int(viol.sum())}', fill=(0, 0, 0))
        sheet.save(QA / f'exposure-{upper}-{lower}.png')

    # --- P3 ------------------------------------------------------------------
    def p3(self):
        pivots = {}
        for p in self.rig['parts']:
            if p['id'] in ('ear-L', 'ear-R'):
                pivots[p['id']] = np.array(p['pivot'], np.float64)
        tiles, results = [], {}
        h, w = self.size[1], self.size[0]
        for v in EAR_SWEEP_ANGLES:
            for tx in (-1, 0, 1):
                name = f'sw{v}_{tx}'
                comp, alpha, _ = self.compose(name)
                outline = fill_holes(alpha > 32 / 255.0)
                outline = outline & ~cv2.erode(outline.astype(np.uint8),
                                               np.ones((3, 3), np.uint8)).astype(bool)
                zone = np.zeros((h, w), bool)
                gray = cv2.cvtColor(comp, cv2.COLOR_RGB2GRAY)
                ink = gray < 100
                ink_d = cv2.distanceTransform((~ink).astype(np.uint8), cv2.DIST_L2, 3)
                lab = self._lab(comp)
                L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]
                whiteish = (L > P3_WHITE_L * 2.55) & (np.sqrt(A ** 2 + B ** 2) < P3_WHITE_C)
                cov_n, white_n, tot = 0, 0, 0
                for eid, pv in pivots.items():
                    part = next(p for p in self.dump[name] if p['id'] == eid)
                    c = (np.array([pv[0] + part['dx'], pv[1] + part['dy']]) * SCALE)
                    yy, xx = np.mgrid[0:h, 0:w]
                    near = (xx - c[0]) ** 2 + (yy - c[1]) ** 2 <= P3_RADIUS ** 2
                    sel = outline & near
                    tot += int(sel.sum())
                    cov_n += int((sel & (ink_d <= P3_INK_REACH)).sum())
                    white_n += int((sel & ~(ink_d <= P3_INK_REACH) & whiteish).sum())
                cov = cov_n / max(1, tot)
                results[name] = (round(cov, 4), tot, cov_n, white_n)
                thumb = Image.fromarray(comp).resize((200, round(200 * h / w)), Image.LANCZOS)
                tiles.append((f'{name} cov={cov:.3f} bareW={white_n}', thumb))
        cols, rows = 3, 5
        tw, th = tiles[0][1].size
        sheet = Image.new('RGB', (cols * tw, rows * (th + 16)), (255, 255, 255))
        from PIL import ImageDraw
        d = ImageDraw.Draw(sheet)
        for i, (label, t) in enumerate(tiles):
            x, y = (i % cols) * tw, (i // cols) * (th + 16)
            sheet.paste(t, (x, y + 16))
            d.text((x + 4, y + 2), label, fill=(0, 0, 0))
        sheet.save(QA / 'ear-sweep.png')
        return results

    # --- P4 ------------------------------------------------------------------
    def p4(self, rest):
        comp_rgb, _, owner = rest
        comp_gray = cv2.cvtColor(comp_rgb, cv2.COLOR_RGB2GRAY).astype(np.int16)
        master_gray = cv2.cvtColor(self.master_rgb, cv2.COLOR_RGB2GRAY).astype(np.int16)
        diff = comp_gray - master_gray
        cand = (diff > P4_DIFF) & ~self.band
        ids = [p['id'] for p in self.dump['rest']]
        region = np.isin(owner, [i for i, pid in enumerate(ids) if pid in ('hood', 'bangs', 'face')])
        cand &= region
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(cand.astype(np.uint8), connectivity=8)
        lines = []
        vis = comp_rgb.copy()
        for i in range(1, n):
            ys, xs = np.where(lbl == i)
            pts = np.column_stack([xs, ys]).astype(np.float32)
            (cx, cy), (rw, rh), ang = cv2.minAreaRect(pts)
            short, long = sorted([rw, rh])
            area = len(xs)
            skel_len = area / max(short, 1.0)  # curved-line length proxy
            if short <= P4_W_MAX and area >= P4_L_MIN and (
                    long >= P4_L_MIN or skel_len >= P4_L_MIN):
                lines.append({
                    'i': len(lines) + 1, 'px': area,
                    'center': (round(float(cx), 1), round(float(cy), 1)),
                    'pack_px_box': (round(short, 2), round(long, 2)),
                    'master_px_box': (round(short * 2, 1), round(long * 2, 1)),
                    'owner': ids[int(owner[ys[0], xs[0]])] if owner[ys[0], xs[0]] >= 0 else '?',
                })
                cv2.circle(vis, (int(cx), int(cy)), 9, (255, 0, 255), 2)
        # number labels
        im = Image.fromarray(vis)
        from PIL import ImageDraw
        d = ImageDraw.Draw(im)
        for ln in lines:
            d.text((ln['center'][0] + 6, ln['center'][1] - 6), str(ln['i']), fill=(255, 0, 255))
        im.save(QA / 'thin-lines.png')
        return lines

    # --- P6 (round 7): part material audit ------------------------------------
    # No poses: the pipeline's own master-scale part PNGs are audited directly
    # (parts-ext is the source of truth the pack crops/resamples from).
    def p6(self):
        ext = ART / 'parts-ext'
        patches = ART / 'patches'
        master = self.master_full
        H, W = master.shape[:2]
        lines = []

        def load(p):
            return np.array(Image.open(p).convert('RGBA'))

        def dil(m, r):
            return cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))).astype(bool)

        def mark(name, img, viol):
            vis = img[..., :3].copy()
            al = img[..., 3:4].astype(np.float32) / 255.0
            vis = (vis * al + np.array([242, 242, 242]) * (1 - al)).astype(np.uint8)
            vis[viol] = (255, 0, 255)
            Image.fromarray(vis).save(QA / f'material-{name}.png')

        # --- hood (back layer) ------------------------------------------------
        hood_path = ext / 'hood.png'
        if hood_path.exists():
            hood = load(hood_path)
            h_a = hood[..., 3] > 8
            hsv = cv2.cvtColor(hood[..., :3], cv2.COLOR_RGB2HSV).astype(np.float32)
            hue_deg = hsv[..., 0] * 2.0
            sat = hsv[..., 1] / 255.0
            amber = ((hue_deg >= P6_AMBER_HUE[0]) & (hue_deg <= P6_AMBER_HUE[1])
                     & (sat > P6_AMBER_SAT) & h_a)
            ear_cov = np.zeros((H, W), bool)
            horn_cov = np.zeros((H, W), bool)
            for pid, acc in (('ear-L', ear_cov), ('ear-R', ear_cov),
                             ('horn-L', horn_cov), ('horn-R', horn_cov)):
                p = ext / f'{pid}.png'
                if p.exists():
                    acc |= load(p)[..., 3] > 8
            amber_cov = int((amber & (ear_cov | horn_cov)).sum())
            mark('hood-amber-coverage', hood, amber & (ear_cov | horn_cov))
            lab = cv2.cvtColor(hood[..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
            L8 = lab[..., 0]
            chroma = np.sqrt((lab[..., 1] - 128) ** 2 + (lab[..., 2] - 128) ** 2)
            opening = np.array(Image.open(QA / 'hood-opening.png').convert('L')) > 127 \
                if (QA / 'hood-opening.png').exists() else np.zeros((H, W), bool)
            hairwhite = ((L8 > P6_HAIRCUT_L * 2.55) & (chroma < P6_HAIRCUT_C) & h_a)
            hw_open = int((hairwhite & opening).sum())
            mark('hood-hairwhite-opening', hood, hairwhite & opening)
            strict_amber = (lab[..., 1] > 135) & (lab[..., 2] > 170) & h_a
            # post-split the BACK layer owns no visible-at-rest artwork, so
            # the lining-outside check runs on its whole domain; on the
            # unsplit round-6 hood the check stays on the dome (above the
            # hem trim artwork, which is the hood front's payload).
            dome = np.ones((H, W), bool)
            if not (ext / 'hood-front.png').exists():
                dome[:P6_DOME_BOTTOM_Y] = False
            lining_out = strict_amber & ~dil(opening, P6_LINING_OUTER) & dome
            lining_out_px = int(lining_out.sum())
            mark('hood-lining-outside', hood, lining_out)
            lines.append(f'P6 hood: amber-in-ear/horn-coverage={amber_cov} (gate 0), '
                         f'hairwhite-in-opening={hw_open} (gate 0), '
                         f'lining-outside-opening={lining_out_px} (gate 0)')
            front_path = ext / 'hood-front.png'
            if front_path.exists():
                front = load(front_path)
                f_a = front[..., 3] > 8
                fhsv = cv2.cvtColor(front[..., :3], cv2.COLOR_RGB2HSV).astype(np.float32)
                fhue = fhsv[..., 0] * 2.0
                fsat = fhsv[..., 1] / 255.0
                famber = ((fhue >= P6_AMBER_HUE[0]) & (fhue <= P6_AMBER_HUE[1])
                          & (fsat > P6_AMBER_SAT) & f_a)
                famber_cov = int((famber & (ear_cov | horn_cov)).sum())
                mark('hood-front-amber-coverage', front, famber & (ear_cov | horn_cov))
                lines.append(f'P6 hood-front: amber-in-ear/horn-coverage={famber_cov} (gate 0)')

        # --- face ---------------------------------------------------------------
        face_path = ext / 'face.png'
        if face_path.exists():
            face = load(face_path)
            f_a = face[..., 3] > 8
            gray = cv2.cvtColor(face[..., :3], cv2.COLOR_RGB2GRAY)
            m_gray = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2GRAY)
            m_dark = m_gray < 110
            patch_cov = np.zeros((H, W), bool)
            for pid in ('eye-L', 'eye-R', 'iris-L', 'iris-R', 'mouth'):
                p = ext / f'{pid}.png'
                if p.exists():
                    patch_cov |= load(p)[..., 3] > 8
            zone = dil(patch_cov, P6_PATCH_MARGIN)
            allowed = m_dark & ~dil(patch_cov, 2)
            dark_viol = (gray < P6_DARK_MAX) & zone & f_a & ~allowed
            mark('face-socket-dark', face, dark_viol)
            bangs_cov = np.zeros((H, W), bool)
            if (ext / 'bangs.png').exists():
                bangs_cov = load(ext / 'bangs.png')[..., 3] > 8
            flab = cv2.cvtColor(face[..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
            fL = flab[..., 0] / 2.55
            fC = np.sqrt((flab[..., 1] - 128) ** 2 + (flab[..., 2] - 128) ** 2)
            mlab = self._lab(self.master_rgb)
            # median colours of the master's visible hair / skin selectors
            hair_med = np.median(self.master_rgb[self.sel_hair], axis=0) \
                if self.sel_hair.any() else np.array([235, 233, 231])
            skin_med = np.median(self.master_rgb[self.sel_skin], axis=0) \
                if self.sel_skin.any() else np.array([248, 229, 215])

            def de(rgb_med):
                m = np.array(rgb_med, np.float32).reshape(1, 1, 3)
                ml = cv2.cvtColor(m, cv2.COLOR_RGB2LAB).astype(np.float32)
                return np.sqrt(((flab - ml) ** 2).sum(axis=2))

            mud = ((fL >= P6_MUD_L[0]) & (fL <= P6_MUD_L[1])
                   & (fC >= P6_MUD_C[0]) & (fC <= P6_MUD_C[1])
                   & (de(hair_med) > P6_MUD_DE) & (de(skin_med) > P6_MUD_DE)
                   & f_a & bangs_cov)
            mark('face-mud-under-bangs', face, mud)
            lines.append(f'P6 face: dark-in-socket-ring={int(dark_viol.sum())} (gate 0), '
                         f'mud-under-bangs={int(mud.sum())} (gate 0)')

        # --- third-eye* -----------------------------------------------------
        for name, path in (('third-eye', ext / 'third-eye.png'),
                           ('third-eye-half', patches / 'third-eye-half.png'),
                           ('third-eye-open', patches / 'third-eye-open.png')):
            if not path.exists():
                continue
            img = load(path)
            a = img[..., 3]
            contour = ndimage.binary_fill_holes(a > 128)
            dist = cv2.distanceTransform((~contour).astype(np.uint8), cv2.DIST_L2, 3)
            viol = (~contour) & (dist >= P6_TE_CLEAR) & (a > 0)
            mark(name, img, viol)
            lines.append(f'P6 {name}: opaque-outside-contour(>={P6_TE_CLEAR}px)='
                         f'{int(viol.sum())} (gate 0)')
        return lines

    # --- P7 (round 7): extreme-pose contact sheet, manual read -----------------
    def p7(self):
        shooter = ROOT / 'tools/rig-pipeline/shoot_extreme_poses.cjs'
        out = []
        from PIL import ImageDraw
        for bg, tag in (('white', ''), ('black', '-dark')):
            shots = QA / f'p7-shots{tag}'
            if shooter.exists():
                r = subprocess.run(['node', str(shooter), str(shots), '--bg', bg],
                                   cwd=ROOT, capture_output=True, text=True, timeout=240)
                if r.returncode != 0:
                    out.append(f'P7 {bg}: shoot FAILED '
                               f'{(r.stderr or r.stdout).strip()[:160]}')
                    continue
            files = {p.stem: p for p in sorted(shots.glob('*.png'))} if shots.exists() else {}
            if not files:
                out.append(f'P7 {bg}: SKIPPED (viewer shots unavailable)')
                continue
            order = [n for n, _ in EXTREME_POSES if n in files]
            tw = 340
            th = round(tw * 520 / 640)
            cols = 4
            rows = (len(order) + cols - 1) // cols
            sheet = Image.new('RGB', (cols * tw, rows * (th + 16)), (255, 255, 255))
            d = ImageDraw.Draw(sheet)
            for i, name in enumerate(order):
                im = Image.open(files[name]).resize((tw, th), Image.LANCZOS)
                x, y = (i % cols) * tw, (i // cols) * (th + 16)
                sheet.paste(im, (x, y + 16))
                d.text((x + 4, y + 2), name, fill=(180, 0, 0))
            sheet.save(QA / f'extreme-poses{tag}.png')
            out.append(f'P7 {bg}: {len(order)} poses -> qa/extreme-poses{tag}.png '
                       '(manual read required)')
        return out

    # --- P8 (round 7): viewer vs composer consistency ---------------------------
    def p8(self):
        shooter = ROOT / 'tools/rig-pipeline/shoot_p8.cjs'
        shots = QA / 'p8-viewer'
        if shooter.exists():
            r = subprocess.run(['node', str(shooter), str(shots)], cwd=ROOT,
                               capture_output=True, text=True, timeout=240)
            if r.returncode != 0:
                return [f'P8: SKIPPED (viewer shoot failed: '
                        f'{(r.stderr or r.stdout).strip()[:160]})']
        name_map = {'p8-rest': 'rest', 'p8-tiltm12': 'tiltm12',
                    'p8-turnXp1': 'turn10', 'p8-turnYp1': 'turn01'}
        # the same anchorTransform as packages/rig render.ts, at css size P8_CSS
        a = self.rig['anchor']
        s_css = ((92 / 256) * P8_CSS) / a['hoodWidth']
        ox = P8_CSS / 2 - a['centerX'] * s_css
        oy = (246 / 256) * P8_CSS - a['groundY'] * s_css
        k = 2 * s_css  # pack px -> css px (pack native = master * 0.5)
        lines = []
        for shot_name, pose in name_map.items():
            f = shots / f'{shot_name}.png'
            if not f.exists():
                lines.append(f'P8 {pose}: SKIPPED (no shot)')
                continue
            viewer = np.array(Image.open(f).convert('RGB'))
            comp, _, _ = self.compose(pose, bg=np.array(P8_BG, np.float32))
            bg = np.zeros((P8_CSS, P8_CSS, 3), np.uint8)
            bg[...] = P8_BG
            scaled = cv2.resize(comp, (max(1, round(self.size[0] * k)),
                                       max(1, round(self.size[1] * k))),
                                interpolation=cv2.INTER_LINEAR)
            x0, y0 = int(round(ox)), int(round(oy))
            h, w = scaled.shape[:2]
            x1, y1 = min(P8_CSS, x0 + w), min(P8_CSS, y0 + h)
            bg[y0:y1, x0:x1] = scaled[:y1 - y0, :x1 - x0]
            hx0, hy0, hx1, hy1 = P8_HEAD_BOX
            bx0 = int(round(hx0 * s_css + ox))
            by0 = int(round(hy0 * s_css + oy))
            bx1 = int(round(hx1 * s_css + ox))
            by1 = int(round(hy1 * s_css + oy))
            reg_v = viewer[by0:by1, bx0:bx1].astype(np.int16)
            reg_c = bg[by0:by1, bx0:bx1].astype(np.int16)
            diff = float(np.abs(reg_v - reg_c).mean())
            vis = np.concatenate([viewer[by0:by1, bx0:bx1], bg[by0:by1, bx0:bx1]],
                                 axis=1).astype(np.uint8)
            Image.fromarray(vis).save(QA / f'p8-{pose}.png')
            lines.append(f'P8 {pose}: head-region mean abs diff={diff:.2f} '
                         f'(gate <= {P8_DIFF_MAX}) -> qa/p8-{pose}.png')
        return lines


def main():
    qa = PackQA()
    poses = [{'name': 'rest', 'params': {}}]
    for tx, ty in TURN_COMBOS:
        poses.append({'name': f'turn{tx}{ty}', 'params': {'head.turnX': tx, 'head.turnY': ty}})
    poses.append({'name': 'tiltp12', 'params': {'head.tilt': 12}})
    poses.append({'name': 'tiltm12', 'params': {'head.tilt': -12}})
    for v in EAR_ANGLES:
        for tx in (-1, 1):
            poses.append({'name': f'ear{v}tx{tx}',
                          'params': {'ear.L.rot': v, 'ear.R.rot': v, 'head.turnX': tx}})
    for v in ARM_L_ANGLES:
        poses.append({'name': f'armL{v}', 'params': {'arm.L.rot': v}})
    for v, slot in ARM_R_ANGLES:
        p = {'arm.R.rot': v}
        if slot:
            p['arm.R.slot'] = slot
        poses.append({'name': f'armR{v}', 'params': p})
    poses.append({'name': 'stringLm25', 'params': {'string.L.rot': -25}})
    poses.append({'name': 'stringLp25', 'params': {'string.L.rot': 25}})
    poses.append({'name': 'stringRm25', 'params': {'string.R.rot': -25}})
    poses.append({'name': 'stringRp25', 'params': {'string.R.rot': 25}})
    poses.append({'name': 'tilt18p', 'params': {'head.tilt': 18}})
    poses.append({'name': 'tilt18m', 'params': {'head.tilt': -18}})
    poses.append({'name': 'turnYm1', 'params': {'head.turnY': -1}})
    poses.append({'name': 'turnYp1', 'params': {'head.turnY': 1}})
    poses.append({'name': COMBO_POSE[0], 'params': dict(COMBO_POSE[1])})
    for v in EAR_SWEEP_ANGLES:
        for tx in (-1, 0, 1):
            poses.append({'name': f'sw{v}_{tx}',
                          'params': {'ear.L.rot': v, 'ear.R.rot': v, 'head.turnX': tx}})
    qa.dump_poses(poses)

    lines = []
    rest = qa.compose('rest')
    qa.build_fields()

    r1 = qa.p1(rest)
    lines.append(f'P1 static restoration: total={r1["total"]} (gate <= {P1_TOTAL_MAX}), '
                 f'blocks={r1["blocks"]}, worst_block={r1["worst_block"]}px (gate <= {P1_BLOCK_MAX})')
    for s in ('left', 'right'):
        lines.append(f'P1 cheek {s}: px={r1[f"{s}_box_px"]} blocks={r1[f"{s}_box_blocks"]} '
                     f'worst={r1[f"{s}_box_worst"]}px ge4px_blocks={r1[f"{s}_box_ge4"]} (gate 0)')

    r2 = qa.p2(rest)
    for r in r2:
        lines.append(f'P2 {r["pair"]}: exposed={r["exposed"]} violations={r["violations"]} '
                     f'(gate 0) exempt={r["exempt"]} over_cap={r["over_cap"]} '
                     f'worst_pose={r["worst_pose"]}:{r["worst_pose_viol"]}')

    r3 = qa.p3()
    worst_cov = min(v[0] for v in r3.values())
    worst_white = max(v[3] for v in r3.values())
    lines.append(f'P3 ear sweep: worst coverage={worst_cov:.4f} (gate >= {P3_COVER_MIN}), '
                 f'worst bare-white={worst_white}px (gate 0)')
    for k, v in sorted(r3.items()):
        lines.append(f'  P3 {k}: coverage={v[0]} outline={v[1]}px inked={v[2]}px bareWhite={v[3]}px')

    r4 = qa.p4(rest)
    lines.append(f'P4 thin lines: {len(r4)} (gate 0)')
    for ln in r4:
        lines.append(f'  P4 #{ln["i"]}: {ln["px"]}px at {ln["center"]} pack-box={ln["pack_px_box"]} '
                     f'master-box={ln["master_px_box"]} owner={ln["owner"]}')

    lines += qa.p6()
    lines += qa.p7()
    lines += qa.p8()

    report = QA / 'pack-report.txt'
    report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
