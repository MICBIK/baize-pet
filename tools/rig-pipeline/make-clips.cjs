// SPDX-License-Identifier: AGPL-3.0-only
// Generate the rig clip library and expression presets (task book B3/B4/D).
// Usage: node make-clips.cjs <outdir>
// Writes <outdir>/clips/<name>.json and <outdir>/expressions.json.

const fs = require('node:fs')
const path = require('node:path')

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node make-clips.cjs <outdir>')
  process.exit(2)
}
const clipDir = path.join(outDir, 'clips')
fs.mkdirSync(clipDir, { recursive: true })

// Keyframe helpers: numeric track [t, v, easing?], enum track [t, value].
const K = (t, v, e) => (e ? [t, v, e] : [t, v])
/** Loop-holding numeric track that returns to v0 at the end. */
const loopNum = (period, amp, _key, easing) => [
  K(0, 0),
  K(period * 0.25, amp, easing ?? 'easeInOutSine'),
  K(period * 0.75, -amp, easing ?? 'easeInOutSine'),
  K(period, 0),
]
/** Two-way pulse track. */
const _pulse = (t0, tUp, hold, tDown, amp, _key) => [
  K(t0, 0),
  K(t0 + tUp, amp, 'easeOutSine'),
  K(t0 + tUp + hold, amp),
  K(t0 + tUp + hold + tDown, 0, 'easeInOutSine'),
]

const clips = {}

// --- base idles (procedural layer drives most of the life) -------------------
clips.idle = {
  name: 'idle',
  duration: 3200,
  loop: true,
  layer: 'base',
  expression: 'neutral',
  tracks: {
    'body.breath': [
      [0, 0],
      [1600, 0.5, 'easeInOutSine'],
      [3200, 0],
    ],
  },
}

clips['idle-happy'] = {
  name: 'idle-happy',
  duration: 1600,
  loop: true,
  layer: 'base',
  expression: 'happy',
  tracks: {
    'body.lean': loopNum(1600, 3),
    'tail.rot': [...loopNum(800, 6), ...loopNum(1600, 4)],
  },
  events: [[0, 'fx:note']],
}

clips['idle-bored'] = {
  name: 'idle-bored',
  duration: 5000,
  loop: true,
  layer: 'base',
  expression: 'bored',
  tracks: {
    'head.tilt': [[0, 6]],
    'body.squash': [
      [0, 0],
      [2000, -0.1, 'easeInOutSine'],
      [2600, 0],
    ],
    'leg.R.rot': [
      [4000, 0],
      [4200, 12, 'easeOutBack'],
      [4600, 0, 'easeInOutSine'],
    ],
  },
  events: [[2000, 'fx:puff']],
}

clips['idle-miss'] = {
  name: 'idle-miss',
  duration: 3500,
  loop: true,
  layer: 'base',
  expression: 'teary',
  tracks: {
    'arm.L.slot': [[0, 'hold']],
    'arm.R.slot': [[0, 'hold']],
    'ear.L.rot': [[0, -20]],
    'ear.R.rot': [[0, -20]],
    'eye.lookY': [
      [0, 0.6],
      [2000, 0.6],
      [2400, -0.3, 'easeInOutSine'],
      [3300, 0.6, 'easeInOutSine'],
    ],
  },
}

clips['idle-shy'] = {
  name: 'idle-shy',
  duration: 3000,
  loop: true,
  layer: 'base',
  expression: 'shy',
  tracks: {
    'arm.R.slot': [[0, 'cover']],
    'eye.lookX': [
      [0, -0.8],
      [2000, -0.8],
      [2300, 0.1, 'easeInOutSine'],
      [2900, -0.8, 'easeInOutSine'],
    ],
  },
}

clips['idle-sleepy'] = {
  name: 'idle-sleepy',
  duration: 4800,
  loop: true,
  layer: 'base',
  expression: 'sleepy',
  tracks: {
    'eye.L.open': [
      [0, 0.6],
      [2000, 0.2, 'easeInOutSine'],
      [2800, 0.6, 'easeInOutSine'],
      [4400, 0.25, 'easeInOutSine'],
      [4800, 0.5],
    ],
    'head.turnY': [
      [3000, 0],
      [3600, 0.6, 'easeInOutSine'],
      [4200, 0.6],
      [4400, 0, 'easeOutBack'],
    ],
  },
}

// --- interaction one-shots ---------------------------------------------------
clips.click = {
  name: 'click',
  duration: 450,
  loop: false,
  layer: 'action',
  expression: 'surprised',
  tracks: {
    'body.squash': [
      [0, 0],
      [80, 0.35, 'easeOutSine'],
      [180, -0.2, 'easeOutBack'],
      [320, 0.15, 'easeOutSine'],
      [450, 0],
    ],
    'body.y': [
      [0, 0],
      [180, -18, 'easeOutBack'],
      [450, 0, 'easeOutBack'],
    ],
    'eye.shape': [
      [0, 'squeeze'],
      [300, 'auto'],
    ],
    'mouth.shape': [
      [0, 'o'],
      [300, 'smile'],
    ],
  },
}

clips.happy = {
  name: 'happy',
  duration: 900,
  loop: false,
  layer: 'action',
  expression: 'laugh',
  tracks: {
    'body.squash': [
      [0, 0],
      [160, 0.25, 'easeOutSine'],
      [300, -0.15, 'easeOutBack'],
      [700, 0.1, 'easeOutSine'],
      [900, 0],
    ],
    'body.y': [
      [240, 0],
      [420, -24, 'easeOutCubic'],
      [700, 0, 'easeInSine'],
    ],
    'arm.L.slot': [
      [240, 'up'],
      [800, 'down'],
    ],
    'arm.R.slot': [
      [240, 'up'],
      [800, 'down'],
    ],
  },
  events: [[300, 'fx:sparkle3']],
}

clips.drag = {
  name: 'drag',
  duration: 1200,
  loop: true,
  layer: 'action',
  expression: 'surprised',
  tracks: {
    'arm.L.slot': [[0, 'out']],
    'arm.R.slot': [[0, 'out']],
    'leg.L.rot': [
      [0, -6],
      [600, 6],
      [1200, -6],
    ],
    'leg.R.rot': [
      [0, 6],
      [600, -6],
      [1200, 6],
    ],
  },
}

clips.land = {
  name: 'land',
  duration: 500,
  loop: false,
  layer: 'action',
  tracks: {
    'body.squash': [
      [0, 0.3, 'easeOutSine'],
      [200, -0.1, 'easeOutBack'],
      [500, 0],
    ],
    'arm.L.slot': [
      [0, 'out'],
      [320, 'down'],
    ],
    'arm.R.slot': [
      [0, 'out'],
      [320, 'down'],
    ],
    'eye.shape': [
      [0, 'squeeze'],
      [260, 'auto'],
    ],
  },
}

clips.sleep = {
  name: 'sleep',
  duration: 4600,
  loop: true,
  layer: 'action',
  expression: 'sleeping',
  tracks: {
    'head.turnY': [[0, 0.55]],
    'head.tilt': [[0, 8]],
    'ear.L.rot': [[0, -15]],
    'ear.R.rot': [[0, -15]],
    'body.breath': [
      [0, 0],
      [2300, 0.5, 'easeInOutSine'],
      [4600, 0],
    ],
  },
  events: [
    [600, 'fx:zzz'],
    [2900, 'fx:zzz'],
  ],
}

clips.yawn = {
  name: 'yawn',
  duration: 2400,
  loop: false,
  layer: 'action',
  expression: 'sleepy',
  next: 'fall-asleep',
  tracks: {
    'arm.L.slot': [
      [0, 'up'],
      [1600, 'up'],
      [2000, 'down'],
    ],
    'arm.R.slot': [
      [0, 'up'],
      [1600, 'rub'],
      [2400, 'down'],
    ],
    'body.squash': [
      [0, 0],
      [500, -0.2, 'easeOutSine'],
      [1600, -0.1],
      [2400, 0],
    ],
    'mouth.shape': [
      [0, 'small'],
      [300, 'wide'],
      [1500, 'small'],
      [1900, 'smile'],
    ],
    'eye.shape': [
      [0, 'squeeze'],
      [1700, 'auto'],
    ],
  },
  events: [[600, 'fx:tear']],
}

clips['fall-asleep'] = {
  name: 'fall-asleep',
  duration: 2600,
  loop: false,
  layer: 'action',
  next: 'sleep',
  tracks: {
    'eye.L.open': [
      [0, 0.5],
      [1200, 0, 'easeInOutSine'],
    ],
    'eye.R.open': [
      [0, 0.5],
      [1200, 0, 'easeInOutSine'],
    ],
    'head.turnY': [
      [0, 0.3, 'easeInOutSine'],
      [700, 0, 'easeInOutSine'],
      [1300, 0.5, 'easeInOutSine'],
      [1900, 0.2, 'easeInOutSine'],
      [2600, 0.55, 'easeInOutSine'],
    ],
  },
}

clips['wake-up'] = {
  name: 'wake-up',
  duration: 2200,
  loop: false,
  layer: 'action',
  expression: 'happy',
  tracks: {
    'eye.L.open': [
      [0, 0.2],
      [300, 0.8, 'easeOutSine'],
      [600, 0.2, 'easeInOutSine'],
      [900, 1, 'easeOutSine'],
    ],
    'eye.R.open': [
      [0, 0.2],
      [300, 0.8, 'easeOutSine'],
      [600, 0.2, 'easeInOutSine'],
      [900, 1, 'easeOutSine'],
    ],
    'arm.L.slot': [
      [0, 'up'],
      [1400, 'down'],
    ],
    'arm.R.slot': [
      [0, 'up'],
      [1400, 'down'],
    ],
    'body.squash': [
      [0, 0],
      [800, -0.25, 'easeOutSine'],
      [1400, 0, 'easeInOutSine'],
    ],
    'body.y': [
      [0, 0],
      [800, -6, 'easeOutSine'],
      [1400, 0],
    ],
  },
}

// --- social / emotional ------------------------------------------------------
clips.wave = {
  name: 'wave',
  duration: 1600,
  loop: false,
  layer: 'action',
  expression: 'laugh',
  tracks: {
    // The wave slot died in re-segmentation review: both v-arm-wave-R
    // variants rendered the character in a dark palette, so the slot crop
    // carried a dark sleeve plus hood fragments. Fallback per rework P0-2:
    // the down arm swings about the shoulder pivot (now a real shoulder
    // pivot in rig.json) — raise, wave twice, settle.
    'arm.R.rot': [
      [0, 0],
      [280, -125, 'easeOutBack'],
      [620, -145, 'easeInOutSine'],
      [900, -122, 'easeInOutSine'],
      [1180, -145, 'easeInOutSine'],
      [1450, -122, 'easeInOutSine'],
      [1600, 0, 'easeInOutSine'],
    ],
    'body.lean': [
      [0, 0],
      [200, 3, 'easeOutSine'],
      [1300, 3],
      [1600, 0, 'easeInOutSine'],
    ],
  },
  events: [[0, 'say:wave']],
}

clips['look-around'] = {
  name: 'look-around',
  duration: 2600,
  loop: false,
  layer: 'action',
  expression: 'neutral',
  tracks: {
    'head.turnX': [
      [0, 0],
      [400, -0.7, 'easeInOutSine'],
      [1000, -0.7],
      [1600, 0.7, 'easeInOutSine'],
      [2200, 0.7],
      [2600, 0, 'easeInOutSine'],
    ],
    'eye.lookX': [
      [0, 0],
      [280, -0.7, 'easeOutSine'],
      [1000, -0.7],
      [1480, 0.7, 'easeInOutSine'],
      [2200, 0.7],
      [2600, 0],
    ],
    'ear.L.rot': [[0, 8]],
    'ear.R.rot': [[0, 8]],
  },
}

clips['tilt-head'] = {
  name: 'tilt-head',
  duration: 1400,
  loop: false,
  layer: 'action',
  expression: 'confused',
  tracks: {
    'head.tilt': [
      [0, 0],
      [350, 14, 'easeOutBack'],
      [1050, 14],
      [1400, 0, 'easeInOutSine'],
    ],
    'ear.R.rot': [
      [350, -15],
      [1050, -15],
      [1400, 0],
    ],
    'eye.shape': [
      [500, 'closed'],
      [620, 'auto'],
    ],
  },
  events: [[300, 'fx:question']],
}

clips.listen = {
  name: 'listen',
  duration: 1200,
  loop: true,
  layer: 'action',
  expression: 'surprised',
  tracks: {
    'head.turnY': [[0, -0.15]],
    'ear.L.rot': [[0, 10]],
    'ear.R.rot': [[0, 10]],
    ...pulseMap(),
  },
}

function pulseMap() {
  return {
    'head.y': [
      [0, 0],
      [200, 4, 'easeOutSine'],
      [400, 0, 'easeInOutSine'],
    ],
  }
}

clips.nod = {
  name: 'nod',
  duration: 900,
  loop: false,
  layer: 'action',
  expression: 'happy',
  tracks: {
    'head.turnY': [
      [0, 0],
      [220, 0.45, 'easeOutSine'],
      [440, 0, 'easeInOutSine'],
      [660, 0.45, 'easeOutSine'],
      [900, 0, 'easeInOutSine'],
    ],
    'head.y': [
      [0, 0],
      [220, 4, 'easeOutSine'],
      [440, 0],
      [660, 4, 'easeOutSine'],
      [900, 0],
    ],
    'eye.shape': [
      [0, 'smile'],
      [800, 'auto'],
    ],
  },
}

clips['shake-head'] = {
  name: 'shake-head',
  duration: 1000,
  loop: false,
  layer: 'action',
  expression: 'pout',
  tracks: {
    'head.turnX': [
      [0, 0],
      [250, -0.6, 'easeInOutSine'],
      [500, 0.6, 'easeInOutSine'],
      [750, -0.5, 'easeInOutSine'],
      [1000, 0, 'easeInOutSine'],
    ],
    'eye.shape': [
      [0, 'closed'],
      [900, 'auto'],
    ],
  },
}

clips.talk = {
  name: 'talk',
  duration: 1600,
  loop: true,
  layer: 'action',
  tracks: {
    'head.y': [
      [0, 0],
      [200, 2, 'easeOutSine'],
      [400, 0],
      [800, 2, 'easeOutSine'],
      [1000, 0],
    ],
    'arm.R.rot': [
      [1000, 0, 'easeOutBack'],
      [1200, -25, 'easeInOutSine'],
      [1600, 0, 'easeOutSine'],
    ],
  },
}

clips.think = {
  name: 'think',
  duration: 3000,
  loop: true,
  layer: 'action',
  expression: 'thinking',
  tracks: {
    'arm.R.slot': [[0, 'chin']],
    'head.tilt': [[0, 6, 'easeOutBack']],
    thirdEye: [
      [0, 0],
      [1200, 1, 'easeInOutSine'],
      [2600, 0.7],
      [3000, 1],
    ],
    'thirdEye.glow': [
      [1200, 0],
      [1800, 0.6, 'easeInOutSine'],
      [2400, 0.3, 'easeInOutSine'],
      [3000, 0.6],
    ],
  },
}

clips.pout = {
  name: 'pout',
  duration: 1800,
  loop: false,
  layer: 'action',
  expression: 'pout',
  tracks: {
    'head.turnX': [
      [0, 0],
      [300, -0.6, 'easeOutSine'],
      [1200, -0.6],
      [1800, 0, 'easeInOutSine'],
    ],
    'leg.R.lift': [
      [600, 0],
      [700, 10, 'easeOutSine'],
      [900, 0, 'easeInSine'],
    ],
    'body.squash': [
      [880, 0],
      [980, 0.1, 'easeOutSine'],
      [1100, 0],
    ],
  },
  events: [[900, 'fx:puff']],
}

clips.working = {
  name: 'working',
  duration: 1000,
  loop: true,
  layer: 'action',
  expression: 'determined',
  tracks: {
    'arm.L.slot': [[0, 'hold']],
    'arm.R.slot': [[0, 'hold']],
    'head.turnY': [
      [0, 0.25],
      [500, 0.3, 'easeInOutSine'],
      [1000, 0.25],
    ],
    thirdEye: [[0, 0.5]],
    'thirdEye.glow': [[0, 0.2]],
  },
}

clips.done = {
  name: 'done',
  duration: 1200,
  loop: false,
  layer: 'action',
  expression: 'starstruck',
  tracks: {
    'body.y': [
      [0, 0],
      [300, -20, 'easeOutCubic'],
      [600, 0, 'easeInSine'],
      [900, -10, 'easeOutCubic'],
      [1200, 0, 'easeInSine'],
    ],
    'arm.L.slot': [
      [200, 'up'],
      [1100, 'down'],
    ],
    'arm.R.slot': [
      [200, 'up'],
      [1100, 'down'],
    ],
  },
  events: [[300, 'fx:sparkle5']],
}

clips.error = {
  name: 'error',
  duration: 2000,
  loop: false,
  layer: 'action',
  expression: 'dizzy',
  tracks: {
    'arm.L.slot': [[0, 'head']],
    'arm.R.slot': [[0, 'head']],
    'head.tilt': [
      [0, 0],
      [400, -5, 'easeInOutSine'],
      [800, 5, 'easeInOutSine'],
      [1200, -4, 'easeInOutSine'],
      [1600, 0, 'easeInOutSine'],
    ],
    'body.squash': [
      [1700, 0],
      [1800, -0.1, 'easeOutSine'],
      [2000, 0],
    ],
  },
  events: [
    [100, 'fx:sweat'],
    [1750, 'fx:puff'],
  ],
}

clips.surprised = {
  name: 'surprised',
  duration: 1400,
  loop: false,
  layer: 'action',
  expression: 'surprised',
  tracks: {
    'body.y': [
      [0, 0],
      [120, -22, 'easeOutCubic'],
      [400, 0, 'easeInSine'],
    ],
    'arm.L.slot': [
      [0, 'up'],
      [400, 'down'],
    ],
    'arm.R.slot': [
      [0, 'up'],
      [400, 'down'],
    ],
  },
  events: [[0, 'fx:exclaim']],
}

clips.cry = {
  name: 'cry',
  duration: 2400,
  loop: false,
  layer: 'action',
  expression: 'teary',
  tracks: {
    'arm.R.slot': [
      [0, 'rub'],
      [800, 'down'],
      [1200, 'rub'],
      [2000, 'down'],
    ],
    'body.squash': [
      [0, 0],
      [600, 0.06, 'easeOutSine'],
      [700, 0],
      [1200, 0.06, 'easeOutSine'],
      [1300, 0],
      [1800, 0.06, 'easeOutSine'],
      [1900, 0],
    ],
  },
  events: [
    [300, 'fx:tear'],
    [1500, 'fx:tear'],
  ],
}

clips.sneeze = {
  name: 'sneeze',
  duration: 1600,
  loop: false,
  layer: 'action',
  expression: 'sleepy',
  tracks: {
    'head.turnY': [
      [0, 0],
      [600, -0.5, 'easeInOutSine'],
      [800, 0.5, 'easeOutBack'],
      [1100, 0.5],
      [1600, 0, 'easeInOutSine'],
    ],
    'head.tilt': [
      [0, 0],
      [600, -6, 'easeInOutSine'],
      [1600, 0],
    ],
    'eye.shape': [
      [0, 'squeeze'],
      [1000, 'auto'],
    ],
    'mouth.shape': [
      [0, 'small'],
      [750, 'o'],
      [1000, 'smile'],
    ],
    'body.squash': [
      [780, 0],
      [880, 0.25, 'easeOutSine'],
      [1100, 0],
    ],
  },
  events: [[850, 'fx:puff']],
}

clips['third-eye'] = {
  name: 'third-eye',
  duration: 2200,
  loop: false,
  layer: 'action',
  expression: 'thinking',
  tracks: {
    thirdEye: [
      [0, 0],
      [900, 1, 'easeInOutSine'],
      [1900, 1],
      [2200, 0, 'easeInOutSine'],
    ],
    'thirdEye.glow': [
      [700, 0],
      [1100, 0.8, 'easeInOutSine'],
      [1900, 0.8],
      [2200, 0],
    ],
    'eye.lookY': [[0, -1]],
    'mouth.shape': [
      [0, 'o'],
      [1800, 'smile'],
    ],
  },
  events: [[900, 'fx:beam']],
}

// --- locomotion (560 ms cycle) -----------------------------------------------
function walkTracks(direction) {
  const s = direction === 'left' ? -1 : 1
  return {
    'leg.L.rot': [
      [0, 16],
      [280, -16, 'easeInOutSine'],
      [560, 16, 'easeInOutSine'],
    ],
    'leg.R.rot': [
      [0, -16],
      [280, 16, 'easeInOutSine'],
      [560, -16, 'easeInOutSine'],
    ],
    'leg.L.lift': [
      [0, 0],
      [140, 6, 'easeOutSine'],
      [280, 0],
      [420, 0],
      [560, 0],
    ],
    'leg.R.lift': [
      [0, 0],
      [140, 0],
      [280, 0],
      [420, 6, 'easeOutSine'],
      [560, 0],
    ],
    'body.y': [
      [0, 0],
      [140, -5, 'easeOutSine'],
      [280, 0],
      [420, -5, 'easeOutSine'],
      [560, 0],
    ],
    'arm.L.rot': [
      [0, 10],
      [280, -10, 'easeInOutSine'],
      [560, 10, 'easeInOutSine'],
    ],
    'arm.R.rot': [
      [0, -10],
      [280, 10, 'easeInOutSine'],
      [560, -10, 'easeInOutSine'],
    ],
    'body.lean': [[0, 4 * s]],
    'head.turnX': [[0, 0.4 * s]],
    'tail.rot': [
      [0, -8 * s],
      [280, 8 * s, 'easeInOutSine'],
      [560, -8 * s, 'easeInOutSine'],
    ],
  }
}

clips.walk_right = {
  name: 'walk_right',
  duration: 560,
  loop: true,
  layer: 'action',
  tracks: walkTracks('right'),
}
clips.walk_left = {
  name: 'walk_left',
  duration: 560,
  loop: true,
  layer: 'action',
  tracks: walkTracks('left'),
}
clips.walk = { ...clips.walk_right, name: 'walk' }

clips.read = {
  name: 'read',
  duration: 3200,
  loop: true,
  layer: 'action',
  expression: 'determined',
  tracks: {
    'arm.L.slot': [[0, 'hold']],
    'arm.R.slot': [[0, 'hold']],
    'eye.lookX': [
      [0, -0.5, 'easeInOutSine'],
      [1500, 0.5, 'easeInOutSine'],
      [3100, -0.5, 'easeInOutSine'],
    ],
    'head.tilt': [[0, 6]],
  },
  events: [[2900, 'fx:sparkle1']],
}

clips.snack = {
  name: 'snack',
  duration: 3200,
  loop: false,
  layer: 'action',
  expression: 'happy',
  tracks: {
    'arm.L.slot': [[0, 'hold']],
    'arm.R.slot': [[0, 'hold']],
    'head.turnY': [
      [400, 0],
      [700, 0.3, 'easeOutSine'],
      [1000, 0.3],
      [1100, 0, 'easeInOutSine'],
      [1400, 0.3, 'easeOutSine'],
      [1700, 0.3],
      [1800, 0, 'easeInOutSine'],
      [2100, 0.3, 'easeOutSine'],
      [2400, 0.3],
      [2500, 0, 'easeInOutSine'],
    ],
    'mouth.shape': [
      [1000, 'puff'],
      [1400, 'puff'],
      [1800, 'puff'],
      [2600, 'smile'],
    ],
  },
}

// --- expressions.json (task book B4, 18 presets) ------------------------------
const expressions = [
  { name: 'neutral', params: {} },
  { name: 'happy', params: { 'eye.shape': 'smile', 'mouth.shape': 'smile' } },
  { name: 'laugh', params: { 'eye.shape': 'smile', 'mouth.shape': 'wide' } },
  { name: 'wink', params: { 'eye.shape': 'wink', 'mouth.shape': 'grin' } },
  { name: 'starstruck', params: { 'eye.shape': 'star', 'mouth.shape': 'wide' } },
  { name: 'surprised', params: { 'eye.shape': 'wide', 'mouth.shape': 'o' } },
  { name: 'confused', params: { 'eye.shape': 'auto', 'mouth.shape': 'flat' } },
  {
    name: 'thinking',
    params: { 'eye.shape': 'look-up', 'mouth.shape': 'cat', thirdEye: 1, 'thirdEye.glow': 0.6 },
  },
  { name: 'sleepy', params: { 'eye.shape': 'sleepy', 'mouth.shape': 'small' } },
  { name: 'sleeping', params: { 'eye.shape': 'closed', 'mouth.shape': 'small' } },
  { name: 'bored', params: { 'eye.shape': 'half', 'mouth.shape': 'flat' } },
  { name: 'pout', params: { 'eye.shape': 'auto', 'mouth.shape': 'pout', blush: 0.3 } },
  { name: 'angry', params: { 'eye.shape': 'focus', 'mouth.shape': 'puff' } },
  { name: 'shy', params: { 'eye.shape': 'auto', 'mouth.shape': 'smile', blush: 1 } },
  { name: 'teary', params: { 'eye.shape': 'teary', 'mouth.shape': 'wobbly' } },
  { name: 'smug', params: { 'eye.shape': 'half', 'mouth.shape': 'grin' } },
  { name: 'determined', params: { 'eye.shape': 'focus', 'mouth.shape': 'smile' } },
  { name: 'dizzy', params: { 'eye.shape': 'swirl', 'mouth.shape': 'wobbly' } },
]

// --- write everything ---------------------------------------------------------
for (const clip of Object.values(clips)) {
  fs.writeFileSync(path.join(clipDir, `${clip.name}.json`), `${JSON.stringify(clip, null, 1)}\n`)
}
fs.writeFileSync(
  path.join(outDir, 'expressions.json'),
  `${JSON.stringify({ expressions }, null, 1)}\n`,
)
console.log(
  `wrote ${Object.keys(clips).length} clips and ${expressions.length} expressions -> ${outDir}`,
)
