#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Export the rig character pack (task book A8/E): parts at half master
scale into characters/baize-b3/rig/parts, rig.json with offsets and the
measured anchor, behaviour data copied from characters/b3, sprite sheets,
LICENSE and README.
"""
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path('/Users/baihaibin/Documents/WorkSpares/BaiZe')
ART = ROOT / 'demo/rig-art'
PACK = ROOT / 'characters/baize-b3'
B3_MANIFEST = ROOT / 'characters/b3/manifest.json'
SPRITES_V2 = ROOT / 'demo/pet-demo/b3-sprites-v2'
SCALE = 0.5

# z / parent / pivot hints per part id (master px; refined from segmentation).
PART_META = {
    'tail':      {'z': 0,  'parent': 'body'},
    'leg-L':     {'z': 10, 'parent': 'body'},
    'leg-R':     {'z': 10, 'parent': 'body'},
    'shorts':    {'z': 20, 'parent': 'body'},
    'torso':     {'z': 30, 'parent': 'body'},
    'string-L':  {'z': 35, 'parent': 'torso'},
    'string-R':  {'z': 35, 'parent': 'torso'},
    'arm-L':     {'z': 40, 'parent': 'torso', 'slot_key': 'arm.L.slot'},
    'arm-R':     {'z': 40, 'parent': 'torso', 'slot_key': 'arm.R.slot'},
    'hood':      {'z': 50, 'parent': 'head'},
    'horn-L':    {'z': 52, 'parent': 'head'},
    'horn-R':    {'z': 52, 'parent': 'head'},
    'ear-L':     {'z': 55, 'parent': 'head'},
    'ear-R':     {'z': 55, 'parent': 'head'},
    'third-eye': {'z': 56, 'parent': 'head'},
    'face':      {'z': 60, 'parent': 'head'},
    'bangs':     {'z': 80, 'parent': 'head'},
    'eye-L':     {'z': 70, 'parent': 'head', 'slot_key': 'eye.shape'},
    'eye-R':     {'z': 70, 'parent': 'head', 'slot_key': 'eye.shape'},
    'iris-L':    {'z': 71, 'parent': 'head'},
    'iris-R':    {'z': 71, 'parent': 'head'},
    'mouth':     {'z': 72, 'parent': 'head', 'slot_key': 'mouth.shape'},
    'blush':     {'z': 73, 'parent': 'head', 'opacityParam': 'blush'},
}


def measure_anchor(master_rgba):
    """Anchor measured with the SAME iterative top-band metric as the sprite
    normalizer (build-sprites-2.py hood_width), so rig frames and sprite
    frames share one ruler: hood width -> 92 display px, feet -> ground 246."""
    alpha = master_rgba[..., 3] > 128
    ys, xs = np.where(alpha)
    ground_y = int(ys.max())
    top = ys.min()
    w = (xs.max() - xs.min() + 1) * 0.6
    for _ in range(4):
        band = alpha[top : top + max(4, int(w * 0.62))]
        cols = np.where(band.any(0))[0]
        w = cols.max() - cols.min() + 1
    hood_w = float(w)
    center_x = int((xs.min() + xs.max()) / 2)
    return hood_w, ground_y, center_x


def bbox_of(mask):
    ys, xs = np.where(mask > 0)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def main():
    master = np.array(Image.open(ART / 'master.png').convert('RGBA'))
    hood_w, ground_y, center_x = measure_anchor(master)
    print(f'anchor: hood={hood_w}px ground={ground_y} center={center_x}')

    if PACK.exists():
        shutil.rmtree(PACK)
    (PACK / 'rig' / 'parts').mkdir(parents=True, exist_ok=True)

    rig = {
        'version': 1,
        'master': {'width': int(master.shape[1]), 'height': int(master.shape[0]), 'scale': SCALE},
        'anchor': {'hoodWidth': hood_w, 'groundY': ground_y, 'centerX': center_x},
        'parts': [],
        'groups': {
            'body': {'pivot': [center_x, ground_y]},
            'head': {'parent': 'body', 'pivot': [center_x, int(ground_y * 0.47)]},
        },
        'clips': [f'clips/{n}.json' for n in sorted(p.stem for p in (ART / 'clips-out/clips').glob('*.json'))],
        'expressions': 'expressions.json',
    }

    for pid, meta in PART_META.items():
        src = ART / 'parts-ext' / f'{pid}.png'
        if not src.exists():
            src = ART / 'parts-full' / f'{pid}.png'
        if not src.exists():
            print(f'skip missing part: {pid}')
            continue
        img = np.array(Image.open(src).convert('RGBA'))
        mask = img[..., 3] > 8
        box = bbox_of(mask)
        if box is None:
            continue
        x0, y0, x1, y1 = box
        crop = Image.fromarray(img[y0:y1, x0:x1])
        ow, oh = crop.size
        crop = crop.resize((max(1, round(ow * SCALE)), max(1, round(oh * SCALE))), Image.LANCZOS)
        rel = f'parts/{pid}.png'
        crop.save(PACK / 'rig' / rel, optimize=True)
        # Slot-name-keyed defaults; A6 patches register more slots per part.
        DEFAULT_SLOTS = {
            'arm-L': {'down': rel},
            'arm-R': {'down': rel},
            'eye-L': {'open': rel},
            'eye-R': {'open': rel},
            'mouth': {'smile': rel},
            'third-eye': {'closed': rel},
        }
        entry = {
            'id': pid,
            'image': rel,
            'x': int(x0),
            'y': int(y0),
            'z': meta['z'],
            'parent': meta['parent'],
            'pivot': [int((x0 + x1) / 2), int((y0 + y1) / 2)],
        }
        if pid in DEFAULT_SLOTS:
            entry['slots'] = DEFAULT_SLOTS[pid]
        if 'opacityParam' in meta:
            entry['opacityParam'] = meta['opacityParam']
        rig['parts'].append(entry)

    # Copy clips + expressions produced by make-clips.cjs.
    clips_src = ART / 'clips-out'
    (PACK / 'rig' / 'clips').mkdir(parents=True, exist_ok=True)
    for f in sorted((clips_src / 'clips').glob('*.json')):
        shutil.copy(f, PACK / 'rig' / 'clips' / f.name)
    shutil.copy(clips_src / 'expressions.json', PACK / 'rig' / 'expressions.json')

    # Sprite sheets: the four sprite: actions from b3-sprites-v2.
    sprite_meta = json.loads((SPRITES_V2 / 'sprites.json').read_text(encoding='utf-8'))
    (PACK / 'sprites').mkdir(parents=True, exist_ok=True)
    out_states = {}
    for name in ('dance', 'sit', 'sit-idle', 'hide-in-hood'):
        src_sheet = SPRITES_V2 / f'{name}.png'
        meta = sprite_meta['states'].get(name)
        if src_sheet.exists() and meta:
            shutil.copy(src_sheet, PACK / 'sprites' / f'{name}.png')
            out_states[name] = meta
    sprites_json = {
        'cell': sprite_meta.get('cell', 256),
        'ground': sprite_get_ground(sprite_meta),
        'states': out_states,
    }
    (PACK / 'sprites' / 'sprites.json').write_text(
        json.dumps(sprites_json, indent=1, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    # Manifest: behaviour data from characters/b3, animations remapped.
    b3 = json.loads(B3_MANIFEST.read_text(encoding='utf-8'))
    clip_names = {p.stem for p in (PACK / 'rig' / 'clips').glob('*.json')}
    animations = {}
    for action in b3['animations']:
        if action in clip_names:
            animations[action] = f'rig:{action}'
        elif action in out_states:
            animations[action] = f'sprite:{action}'
        else:
            animations[action] = 'rig:idle'  # documented fallback (task book D)
    manifest = {
        'id': 'baize-b3',
        'name': b3.get('name', '白泽'),
        'version': '1.0.0',
        'renderer': 'rig',
        'rig': 'rig/rig.json',
        'animations': animations,
        'emotion': b3.get('emotion'),
        'behavior': b3.get('behavior'),
        'scenes': b3.get('scenes'),
        'lines': b3.get('lines'),
    }
    (PACK / 'manifest.json').write_text(
        json.dumps(manifest, indent=1, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    rig_json = PACK / 'rig' / 'rig.json'
    rig_json.write_text(json.dumps(rig, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')

    total = sum(f.stat().st_size for f in PACK.rglob('*') if f.is_file())
    print(f'pack -> {PACK} ({total / 1e6:.2f} MB)')


def sprite_get_ground(meta):
    return meta.get('ground', 246)


if __name__ == '__main__':
    main()
