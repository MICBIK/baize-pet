// SPDX-License-Identifier: AGPL-3.0-only
// Generate the A2 variant prompt files and the gen-image batch job list.
// Each variant redraws the rig master with exactly one change (task book A2).
// Outputs:
//   tools/rig-pipeline/prompts/variants/<name>.txt   (committed, reproducible)
//   demo/rig-art/variant-jobs.json                   (local batch input)

const fs = require('node:fs')
const path = require('node:path')

const ROOT = '/Users/baihaibin/Documents/WorkSpares/BaiZe'
const PROMPT_DIR = path.join(ROOT, 'tools/rig-pipeline/prompts/variants')
const JOBS_FILE = path.join(ROOT, 'demo/rig-art/variant-jobs.json')

const HEAD =
  'Redraw the reference image as the exact same character, same size, same position, same pose, same outline thickness and colours, identical in every detail EXCEPT the following change: '
const TAIL =
  ' Transparent background (real alpha channel), no checkerboard, no text, no effects. Clone the reference image exactly: same head size, same body proportions, same face, same hairstyle, same hood shape, same line thickness, same flat colours, same size and position in the frame. Only the stated change may differ.'

const VARIANTS = [
  [
    'v-arms-behind',
    'both arms are hidden behind his back, so the whole front of the hoodie torso is fully visible',
  ],
  ['v-no-tail', 'the tail is removed'],
  [
    'v-arm-wave-R',
    "the arm on the viewer's right side (his left arm) is raised up beside his head with the sleeve open, as if waving hello; the other arm stays exactly as in the reference",
  ],
  ['v-arm-up-both', 'both arms are raised straight up in a cheer'],
  [
    'v-arm-chin-R',
    "the sleeve on the viewer's right side (his left arm) is raised to touch his chin, as if thinking; the other arm stays exactly as in the reference",
  ],
  [
    'v-arm-hold',
    'both sleeves are brought together in front of his chest, as if holding something small',
  ],
  [
    'v-arm-cover-R',
    "the sleeve on the viewer's right side (his left arm) covers the lower half of his face, shy; the other arm stays exactly as in the reference",
  ],
  [
    'v-arm-rub-R',
    "the sleeve on the viewer's right side (his left arm) rubs the eye on that side, sleepy or crying; the other arm stays exactly as in the reference",
  ],
  ['v-arm-head-both', 'both sleeves are placed on top of the hood, flustered'],
  ['v-arm-out-both', 'both arms are stretched out to the sides for balance'],
  [
    'v-third-eye-open',
    'the third eye on the hood forehead is fully OPEN, a round amber eye, glowing softly',
  ],
  ['v-third-eye-half', 'the third eye on the hood forehead is half open'],
]

// Two candidates per variant (add more later only where alignment fails).
const CANDIDATES_PER_VARIANT = 2

fs.mkdirSync(PROMPT_DIR, { recursive: true })
const jobs = []
for (const [name, change] of VARIANTS) {
  const prompt = HEAD + change + TAIL
  const promptFile = path.join(PROMPT_DIR, `${name}.txt`)
  fs.writeFileSync(promptFile, `${prompt}\n`)
  for (let i = 1; i <= CANDIDATES_PER_VARIANT; i++) {
    jobs.push({
      out: path.join('demo/rig-art/variants', `${name}-${i}.png`),
      promptFile: path.relative(ROOT, promptFile),
      // Master only: the original ref drags style/proportions away from the
      // chibi master (seen in the first batch's overlays).
      refs: ['demo/rig-art/master.png'],
      size: '1024x1536',
    })
  }
}
fs.writeFileSync(JOBS_FILE, `${JSON.stringify(jobs, null, 1)}\n`)
console.log(
  `wrote ${VARIANTS.length} prompts and ${jobs.length} jobs -> ${path.relative(ROOT, JOBS_FILE)}`,
)
