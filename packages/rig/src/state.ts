// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Action state machine (task book B3/D3/D4): one-shot actions with 150 ms
 * fades, next-chaining back to the emotion idle, the 3 s re-request guard,
 * and per-syllable lip-sync frames for onSay.
 */

import { evalClip, eventsBetween } from './clip.js'
import { mixLayers } from './mixer.js'
import type { RigParams } from './params.js'
import type { Clip } from './schema.js'

const FADE_MS = 150
const RE_REQUEST_GUARD_MS = 3000

interface ActiveAction {
  clip: Clip
  startMs: number
}

export interface StateMachineConfig {
  /** Action name of the idle loop (base layer), e.g. "idle". */
  baseIdle: string
  /** Emotion → idle action mapping (happy → idle-happy etc.). */
  emotionIdle: Record<string, string>
}

/** One mouth frame: open amount 0..1 at say-local time t (ms). */
export interface LipFrame {
  tMs: number
  open: number
}

export interface SayOptions {
  perCharMs?: number
  perWordMs?: number
  maxMs?: number
}

export class RigStateMachine {
  private readonly clips: Map<string, Clip>
  private readonly config: StateMachineConfig
  private emotion = 'neutral'
  /** Current base-layer idle override (task book D2 emotion idles). */
  private baseName: string | null = null
  private action: ActiveAction | null = null
  private actionPrevT = 0
  private lastRequest: { name: string; atMs: number } | null = null
  private expressionName: string | null = null
  private expressionParams: RigParams = {}
  private exprWeight = 0
  private sayFrames: LipFrame[] = []
  private sayStart = 0
  private sayActive = false

  constructor(clips: Clip[], config: StateMachineConfig) {
    this.clips = new Map(clips.map((c) => [c.name, c]))
    this.config = config
  }

  /** Current action name (the emotion idle when no action is active). */
  get currentActionName(): string {
    return this.action?.clip.name ?? this.baseName ?? this.idleName
  }

  /** The idle action for the current emotion. */
  get idleName(): string {
    return this.config.emotionIdle[this.emotion] ?? this.config.baseIdle
  }

  /** Active expression preset name, if any. */
  get activeExpression(): string | null {
    return this.expressionName
  }

  /** True while an action layer clip is playing. */
  get isBusy(): boolean {
    return this.action !== null
  }

  /** Switch emotion; drops back to the emotion idle. */
  setEmotion(emotion: string): void {
    this.emotion = emotion
    this.action = null
    this.lastRequest = null
  }

  /** Look up a clip by name. */
  hasClip(name: string): boolean {
    return this.clips.has(name)
  }

  /**
   * Request an action (task book D4): the same name within 3 s only resets
   * the expression instead of restarting the clip (anti-jitter guard).
   * Base-layer clips (emotion idles) switch the base loop instead of
   * stacking an action (task book D2).
   */
  request(name: string, nowMs: number): void {
    const clip = this.clips.get(name)
    if (!clip) return
    if (clip.layer === 'base') {
      if (this.baseName === name) return
      this.baseName = name
      this.action = null
      this.lastRequest = { name, atMs: nowMs }
      return
    }
    if (
      this.lastRequest &&
      this.lastRequest.name === name &&
      nowMs - this.lastRequest.atMs < RE_REQUEST_GUARD_MS
    ) {
      return
    }
    this.action = { clip, startMs: nowMs }
    this.actionPrevT = nowMs
    this.lastRequest = { name, atMs: nowMs }
  }

  /** Chain into a follow-up action when a clip declares next. */
  private finishAction(nowMs: number): void {
    const finished = this.action
    this.action = null
    if (!finished) return
    const next = finished.clip.next
    if (next) {
      this.request(next, nowMs)
    }
  }

  /** Activate an expression preset from the expressions table. */
  setExpression(entry: { name: string; params: RigParams } | null, _nowMs: number): void {
    this.expressionName = entry?.name ?? null
    this.expressionParams = entry?.params ?? {}
    this.exprWeight = 0 // ramps up in update() over 120 ms
  }

  /**
   * onSay (task book D3): build syllable frames and overlay the talk clip.
   * Chinese chars ~110 ms, English words 160 ms, capped at 4 s.
   */
  say(line: string, nowMs: number, opts: SayOptions = {}): void {
    this.sayFrames = buildLipFrames(line, opts)
    this.sayStart = nowMs
    this.sayActive = this.sayFrames.length > 0
    if (this.clips.has('talk')) this.request('talk', nowMs)
  }

  /** The per-frame parameter + event output of the state machine. */
  update(
    nowMs: number,
    dtMs: number,
    expressions: Map<string, RigParams>,
  ): { params: RigParams; events: string[] } {
    const events: string[] = []

    // Action layer: fade weight, next-chaining, events.
    let actionParams: RigParams = {}
    let actionWeight = 0
    if (this.action) {
      const t = nowMs - this.action.startMs
      actionParams = evalClip(this.action.clip, t)
      events.push(...eventsBetween(this.action.clip, this.actionPrevT - this.action.startMs, t))
      this.actionPrevT = nowMs
      actionWeight = Math.min(1, t / FADE_MS)
      if (!this.action.clip.loop && t >= this.action.clip.duration) {
        this.finishAction(nowMs)
        actionWeight = 0
      }
    }

    // Base layer: the emotion idle always runs.
    const idleClip = this.clips.get(this.baseName ?? this.idleName)
    const baseParams = idleClip ? evalClip(idleClip, nowMs) : {}

    // Expression: an action-declared preset shows while the action runs;
    // otherwise the user-set preset persists. 120 ms transition.
    const EXPR_MS = 120
    const name = this.action?.clip.expression ?? this.expressionName
    const exprParams = name ? (expressions.get(name) ?? this.expressionParams) : {}
    const exprTarget = name ? 1 : 0
    this.exprWeight += (exprTarget - this.exprWeight) * Math.min(1, dtMs / EXPR_MS)

    // Say sequence drives mouth.open while active (task book D3).
    const procedural: RigParams = {}
    if (this.sayActive) {
      const st = nowMs - this.sayStart
      let open = 0
      const frames = this.sayFrames
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]
        const n = frames[i + 1]
        if (f && st >= f.tMs && (!n || st < n.tMs)) open = f.open
      }
      const end = frames[frames.length - 1]?.tMs ?? 0
      if (st >= end) this.sayActive = false
      procedural['mouth.open'] = open
    }

    const params = mixLayers({
      base: baseParams,
      action: actionWeight > 0 ? { params: actionParams, weight: actionWeight } : undefined,
      expression:
        this.exprWeight > 0.001 ? { params: exprParams, weight: this.exprWeight } : undefined,
      procedural,
    })
    return { params, events }
  }
}

/**
 * Build mouth-open frames for a line (task book D3): Chinese chars ~110 ms,
 * English words 160 ms, cap 4 s; syllable levels 0.35/0.65/1.0 weighted
 * 4:3:1 with 30% closed gaps; punctuation closes for 200 ms.
 */
export function buildLipFrames(line: string, opts: SayOptions = {}): LipFrame[] {
  const perChar = opts.perCharMs ?? 110
  const perWord = opts.perWordMs ?? 160
  const maxMs = opts.maxMs ?? 4000
  const frames: LipFrame[] = []
  let t = 0

  // Split into units: CJK chars one by one, latin words as a whole.
  const units: Array<{ text: string; ms: number }> = []
  const re = /[\u4e00-\u9fff]|[A-Za-z0-9']+|[^\sA-Za-z0-9\u4e00-\u9fff]/g
  for (const m of line.match(re) ?? []) {
    const isLatin = /[A-Za-z0-9]/.test(m)
    const isCjk = /[\u4e00-\u9fff]/.test(m)
    units.push({ text: m, ms: isLatin ? perWord : isCjk ? perChar : 200 })
  }

  let seed = 12345
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  for (const u of units) {
    if (t >= maxMs) break
    if (/[0-9]/.test(u.text)) {
      frames.push({ tMs: t, open: 0.65 })
      frames.push({ tMs: t + u.ms, open: 0 })
      t += u.ms
      continue
    }
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(u.text)) {
      // Punctuation: closed mouth for 200 ms.
      frames.push({ tMs: t, open: 0 })
      frames.push({ tMs: t + 200, open: 0 })
      t += 200
      continue
    }
    const r = rng()
    if (r < 0.3) {
      frames.push({ tMs: t, open: 0 })
    } else {
      const rr = rng()
      const open = rr < 0.44 ? 0.35 : rr < 0.77 ? 0.65 : 1.0
      frames.push({ tMs: t, open })
    }
    frames.push({ tMs: t + u.ms, open: 0 })
    t += u.ms
  }
  return frames
}
