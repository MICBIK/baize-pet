// SPDX-License-Identifier: AGPL-3.0-only
// Generate A6 expression prompt files and batch jobs (task book A6): each
// job redraws the master with only the eyes or only the mouth changed.
// Head-region registration (A3) then extracts the eye/mouth patches.
// Outputs: tools/rig-pipeline/prompts/expressions/*.txt (committed)
//          demo/rig-art/expression-jobs.json (local)

const fs = require('node:fs')
const path = require('node:path')

const ROOT = '/Users/baihaibin/Documents/WorkSpares/BaiZe'
const PROMPT_DIR = path.join(ROOT, 'tools/rig-pipeline/prompts/expressions')
const JOBS = path.join(ROOT, 'demo/rig-art/expression-jobs.json')

const HEAD =
  'Redraw the reference image as the exact same character, same size, same position, same pose, same outline thickness and colours, identical in every detail EXCEPT the following change: '
const EYES_TAIL =
  ' Only the eyes change; the rest of the face, hair, hood and body stay pixel-identical. Transparent background (real alpha channel), no checkerboard, no text, no effects.'
const MOUTH_TAIL =
  ' Only the mouth changes; the rest of the face, hair, hood and body stay pixel-identical. Transparent background (real alpha channel), no checkerboard, no text, no effects.'

const EYES = [
  ['eye-half', 'the eyes are half closed, upper lids lowered halfway, relaxed'],
  ['eye-closed', 'the eyes are fully closed, drawn as two gentle downward arcs'],
  ['eye-smile', 'the eyes are closed in two happy upward arcs like ^ ^, smiling'],
  ['eye-squeeze', 'the eyes are squeezed shut in two >< shapes'],
  ['eye-wide', 'the eyes are wide open with small pupils, surprised'],
  ['eye-star', 'the eyes are big sparkling gold stars'],
  ['eye-heart', 'the eyes are big pink-red hearts'],
  ['eye-swirl', 'the eyes are dizzy spiral swirls'],
  ['eye-teary', 'the eyes are big and glossy with welling tears, shimmering'],
  ['eye-sleepy', 'the eyes are heavy-lidded and droopy, almost falling asleep'],
  ['eye-focus', 'the eyes are serious and determined, lids slightly pressed'],
  ['eye-lookup', 'the eyes look upward to the upper left, curious'],
]

const MOUTHS = [
  ['mouth-small', 'the mouth is a small open circle, talking a little'],
  ['mouth-mid', 'the mouth is a mid-size open oval, talking'],
  ['mouth-wide', 'the mouth is wide open laughing with a small tongue visible'],
  ['mouth-o', 'the mouth is a perfect round o of surprise'],
  ['mouth-cat', 'the mouth is a cute w-shaped cat mouth'],
  ['mouth-pout', 'the mouth is a small pout, lips pushed forward'],
  ['mouth-flat', 'the mouth is a flat straight line, unamused'],
  ['mouth-wobbly', 'the mouth is a wavy trembling line about to cry'],
  ['mouth-grin', 'the mouth is a smug lopsided grin'],
  ['mouth-puff', 'the cheeks are puffed out with the mouth pressed shut in a puffy sulk'],
]

const jobs = []
fs.mkdirSync(PROMPT_DIR, { recursive: true })
for (const [name, change] of EYES) {
  const file = path.join(PROMPT_DIR, `${name}.txt`)
  fs.writeFileSync(file, `${HEAD + change}.${EYES_TAIL}\n`)
  jobs.push({
    out: path.join('demo/rig-art/expressions', `${name}.png`),
    promptFile: path.relative(ROOT, file),
    refs: ['demo/rig-art/master.png'],
    size: '1024x1536',
  })
}
for (const [name, change] of MOUTHS) {
  const file = path.join(PROMPT_DIR, `${name}.txt`)
  fs.writeFileSync(file, `${HEAD + change}.${MOUTH_TAIL}\n`)
  jobs.push({
    out: path.join('demo/rig-art/expressions', `${name}.png`),
    promptFile: path.relative(ROOT, file),
    refs: ['demo/rig-art/master.png'],
    size: '1024x1536',
  })
}
fs.mkdirSync(path.dirname(JOBS), { recursive: true })
fs.writeFileSync(JOBS, `${JSON.stringify(jobs, null, 1)}\n`)
console.log(`wrote ${EYES.length + MOUTHS.length} expression jobs -> ${path.relative(ROOT, JOBS)}`)
