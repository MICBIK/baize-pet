#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Generates the placeholder character assets: transparent VP9 webm animations and the tray icon.
//
// Strategy: mainline ffmpeg cannot encode VP9 alpha, so frames are drawn twice with the
// `geq` filter (planar gbrap input, since geq only handles alpha on planar formats) and
// encoded as two VP9 streams: color and alpha (grayscale). mediabunny then muxes them
// into a single WebM with VP9 alpha (BlockAdditional + alpha_mode=1), which
// Chromium/Electron can play with transparency.
//
// Usage: scripts/generate-placeholder-animations.mjs [animations-dir] [assets-dir]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Output,
  WebMInputFormat,
  WebMOutputFormat,
} from 'mediabunny'

const outDir = resolve(process.argv[2] ?? 'characters/placeholder/animations')
const iconOut = resolve(process.argv[3] ?? 'assets')
const SIZE = 256
const FPS = 30
mkdirSync(outDir, { recursive: true })
mkdirSync(iconOut, { recursive: true })

// geq expressions are evaluated per pixel per frame; X/Y are pixel coords, T is seconds.
// Body center is (128,140); eyes sit at (104,116) and (152,116).
// NOTE: geq evaluates an expression once per scanline unless the expression references Y
// — the creature shapes therefore all use hypot(X-cx, Y-cy) point distances.

// idle_breath: 3s loop, body radius oscillates with a 2s period.
const idleBodyR = '(70+6*sin(2*PI*T/2))'
const idleEyeY = '(116-3*sin(2*PI*T/2))'
const idleEyes = `lt(hypot(X-104,Y-${idleEyeY}),10)+lt(hypot(X-152,Y-${idleEyeY}),10)`
const idleBody = `lt(hypot(X-128,Y-140),${idleBodyR})`
const idleColor =
  `r='if(${idleEyes},60,if(${idleBody},255,0))'` +
  `:g='if(${idleEyes},50,if(${idleBody},245,0))'` +
  `:b='if(${idleEyes},45,if(${idleBody},225,0))'`
const idleAlpha = `if(${idleEyes}+${idleBody},255,0)`

// click: 1s one-shot, body squashes and bounces, eyes narrow to slits.
const clickBodyR = '(70-16*sin(PI*T))'
const clickCy = '(140-12*sin(2*PI*T))'
const clickEyes =
  'lt((pow((X-104)/12,2)+pow((Y-116)/3,2)),1)+lt((pow((X-152)/12,2)+pow((Y-116)/3,2)),1)'
const clickBody = `lt(hypot(X-128,Y-${clickCy}),${clickBodyR})`
const clickColor =
  `r='if(${clickEyes},60,if(${clickBody},255,0))'` +
  `:g='if(${clickEyes},50,if(${clickBody},245,0))'` +
  `:b='if(${clickEyes},45,if(${clickBody},225,0))'`
const clickAlpha = `if(${clickEyes}+${clickBody},255,0)`

// drag: 1.5s loop, body sways horizontally, eyes lead the motion.
const dragCx = '(128+16*sin(2*PI*T/1.5))'
const dragEyeDx = '(7*cos(2*PI*T/1.5))'
const dragEyes = `lt(hypot(X-104-${dragEyeDx},Y-116),10)+lt(hypot(X-152-${dragEyeDx},Y-116),10)`
const dragBody = `lt(hypot(X-${dragCx},Y-140),70)`
const dragColor =
  `r='if(${dragEyes},60,if(${dragBody},255,0))'` +
  `:g='if(${dragEyes},50,if(${dragBody},245,0))'` +
  `:b='if(${dragEyes},45,if(${dragBody},225,0))'`
const dragAlpha = `if(${dragEyes}+${dragBody},255,0)`

// idle_look: 4s loop, body breathes gently while the eyes glance sideways
// (slow ease to one side, hold, ease back) — a curious "looking around" pose.
const lookBodyR = '(70+4*sin(2*PI*T/2))'
const lookEyeDx = '(9*sin(PI*T/2))'
const lookEyes = `lt(hypot(X-104-${lookEyeDx},Y-116),10)+lt(hypot(X-152-${lookEyeDx},Y-116),10)`
const lookBody = `lt(hypot(X-128,Y-140),${lookBodyR})`
const lookColor =
  `r='if(${lookEyes},60,if(${lookBody},255,0))'` +
  `:g='if(${lookEyes},50,if(${lookBody},245,0))'` +
  `:b='if(${lookEyes},45,if(${lookBody},225,0))'`
const lookAlpha = `if(${lookEyes}+${lookBody},255,0)`

// idle_wiggle: 2.5s loop, body does a small happy wiggle (squash & stretch in
// place, no translation) — used for upbeat spontaneous moments.
const wiggleBodyRx = '(70+5*sin(2*PI*T/1.25))'
const wiggleBodyRy = '(70-5*sin(2*PI*T/1.25))'
const wiggleBody = `lt(pow((X-128)/${wiggleBodyRx},2)+pow((Y-140)/${wiggleBodyRy},2),1)`
const wiggleEyes = 'lt(hypot(X-104,Y-116),10)+lt(hypot(X-152,Y-116),10)'
const wiggleColor =
  `r='if(${wiggleEyes},60,if(${wiggleBody},255,0))'` +
  `:g='if(${wiggleEyes},50,if(${wiggleBody},245,0))'` +
  `:b='if(${wiggleEyes},45,if(${wiggleBody},225,0))'`
const wiggleAlpha = `if(${wiggleEyes}+${wiggleBody},255,0)`

const ANIMATIONS = [
  { file: 'idle_breath.webm', duration: 3, color: idleColor, alpha: idleAlpha },
  { file: 'idle_look.webm', duration: 4, color: lookColor, alpha: lookAlpha },
  { file: 'idle_wiggle.webm', duration: 2.5, color: wiggleColor, alpha: wiggleAlpha },
  { file: 'click.webm', duration: 1, color: clickColor, alpha: clickAlpha },
  { file: 'drag.webm', duration: 1.5, color: dragColor, alpha: dragAlpha },
]

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

function encodeStreams(colorExpr, alphaExpr, duration, prefix) {
  // Color stream: warm-white creature; alpha plane is dropped on the yuv420p conversion.
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=black@0:s=${SIZE}x${SIZE}:d=${duration}:r=${FPS},format=gbrap`,
    '-vf',
    `geq=${colorExpr},format=yuv420p`,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '30',
    '-an',
    `${prefix}.color.webm`,
  ])
  // Alpha stream: the luminance plane carries the alpha mask.
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${SIZE}x${SIZE}:d=${duration}:r=${FPS},format=gray`,
    '-vf',
    `geq=lum='${alphaExpr}',format=yuv420p`,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '30',
    '-an',
    `${prefix}.alpha.webm`,
  ])
}

async function muxWithAlpha(colorPath, alphaPath, outPath) {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
  const videoSource = new EncodedVideoPacketSource('vp9')
  output.addVideoTrack(videoSource, { frameRate: FPS })
  await output.start()

  const colorInput = new Input({
    source: new BufferSource(readFileSync(colorPath)),
    formats: [new WebMInputFormat()],
  })
  const alphaInput = new Input({
    source: new BufferSource(readFileSync(alphaPath)),
    formats: [new WebMInputFormat()],
  })
  const colorTrack = await colorInput.getPrimaryVideoTrack()
  const alphaTrack = await alphaInput.getPrimaryVideoTrack()
  const colorSink = new EncodedPacketSink(colorTrack)
  const alphaSink = new EncodedPacketSink(alphaTrack)

  const alphaPackets = []
  for await (const packet of alphaSink.packets()) alphaPackets.push(packet)

  const decoderConfig = await colorTrack.getDecoderConfig()
  if (!decoderConfig) throw new Error('color stream decoder config not available')

  let frame = 0
  for await (const colorPkt of colorSink.packets()) {
    const alphaPkt = alphaPackets[frame]
    if (!alphaPkt) throw new Error(`alpha/color frame count mismatch at frame ${frame}`)
    const merged = new EncodedPacket(
      colorPkt.data,
      colorPkt.type,
      colorPkt.timestamp,
      colorPkt.duration,
      colorPkt.sequenceNumber,
      colorPkt.byteLength,
      { alpha: alphaPkt.data, alphaByteLength: alphaPkt.byteLength },
    )
    await videoSource.add(merged, { decoderConfig })
    frame++
  }
  await output.finalize()
  writeFileSync(outPath, Buffer.from(output.target.buffer))
  console.log(`generated ${outPath} (${frame} frames)`)
}

// Tray icon: the same creature frozen mid-breath, as a 64x64 PNG with alpha.
function generateTrayIcon(outPath) {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black@0:s=64x64:d=1:r=1,format=gbrap',
    '-vf',
    'geq=' +
      [
        "r='if(lt(hypot(X-26,Y-29),3),60,if(lt(hypot(X-38,Y-29),3),60,if(lt(hypot(X-32,Y-35),17.5),255,0)))'",
        "g='if(lt(hypot(X-26,Y-29),3),50,if(lt(hypot(X-38,Y-29),3),50,if(lt(hypot(X-32,Y-35),17.5),245,0)))'",
        "b='if(lt(hypot(X-26,Y-29),3),45,if(lt(hypot(X-38,Y-29),3),45,if(lt(hypot(X-32,Y-35),17.5),225,0)))'",
        "a='if(lt(hypot(X-26,Y-29),3)+lt(hypot(X-38,Y-29),3)+lt(hypot(X-32,Y-35),17.5),255,0)'",
      ].join(':') +
      ',format=rgba',
    '-frames:v',
    '1',
    outPath,
  ])
  console.log(`generated ${outPath}`)
}

for (const anim of ANIMATIONS) {
  const prefix = `${outDir}/.${anim.file}`
  encodeStreams(anim.color, anim.alpha, anim.duration, prefix)
  await muxWithAlpha(`${prefix}.color.webm`, `${prefix}.alpha.webm`, `${outDir}/${anim.file}`)
  // The two intermediate streams are not needed once merged.
  rmSync(`${prefix}.color.webm`, { force: true })
  rmSync(`${prefix}.alpha.webm`, { force: true })
}
generateTrayIcon(`${iconOut}/tray.png`)
