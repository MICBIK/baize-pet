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
        # Slot values are SlotImage objects ({image, x, y}) per rig.json schema.
        SLOT_DEFAULTS = {
            'arm-L': 'down',
            'arm-R': 'down',
            'eye-L': 'open',
            'eye-R': 'open',
            'mouth': 'smile',
            'third-eye': 'closed',
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
        if pid in SLOT_DEFAULTS:
            entry['slots'] = {
                SLOT_DEFAULTS[pid]: {'image': rel, 'x': int(x0), 'y': int(y0)}
            }
        if 'opacityParam' in meta:
            entry['opacityParam'] = meta['opacityParam']
        rig['parts'].append(entry)

    # A6 arm slots extracted from registered variants (extract_arm_slots.py):
    # slot PNGs copy into rig/parts and the {image,x,y} objects merge into the
    # part entries. Families that failed isolation stay absent (F4 fallback).
    slots_file = ART / 'slots.json'
    if slots_file.exists():
        slots = json.loads(slots_file.read_text(encoding='utf-8'))
        for slot_png in sorted((ART / 'slots').glob('arm-*.png')):
            shutil.copy(slot_png, PACK / 'rig' / 'parts' / slot_png.name)
        for entry in rig['parts']:
            extra = slots.get(entry['id'])
            if extra:
                entry.setdefault('slots', {}).update(extra)

    # A6 expression patches (extract_patches.py): eye/mouth shape slots keyed
    # by the eye.shape / mouth.shape enums. Patches are cut at master scale
    # (offset = top-left in master px); like every part image they export at
    # half scale while x/y stay in master space. Shapes without a usable patch
    # (squeeze/teary/wink, most mouths) stay absent and the solver's slot
    # fallback (down/open/smile/closed) answers them (F4).
    report_file = ART / 'patches' / 'patches-report.json'
    if report_file.exists():
        report = json.loads(report_file.read_text(encoding='utf-8'))
        rename = {'lookup': 'look-up'}
        by_id = {e['id']: e for e in rig['parts']}
        for name, rep in sorted(report.items()):
            sides = ('L', 'R') if 'L' in rep else (None,)
            for side in sides:
                src = ROOT / (rep[side]['image'] if side else rep['image'])
                ox, oy = rep[side]['offset'] if side else rep['offset']
                shape = name[4:] if name.startswith('eye-') else name[6:]
                shape = rename.get(shape, shape)
                part_id = f'eye-{side}' if side else 'mouth'
                target = by_id.get(part_id)
                if not target:
                    continue
                im = Image.open(src).convert('RGBA')
                half = im.resize(
                    (max(1, round(im.width * SCALE)), max(1, round(im.height * SCALE))),
                    Image.LANCZOS,
                )
                out_name = f'{name}-{side}.png' if side else f'{name}.png'
                rel = f'parts/{out_name}'
                half.save(PACK / 'rig' / rel, optimize=True)
                target.setdefault('slots', {})[shape] = {'image': rel, 'x': int(ox), 'y': int(oy)}

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

    # The exporter rebuilds the pack directory from scratch; the license and
    # pack README are part of the deliverable and live here so re-exports
    # never drop them.
    (PACK / 'LICENSE.txt').write_text(LICENSE_TEXT, encoding='utf-8')
    (PACK / 'README.md').write_text(PACK_README, encoding='utf-8')

    total = sum(f.stat().st_size for f in PACK.rglob('*') if f.is_file())
    print(f'pack -> {PACK} ({total / 1e6:.2f} MB)')


LICENSE_TEXT = '''BaiZe B3 layered rig character pack ("白泽连帽衫")

Artwork derived from the project's own variant-B character design
(demo/baize-design, variants/variant-b.js). The rig master and part
images were generated with the tzcode.top gpt-image-2.5 image model
using demo/pet-demo/b3-frames/ref-standard(-s).png as the style
reference, then segmented, joint-extended and exported by the
reproducible pipeline in tools/rig-pipeline/ (see README.md for the
full rebuild command list). Sprite sheets under sprites/ are the
normalized atlas strips from demo/pet-demo/b3-sprites-v2 (normalized
by build-sprites-2.py).

Distributed under the same license as the repository code: AGPL-3.0-only.
'''

PACK_README = '''# baize-b3 · 分层 rig 角色包

默认角色包（renderer: "rig"）：分层部件 + 程序动画，动作名与行为系统逐一对应（35 个 rig clips + 4 个 sprite 图集 = 39 个动画键）。

## 目录结构

- `manifest.json` — renderer: "rig"，animations 用 `rig:<clip>` / `sprite:<sheet>` 两种前缀形式
- `rig/rig.json` — 部件表（z/parent/pivot/插槽）、锚点（hoodWidth=524px、groundY=1101、centerX=435，master 像素坐标）、clips/expressions 清单
- `rig/parts/*.png` — 每部件一张（0.5x master 缩放，角色高 512px）
- `rig/clips/*.json` — 关键帧动作（由 `tools/rig-pipeline/make-clips.cjs` 生成）
- `rig/expressions.json` — 18 个表情预设
- `sprites/*.png + sprites.json` — 4 个大动作图集（dance/sit/sit-idle/hide-in-hood），256 网格、地面线 246，与 rig 共用锚点

## 从 demo/ 原始素材重建（命令清单）

```bash
# 0) Python 环境（一次）
python3 -m venv demo/rig-art/.venv
demo/rig-art/.venv/bin/pip install numpy pillow scipy opencv-python-headless torch torchvision segment-anything
# SAM 权重: https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth -> demo/rig-art/models/

# 1) master 候选生成（需 BAIZE_IMAGE_API_KEY，key 只走环境变量）
BAIZE_IMAGE_API_KEY=$(node demo/rig-art/key.cjs) node tools/rig-pipeline/gen-image.cjs batch --jobs demo/rig-art/master-jobs.json
#    人工从 demo/rig-art/master-candidates/ 挑选（本轮选 m3），写进 normalize_master.py 的常量

# 2) 归一化（角色高 1024px）
demo/rig-art/.venv/bin/python tools/rig-pipeline/normalize_master.py

# 3) 变体生成（12 种 × 2 候选，master 单参考）
node tools/rig-pipeline/make-variant-jobs.cjs
BAIZE_IMAGE_API_KEY=$(node demo/rig-art/key.cjs) node tools/rig-pipeline/gen-image.cjs batch --jobs demo/rig-art/variant-jobs.json

# 4) 配准（ECC 金字塔 + ORB 回退，叠图人工验收）
demo/rig-art/.venv/bin/python tools/rig-pipeline/register_variants.py

# 5) SAM 分割（parts.prompts.json 为可复现提示）
demo/rig-art/.venv/bin/python tools/rig-pipeline/segment_parts.py

# 6) A5 关节外扩
demo/rig-art/.venv/bin/python tools/rig-pipeline/extend_parts.py

# 7) A9 验收（复原/关节压力/小尺寸，报告在 demo/rig-art/qa/qa-report.txt）
demo/rig-art/.venv/bin/python tools/rig-pipeline/qa.py

# 8) clips + 表情预设
node tools/rig-pipeline/make-clips.cjs demo/rig-art/clips-out

# 9) 导出本包
demo/rig-art/.venv/bin/python tools/rig-pipeline/export_pack.py
```

## 已知问题

- master（m3）与序列帧源（ref-standard）头身比例存在约 12% 差异；rig↔sprite 切换处兜帽宽度与地面线已对齐（双锚点），角色高度差待联系表目检后决定是否按高度重归一化图集
- 手臂插槽当前只有 down 姿势；wave/up/hold 等插槽待变体配准后由 export_pack.py 注册
- 眼/嘴插槽当前只有 open/smile；A6 表情贴片批次完成后扩充
'''


def sprite_get_ground(meta):
    return meta.get('ground', 246)


if __name__ == '__main__':
    main()
