#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""SAM-based part segmentation of the rig master (task book A4).

Reads box/point prompts from parts.prompts.json, predicts one mask per part,
cleans it morphologically, subtracts upper-layer parts, and writes
demo/rig-art/parts-full/<id>.png plus a labelled QA overlay.
Iris parts use the parent eye mask with an amber/pupil colour filter.
"""
import os
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from segment_anything import SamPredictor, sam_model_registry

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
MASTER = ART / 'master.png'
PROMPTS = ROOT / 'tools/rig-pipeline/parts.prompts.json'
PARTS_FULL = ART / 'parts-full'
QA = ART / 'qa'
PARTS_FULL.mkdir(parents=True, exist_ok=True)
QA.mkdir(parents=True, exist_ok=True)
CHECKPOINT = ART / 'models' / 'sam_vit_b_01ec64.pth'


def load_master():
    im = Image.open(MASTER).convert('RGBA')
    return np.array(im)


def build_predictor():
    sam = sam_model_registry['vit_b'](checkpoint=str(CHECKPOINT))
    sam.to('cpu')
    sam.eval()
    return SamPredictor(sam)


def clean_mask(mask, box):
    """1px open+close, then keep components intersecting the prompt box."""
    m = (mask > 0).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    x0, y0, x1, y1 = box
    keep = np.zeros_like(m)
    for i in range(1, n):
        sx, sy, sw, sh, area = stats[i]
        if area < 30:
            continue
        if sx < x1 and sx + sw > x0 and sy < y1 and sy + sh > y0:
            keep[lab == i] = 1
    return keep


def iris_from_eye(master, eye_mask, box):
    """Amber iris + dark pupil pixels inside the eye mask (Lab thresholds)."""
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    L = lab[..., 0].astype(int)
    A = lab[..., 1].astype(int)
    B = lab[..., 2].astype(int)
    x0, y0, x1, y1 = box
    # Amber: warm (A,B well above neutral) and mid-lightness; pupil: dark.
    amber = (A > 128) & (B > 140) & (L > 60) & (L < 220)
    dark = (L < 60) & (B < 140)
    sel = (amber | dark) & (eye_mask > 0)
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    region = np.zeros_like(sel)
    region[y0:y1, x0:x1] = True
    return (sel & region).astype(np.uint8)


def color_face(master, box):
    """Flat skin tones inside the face box: Lab B >= 133 separates skin from
    the cooler white hood/hair (B ~128-132). Close(5) consolidates shading
    speckle; the nearest-part pass afterwards reclaims any seams."""
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    L = lab[..., 0].astype(int)
    B = lab[..., 2].astype(int)
    x0, y0, x1, y1 = [int(v) for v in box]
    sel = np.zeros(L.shape, bool)
    sel[y0:y1, x0:x1] = True
    m = ((B >= 133) & (L >= 185) & sel & (master[..., 3] > 128)).astype(np.uint8)
    k = np.ones((5, 5), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    return m


def color_mouth(master, box):
    """The smile stroke: darker-than-skin warm pixels in a tight box."""
    lab = cv2.cvtColor(master[..., :3], cv2.COLOR_RGB2LAB)
    L = lab[..., 0].astype(int)
    B = lab[..., 2].astype(int)
    x0, y0, x1, y1 = [int(v) for v in box]
    sel = np.zeros(L.shape, bool)
    sel[y0:y1, x0:x1] = True
    return ((L < 195) & (B >= 115) & sel & (master[..., 3] > 128)).astype(np.uint8)


def color_blush(master, box):
    """Two blush ellipses (task book A6 allows programmatic blush): centred on
    each cheek, intersected with the silhouette."""
    x0, y0, x1, y1 = [int(v) for v in box]
    yy, xx = np.ogrid[: master.shape[0], : master.shape[1]]
    m = np.zeros(master.shape[:2], bool)
    for cx in (x0 + 25, x1 - 25):
        cy = (y0 + y1) // 2
        m |= ((xx - cx) / 22.0) ** 2 + ((yy - cy) / 12.0) ** 2 <= 1.0
    return (m & (master[..., 3] > 128)).astype(np.uint8)


def main():
    master = load_master()
    spec = json.loads(PROMPTS.read_text(encoding='utf-8'))
    predictor = build_predictor()
    predictor.set_image(master[..., :3])

    masks = {}
    alpha_bool = master[..., 3] > 128
    for part in spec['parts']:
        pid = part['id']
        box = part['box']
        box_np = np.array(box, dtype=np.float32)
        pts = np.array(part['points'], dtype=np.float32) if part['points'] else None
        labels = np.ones((len(part['points']),), dtype=np.int64) if pts is not None else None
        if pts is None:
            m, _, _ = predictor.predict(box=box_np, multimask_output=False)
        else:
            m, _, _ = predictor.predict(
                box=box_np, point_coords=pts, point_labels=labels, multimask_output=False
            )
        raw = m[0]
        method = part.get('method')
        if method == 'color-face':
            raw = color_face(master, box)
        elif method == 'color-mouth':
            raw = color_mouth(master, box)
        elif method == 'color-blush':
            raw = color_blush(master, box)
        elif part.get('from'):
            raw = iris_from_eye(master, masks.get(part['from'], np.zeros_like(raw)), box)
        cleaned = clean_mask(raw, box)
        # Never leave the character silhouette: kills SAM box spills.
        cleaned = (cleaned > 0) & alpha_bool
        masks[pid] = cleaned.astype(np.uint8)
        print(f'{pid}: {int(masks[pid].sum())} px')

    # Subtract upper layers from lower ones.
    for part in spec['parts']:
        for other in part.get('subtract', []):
            if other in masks:
                masks[part['id']] = (masks[part['id']] > 0) & (masks[other] == 0)
                masks[part['id']] = masks[part['id']].astype(np.uint8)

    # Assign leftover silhouette pixels (shared outlines, gaps) to the nearest
    # part so the composite reproduces the master exactly (A9 IoU gate).
    union = np.zeros(master.shape[:2], bool)
    for mask in masks.values():
        union |= mask > 0
    leftover = alpha_bool & ~union
    if leftover.any():
        # Distance-transform labels: each leftover pixel joins the nearest part.
        acc = np.full(master.shape[:2], np.inf)
        owner = np.zeros(master.shape[:2], np.int32)
        names = list(masks.keys())
        for idx, pid in enumerate(names):
            dist = cv2.distanceTransform((masks[pid] == 0).astype(np.uint8), cv2.DIST_L2, 3)
            closer = dist < acc
            acc[closer] = dist[closer]
            owner[closer] = idx
        for idx, pid in enumerate(names):
            take = leftover & (owner == idx)
            masks[pid] = ((masks[pid] > 0) | take).astype(np.uint8)
        print(f'assigned {int(leftover.sum())} leftover px to nearest parts')

    # Export per-part RGBA images (master-sized, only this part opaque).
    for pid, mask in masks.items():
        out = master.copy()
        out[..., 3] = np.where(mask > 0, master[..., 3], 0)
        Image.fromarray(out).save(PARTS_FULL / f'{pid}.png')

    # Labelled QA overlay: each part a distinct colour at 55% alpha.
    rng = np.random.default_rng(7)
    overlay = master[..., :3].copy()
    legend = []
    for pid, mask in masks.items():
        color = rng.integers(60, 255, 3)
        legend.append((pid, tuple(int(c) for c in color)))
        region = mask > 0
        for c in range(3):
            overlay[..., c][region] = (0.45 * overlay[..., c][region] + 0.55 * color[c]).astype(np.uint8)
    Image.fromarray(overlay).save(QA / 'segmentation.png')
    lines = [f'{pid}: rgb{color}' for pid, color in legend]
    (QA / 'segmentation-legend.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    # Coverage: union of masks vs master alpha (report only).
    union = np.zeros(master.shape[:2], bool)
    for mask in masks.values():
        union |= mask > 0
    alpha = master[..., 3] > 128
    print(f'union coverage of master alpha: {union.sum()}/{alpha.sum()} = {union.sum()/max(1,alpha.sum()):.3f}')


if __name__ == '__main__':
    main()
