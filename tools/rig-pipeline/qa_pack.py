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
        self.opening = poly_mask_half((mh, mw), FACE_OPEN)
        self._imgs = {}
        self._warp_cache = {}

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

    def compose(self, pose_name):
        """Composite one pose over BG. Returns rgb uint8, alpha f32, owner i32."""
        h, w = self.size[1], self.size[0]
        rgb = np.zeros((h, w, 3), np.float32)
        rgb[..., 0], rgb[..., 1], rgb[..., 2] = BG  # background first
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

    # --- P2 ------------------------------------------------------------------
    def p2(self, rest):
        turn_names = [f'turn{tx}{ty}' for tx, ty in TURN_COMBOS]
        tilt12 = ['tiltp12', 'tiltm12']
        ear_poses = [f'ear{v}tx{tx}' for v in EAR_ANGLES for tx in (-1, 1)]
        arm_l = [f'armL{v}' for v in ARM_L_ANGLES]
        arm_r = [f'armR{v}' for v, _ in ARM_R_ANGLES]
        string_l = ['stringLm25', 'stringLp25']
        string_r = ['stringRm25', 'stringRp25']
        tilt18 = ['tilt18p', 'tilt18m']
        turn_y = ['turnYm1', 'turnYp1']
        spec = [
            ('face', 'hood', turn_names + tilt12),
            ('bangs', 'face', turn_names + tilt12),
            ('ear-L', 'hood', ear_poses),
            ('ear-R', 'hood', ear_poses),
            ('horn-L', 'hood', turn_names),
            ('horn-R', 'hood', turn_names),
            ('third-eye', 'hood', turn_names),
            ('arm-L', 'torso', arm_l),
            ('arm-R', 'torso', arm_r),
            ('string-L', 'torso', string_l),
            ('string-R', 'torso', string_r),
            ('hood', 'torso', tilt18 + turn_y),
        ]
        comp_cache = {}
        for pose in set(sum([s[2] for s in spec], [])) | {'rest'}:
            comp_cache[pose] = self.compose(pose)

        report = []
        for upper, lower, pose_names in spec:
            # "covered" = the NAMED upper part's own coverage (task book:
            # 下层在静止时被上层盖住、在该姿势下不再被盖住). Whole-stack
            # coverage would flag rigid head-rotation boundary flapping
            # (tilt poses) that exposes no relative motion at all.
            ui_rest = next(i for i, p in enumerate(self.dump['rest']) if p['id'] == upper)
            covered_rest = self.warp('rest', ui_rest)[..., 3] >= int(COVER_A * 255)
            worst_pose, worst_px = '', -1
            total_exposed, total_exempt = 0, 0
            total_viol = 0
            tiles = []
            for pose in pose_names:
                comp, comp_alpha, _ = comp_cache[pose]
                ui = next(i for i, p in enumerate(self.dump[pose]) if p['id'] == upper)
                covered_pose = self.warp(pose, ui)[..., 3] >= int(COVER_A * 255)
                exposed = covered_rest & ~covered_pose
                # lower part index in THIS pose (ids are stable across poses)
                li = next(i for i, p in enumerate(self.dump[pose]) if p['id'] == lower)
                d_wr = self.warp(pose, li)
                d_a = d_wr[..., 3].astype(np.float32) / 255.0
                sil = fill_holes(d_a > 32 / 255.0)
                # the outline's own anti-aliased ring is the OUTLINE, not a
                # transparent hole inside it — shrink the silhouette 2 px so
                # boundary AA is not policed as interior transparency
                sil &= cv2.erode(sil.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) | (d_a >= COVER_A)
                exposed &= sil
                if not exposed.any():
                    continue
                # a hole = the WHOLE render is see-through to the background
                # (a lower layer's own semi-alpha over a covering neighbour is
                # not a hole)
                trans = exposed & (comp_alpha < COVER_A)
                comp_lab = self._lab(comp)
                gray = cv2.cvtColor(comp, cv2.COLOR_RGB2GRAY)
                ink = gray < INK_GRAY
                if lower == 'hood':
                    de_l = self._min_de(comp_lab, self.sel_lining)
                    de_w = self._min_de(comp_lab, self.sel_white)
                    bad_color = (de_l > DE_LINING) & (de_w > DE_WHITE)
                elif lower == 'face':
                    de_s = self._min_de(comp_lab, self.sel_skin)
                    de_h = self._min_de(comp_lab, self.sel_hair)
                    bad_color = (de_s > DE_SKIN) & (de_h > DE_SKIN)
                else:  # torso
                    de_c = self._min_de(comp_lab, self.sel_cloth)
                    bad_color = de_c > DE_CLOTH
                viol = exposed & (trans | (bad_color & ~ink))
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

    report = QA / 'pack-report.txt'
    report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
