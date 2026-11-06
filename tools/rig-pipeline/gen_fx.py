#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""A7 effect sprites, drawn as flat-colour vector shapes (rework P1-2).

Upstream generation of the small effect stickers was unreliable, so per
the rework task book these are drawn programmatically: thick outlines +
flat fills in the character palette. Each sprite is painted onto a full
master-size transparent canvas at its anchor, so the normal exporter
bbox-crop picks it up with the right x/y. Solver drives opacity from the
`fx.<name>` param; clips animate it.
"""
from pathlib import Path

import os
import numpy as np
from PIL import Image, ImageDraw

# BAIZE_ROOT overrides the default checkout location (e.g. CI or a scratch copy)
ROOT = Path(os.environ.get('BAIZE_ROOT', '/Users/baihaibin/Documents/WorkSpares/BaiZe'))
ART = ROOT / 'demo/rig-art'
OUT = ART / 'parts-ext'
W, H = 854, 1188
AMBER = (242, 178, 84)
AMBER_DARK = (196, 130, 40)
PINK = (244, 166, 166)
RED = (232, 84, 68)
WHITE = (255, 255, 255)
BLUE = (120, 180, 235)
INK = (60, 52, 46)

# name -> (anchor x, y for the sprite centre)
ANCHORS = {
    'fx-sweat': (575, 305),
    'fx-tear': (318, 415),
    'fx-zzz': (632, 150),
    'fx-question': (636, 255),
    'fx-exclaim': (636, 215),
    'fx-note': (628, 128),
    'fx-heart': (586, 330),
    'fx-sparkle': (646, 108),
    'fx-puff': (318, 480),
    'fx-anger': (640, 190),
    'fx-bubble': (298, 488),
}


def canvas():
    return Image.new('RGBA', (W, H), (0, 0, 0, 0))


def drop(d, cx, cy, s, fill):
    """Tear/sweat drop: circle + pointed top."""
    d.ellipse([cx - s, cy - s * 0.2, cx + s, cy + s * 1.8], fill=fill, outline=INK, width=3)
    d.polygon([(cx - s * 0.55, cy), (cx + s * 0.55, cy), (cx, cy - s * 1.5)], fill=fill, outline=INK)


def draw_sprite(name, d, cx, cy):
    if name in ('fx-sweat', 'fx-tear'):
        s = 26 if name == 'fx-sweat' else 18
        drop(d, cx, cy, s, BLUE if name == 'fx-sweat' else (150, 200, 245))
    elif name == 'fx-zzz':
        for dx, dy, size in ((0, 44, 34), (22, 12, 42), (46, -22, 50)):
            x, y = cx + dx, cy + dy
            w = size // 2
            d.line([(x - w, y - size // 2), (x + w, y - size // 2)], fill=AMBER_DARK, width=13)
            d.line([(x + w, y - size // 2), (x - w, y + size // 2)], fill=AMBER_DARK, width=13)
            d.line([(x - w, y + size // 2), (x + w, y + size // 2)], fill=AMBER_DARK, width=13)
    elif name == 'fx-question':
        d.arc([cx - 30, cy - 44, cx + 30, cy + 16], 180, 420, fill=AMBER_DARK, width=10)
        d.line([(cx, cy + 14), (cx, cy + 26)], fill=AMBER_DARK, width=10)
        d.ellipse([cx - 6, cy + 38, cx + 6, cy + 50], fill=AMBER_DARK)
    elif name == 'fx-exclaim':
        d.rounded_rectangle([cx - 7, cy - 48, cx + 7, cy + 20], 6, fill=AMBER_DARK)
        d.ellipse([cx - 8, cy + 32, cx + 8, cy + 48], fill=AMBER_DARK)
    elif name == 'fx-note':
        d.ellipse([cx - 22, cy + 6, cx + 2, cy + 30], fill=AMBER_DARK)
        d.line([(cx, cy + 16), (cx, cy - 34)], fill=AMBER_DARK, width=7)
        d.line([(cx, cy - 34), (cx + 24, cy - 22)], fill=AMBER_DARK, width=7)
    elif name == 'fx-heart':
        d.polygon([(cx, cy + 26), (cx - 28, cy - 4), (cx + 28, cy - 4)], fill=PINK, outline=INK)
        d.ellipse([cx - 28, cy - 26, cx - 2, cy], fill=PINK, outline=INK)
        d.ellipse([cx + 2, cy - 26, cx + 28, cy], fill=PINK, outline=INK)
    elif name == 'fx-sparkle':
        pts = []
        for i in range(8):
            ang = i * np.pi / 4
            r = 34 if i % 2 == 0 else 12
            pts.append((cx + r * np.sin(ang), cy - r * np.cos(ang)))
        d.polygon(pts, fill=AMBER, outline=AMBER_DARK)
    elif name == 'fx-puff':
        for dx, dy, r in ((-24, 6, 18), (0, -6, 22), (24, 6, 18), (0, 12, 16)):
            d.ellipse([cx + dx - r, cy + dy - r, cx + dx + r, cy + dy + r], fill=WHITE, outline=INK)
    elif name == 'fx-anger':
        d.line([(cx - 30, cy - 10), (cx + 30, cy - 10)], fill=RED, width=9)
        d.line([(cx - 30, cy + 10), (cx + 30, cy + 10)], fill=RED, width=9)
        d.line([(cx - 14, cy - 24), (cx - 14, cy + 24)], fill=RED, width=9)
        d.line([(cx + 14, cy - 24), (cx + 14, cy + 24)], fill=RED, width=9)
    elif name == 'fx-bubble':
        d.ellipse([cx - 24, cy - 20, cx + 24, cy + 20], fill=(255, 240, 244, 190), outline=INK)
        d.arc([cx - 14, cy - 12, cx + 2, cy + 4], 120, 240, fill=WHITE, width=4)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (cx, cy) in ANCHORS.items():
        im = canvas()
        draw_sprite(name, ImageDraw.Draw(im), cx, cy)
        im.save(OUT / f'{name}.png', optimize=True)
        print(f'{name}: sprite at ({cx},{cy})')
    # third-eye glow (A4): pure amber soft light, additive blend, centred on
    # the third eye; opacity driven by the thirdEye.glow param
    glow = canvas()
    arr = np.zeros((H, W, 4), np.uint8)
    cx, cy, r = 438, 158, 78
    yy, xx = np.ogrid[:H, :W]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    falloff = np.clip(1 - dist / r, 0, 1) ** 2
    arr[..., 0] = (248 * falloff).astype(np.uint8)
    arr[..., 1] = (196 * falloff).astype(np.uint8)
    arr[..., 2] = (96 * falloff).astype(np.uint8)
    arr[..., 3] = (255 * falloff).astype(np.uint8)
    Image.fromarray(arr, 'RGBA').save(OUT / 'third-eye-glow.png', optimize=True)
    print('third-eye-glow: sprite at (438,158)')
    print(f'{len(ANCHORS) + 1} fx sprites -> {OUT}')


if __name__ == '__main__':
    main()
